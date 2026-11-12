/**
 * Durable runs, for a function registered with `durable: true` in its metadata. The run takes an
 * epoch from the journal worker when it starts, and every call it makes is a step, numbered in
 * the order the code starts it. A step's intent is written before it goes out, and its result is
 * written before the code sees it. When the run starts again after a crash, a step that has a
 * result returns it without calling, so the code takes the same path up to where it stopped.
 *
 * The run's id is `_workflow_id` in the input, which the queue and the journal's recovery pass
 * back. When the journal refuses a write or stays unreachable, the run stops for good: every later
 * step throws, and so does the handler, whatever the code did with the error. The rules for code
 * that runs this way are in docs/durable-execution.md.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

export const WORKFLOW_FIELD = '_workflow_id'
// The engine adds this to a routed call's input, and it changes between executions.
const CALLER_FIELD = '_caller_worker_id'
const JOURNAL_CALL_TIMEOUT_MS = 5_000
const JOURNAL_WAIT_MS = Number(process.env.REWIND_JOURNAL_WAIT_MS ?? 30_000)
const METRICS_FILE = process.env.REWIND_DURABLE_METRICS

const runs = new AsyncLocalStorage()

/** A stop of the run itself, which is never saved as a step's outcome. DIVERGED also ends the run. */
class DurableStop extends Error {
  constructor(code, message) {
    super(message.startsWith(`${code}: `) ? message : `${code}: ${message}`)
    this.name = 'DurableStop'
    this.code = code
  }
}

function jsonCopy(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

/** The same for two inputs that are the same JSON, whatever order their keys were written in. */
export function inputHash(value) {
  return createHash('sha256').update(canonical(jsonCopy(value))).digest('hex').slice(0, 32)
}

function metric(line) {
  if (!METRICS_FILE) {
    return
  }

  try {
    appendFileSync(METRICS_FILE, `${JSON.stringify(line)}\n`)
  } catch {}
}

function storedError(error, InvocationError) {
  if (error instanceof InvocationError || error instanceof DurableStop) {
    const prefix = `${error.code}: `
    const message = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message
    return { code: error.code, message, function_id: error.function_id, stacktrace: error.stacktrace }
  }

  if (error instanceof Error) {
    return { name: error.name, message: error.message, stacktrace: error.stack }
  }

  return { name: 'Error', message: String(error) }
}

/** The error a saved outcome describes, built again so the code sees the same message as the first time. */
function rebuilt(stored, InvocationError) {
  if (stored.code !== undefined) {
    return new InvocationError(stored)
  }

  const error = new Error(stored.message)
  error.name = stored.name ?? 'Error'
  if (stored.stacktrace) {
    error.stack = stored.stacktrace
  }

  return error
}

/** Wraps a worker from registerWorker, so its durable functions keep a journal and its calls inside them are steps. */
export function durableWorker(worker, InvocationError) {
  const send = worker.call
  const register = worker.registerFunction

  function settle(outcome) {
    if (outcome.ok) {
      return outcome.value
    }

    throw rebuilt(outcome.error, InvocationError)
  }

  /** One journal call, sent again while the journal is unreachable, for at most JOURNAL_WAIT_MS. */
  async function journal(functionId, payload) {
    const deadline = Date.now() + JOURNAL_WAIT_MS
    for (let delay = 100; ; delay = Math.min(delay * 2, 1_000)) {
      let reply
      try {
        reply = await runs.exit(() => send({ function_id: functionId, payload, timeoutMs: JOURNAL_CALL_TIMEOUT_MS }))
      } catch (error) {
        if (Date.now() + delay > deadline) {
          throw new DurableStop('JOURNAL_UNAVAILABLE', `${functionId} failed for ${JOURNAL_WAIT_MS} ms, last with ${error.message}`)
        }

        await sleep(delay)
        continue
      }

      if (reply?.rejected) {
        throw new DurableStop(reply.rejected, reply.message)
      }

      return reply
    }
  }

  /** A journal call for a run in progress. A failure stops the run for good. */
  async function save(run, functionId, payload) {
    try {
      return await journal(functionId, payload)
    } catch (error) {
      run.stopped ??= error
      throw run.stopped
    }
  }

  async function step(run, request) {
    const n = run.next++
    if (run.stopped) {
      throw run.stopped
    }

    const hash = inputHash(request.payload)
    const saved = run.saved.get(n)
    if (saved && (saved.function_id !== request.function_id || saved.input_hash !== hash)) {
      const now = saved.function_id === request.function_id ? 'another input' : request.function_id
      run.stopped = new DurableStop('DIVERGED', `step ${n} of ${run.workflowId} was ${saved.function_id} and came back as ${now}`)
      throw run.stopped
    }

    if (saved?.outcome) {
      metric({ kind: 'step', workflow_id: run.workflowId, epoch: run.epoch, step: n, function_id: request.function_id, replayed: true })
      return settle(saved.outcome)
    }

    const began = performance.now()
    const intent = await save(run, 'journal::intent', { workflow_id: run.workflowId, epoch: run.epoch, step: n, function_id: request.function_id, input_hash: hash })
    if (intent.outcome) {
      return settle(intent.outcome)
    }

    const sent = performance.now()
    const metadata = intent.idempotency_key ? { ...request.metadata, idempotency_key: intent.idempotency_key } : request.metadata
    let outcome
    try {
      outcome = { ok: true, value: jsonCopy(await runs.exit(() => send({ ...request, metadata }))) }
    } catch (error) {
      outcome = { ok: false, error: storedError(error, InvocationError) }
    }

    const returned = performance.now()
    await save(run, 'journal::result', { workflow_id: run.workflowId, epoch: run.epoch, step: n, outcome })
    metric({
      kind: 'step',
      workflow_id: run.workflowId,
      epoch: run.epoch,
      step: n,
      function_id: request.function_id,
      again: saved !== undefined,
      journal_ms: sent - began + (performance.now() - returned),
      call_ms: returned - sent,
    })
    return settle(outcome)
  }

  /** What the run ends with in the journal: a stop that ends it, or what the code returned or threw. */
  function ending(stop, outcome) {
    if (stop) {
      return { ok: false, error: storedError(stop, InvocationError) }
    }

    if (outcome.ok) {
      return { ok: true, value: jsonCopy(outcome.value) }
    }

    return { ok: false, error: storedError(outcome.error, InvocationError) }
  }

  function durable(functionId, handler) {
    return async (input, metadata) => {
      const { [WORKFLOW_FIELD]: given, ...forHandler } = input ?? {}
      const { [CALLER_FIELD]: _caller, ...args } = forHandler
      const invocation = worker.currentInvocation()
      const workflowId = typeof given === 'string' ? given : `wf-${invocation?.invocation_id ?? randomUUID()}`
      const began = performance.now()
      const claim = await journal('journal::begin', {
        workflow_id: workflowId,
        function_id: functionId,
        input: args,
        input_hash: inputHash(args),
        started_by: invocation?.caller?.worker_name ?? null,
      })
      const beginMs = performance.now() - began
      if (claim.status === 'done') {
        return claim.output
      }

      if (claim.status === 'failed') {
        throw rebuilt(claim.error, InvocationError)
      }

      if (claim.status === 'paused') {
        const { step: at, function_id: lost } = claim.pause
        throw new DurableStop('PAUSED', `${workflowId} is paused at step ${at} (${lost}), which was in flight when its worker stopped; answer it with journal::answer`)
      }

      const run = { workflowId, epoch: claim.epoch, next: 0, saved: new Map(claim.steps.map((saved) => [saved.step, saved])), stopped: undefined }
      let outcome
      try {
        outcome = { ok: true, value: await runs.run(run, () => handler(forHandler, metadata)) }
      } catch (error) {
        outcome = { ok: false, error }
      }

      const stop = run.stopped
      if (stop && stop.code !== 'DIVERGED') {
        throw stop
      }

      const finishing = performance.now()
      await journal('journal::finish', { workflow_id: workflowId, epoch: run.epoch, outcome: ending(stop, outcome) })
      metric({ kind: 'run', workflow_id: workflowId, epoch: run.epoch, steps: run.next, journal_ms: beginMs + (performance.now() - finishing) })
      if (stop) {
        throw stop
      }

      if (!outcome.ok) {
        throw outcome.error
      }

      return outcome.value
    }
  }

  worker.registerFunction = (functionId, handler, options) => {
    if (options?.metadata?.durable === true && typeof handler === 'function') {
      return register(functionId, durable(functionId, handler), options)
    }

    return register(functionId, handler, options)
  }

  worker.call = (request) => {
    const run = runs.getStore()
    if (!run || request.observer !== undefined || request.function_id.startsWith('journal::')) {
      return send(request)
    }

    return step(run, request)
  }
  worker.trigger = worker.call
  return worker
}

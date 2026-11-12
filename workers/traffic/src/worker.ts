/**
 * Load for the scheduling agent. traffic::burst sends booking requests to
 * agent::run, one every interval_ms, without waiting for the previous one to
 * finish, and counts how they ended.
 *
 * Requests come from fixed lists of attendees, durations and weekdays, so a
 * burst of 60 covers every combination once. Each run's outcome is printed as
 * one JSON line, which is how the planted bugs get counted. Each run also gets
 * a workflow id, so a run the agent died under can be waited for in the
 * journal while it finishes on the restarted agent.
 *
 * Run: III_URL=ws://127.0.0.1:49334 node --import tsx src/worker.ts
 */
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { ROOT_CONTEXT, context } from '@opentelemetry/api'
import { CallAction, registerWorker } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49334'
const ATTENDEES = ['Dana', 'Priya', 'Marcus', 'Lena', 'Omar', 'Sofia']
const DURATIONS = [15, 30, 45, 60]
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const DEFAULT_COUNT = 20
const DEFAULT_INTERVAL_MS = 400
const RUN_QUEUE = 'agent-runs'
// A delivery the agent died under isn't a retry. A run that threw is, and throws again on every
// delivery, so a few retries cover one that gave up on the journal.
const RUN_QUEUE_CONFIG = { concurrency: 64, max_retries: 3, backoff_ms: 500, timeout_ms: 120_000 }
// How long a run may take to finish once the burst is waiting for it in the journal.
const SETTLE_MS = 180_000
// Long enough to outlast compose restarting the agent, which runs its pre_run install again.
const RETRY_FOR_MS = 30_000
const RETRY_AFTER_MS = 500
const MAX_RETRY_DELAY_MS = 4_000
// What a caller gets when the agent died under its call, was gone when it called, or never answered.
const STOPS = new Set(['invocation_stopped', 'function_not_found', 'TIMEOUT'])

type Start = 'call' | 'queue'
type BurstInput = { count?: number; interval_ms?: number; start?: Start; retry?: boolean; detail?: boolean }
type Outcome = 'booked' | 'failed' | 'errors' | 'paused'
type RunOutput = { status: string; reply: string; turns: number }
type RunReport = {
  index: number
  workflow_id: string
  request: string
  outcome: Outcome
  starts: number
  resumed: boolean
  elapsed_ms: number
  output?: RunOutput
  error?: unknown
}
type BurstOutput = Record<Outcome, number> & { sent: number; resumed: number; runs?: RunReport[] }
type Workflow = { status: 'running' | 'done' | 'failed' | 'paused'; output?: RunOutput; error?: unknown; pause?: unknown }

const worker = registerWorker(ENGINE_URL, { workerName: 'traffic' })

function bookingRequest(index: number): string {
  const minutes = DURATIONS[index % DURATIONS.length]
  const attendee = ATTENDEES[index % ATTENDEES.length]
  const weekday = WEEKDAYS[index % WEEKDAYS.length]
  return `Book ${minutes} minutes with ${attendee} next ${weekday} afternoon`
}

// The SDK puts the handler's own error message in `message` and the thrown
// error's class in the first line of `stacktrace`, which is where SyntaxError shows.
function describeError(error: unknown) {
  const { code, message, stacktrace } = error as { code?: string; message?: string; stacktrace?: string }
  return { code, message, thrown: stacktrace?.split('\n')[0] }
}

function stopped(error: unknown): boolean {
  return STOPS.has(String((error as { code?: unknown })?.code))
}

// The SDK takes the traceparent it sends from the active OpenTelemetry context.
// Calling from the root context makes each run the root of a trace of its own,
// the way a request from outside would arrive, instead of one trace per burst.
function callRun(payload: Record<string, unknown>): Promise<RunOutput> {
  return context.with(ROOT_CONTEXT, () => worker.call<typeof payload, RunOutput>({ function_id: 'agent::run', payload }))
}

function enqueueRun(payload: Record<string, unknown>): Promise<unknown> {
  return context.with(ROOT_CONTEXT, () => worker.call({ function_id: 'agent::run', payload, action: CallAction.Enqueue({ queue: RUN_QUEUE }) }))
}

/** Defines the run queue, which the queue worker keeps; defining it again with the same settings changes nothing. */
async function defineRunQueue(): Promise<void> {
  await worker.call({ function_id: 'queue::define', payload: { queue: RUN_QUEUE, config: RUN_QUEUE_CONFIG } })
}

async function journalRunning(): Promise<boolean> {
  const { functions } = await worker.call<unknown, { functions: { function_id: string }[] }>({ function_id: 'engine::functions::list', payload: { include_internal: true } })
  return functions.some((row) => row.function_id === 'journal::wait')
}

/**
 * The run as the journal has it once it stops running, or null when the journal never heard of
 * it. A queued run may not have started yet, so `untilKnown` keeps waiting for it to appear.
 */
async function settled(workflowId: string, untilKnown: boolean): Promise<Workflow | null> {
  const deadline = Date.now() + SETTLE_MS
  while (Date.now() < deadline) {
    try {
      const found = await worker.call<unknown, Workflow | null>({ function_id: 'journal::wait', payload: { workflow_id: workflowId, timeout_ms: 20_000 }, timeoutMs: 25_000 })
      if (found && found.status !== 'running') {
        return found
      }

      if (!found && !untilKnown) {
        return null
      }
    } catch {
      // The journal restarting, which the burst waits out the way the run does.
    }

    await sleep(RETRY_AFTER_MS)
  }

  return { status: 'running' }
}

const OUTCOME_OF: Record<Workflow['status'], (workflow: Workflow) => Outcome> = {
  done: (workflow) => (workflow.output?.status === 'booked' ? 'booked' : 'failed'),
  failed: () => 'errors',
  paused: () => 'paused',
  running: () => 'errors',
}

function fromJournal(report: RunReport, workflow: Workflow): RunReport {
  return { ...report, outcome: OUTCOME_OF[workflow.status](workflow), output: workflow.output, error: workflow.error ?? workflow.pause }
}

async function viaCall(report: RunReport, payload: Record<string, unknown>, retry: boolean, journal: boolean): Promise<RunReport> {
  const giveUpAt = Date.now() + RETRY_FOR_MS
  for (let delay = RETRY_AFTER_MS; ; delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS)) {
    report.starts += 1
    try {
      const output = await callRun(payload)
      return { ...report, outcome: output.status === 'booked' ? 'booked' : 'failed', output }
    } catch (error) {
      const found = journal && stopped(error) ? await settled(report.workflow_id, false) : null
      if (found) {
        return fromJournal({ ...report, resumed: true }, found)
      }

      if (!retry || !stopped(error) || Date.now() + delay > giveUpAt) {
        return { ...report, outcome: 'errors', error: describeError(error) }
      }

      await sleep(delay)
    }
  }
}

async function viaQueue(report: RunReport, payload: Record<string, unknown>): Promise<RunReport> {
  report.starts += 1
  try {
    await enqueueRun(payload)
  } catch (error) {
    return { ...report, outcome: 'errors', error: describeError(error) }
  }

  return fromJournal(report, (await settled(report.workflow_id, true))!)
}

async function runOne(index: number, burstId: string, input: BurstInput, journal: boolean): Promise<RunReport> {
  const request = bookingRequest(index)
  const workflowId = `${burstId}-${index}`
  const payload = { request, user: 'matt', _workflow_id: workflowId }
  const report: RunReport = { index, workflow_id: workflowId, request, outcome: 'errors', starts: 0, resumed: false, elapsed_ms: 0 }
  const began = Date.now()
  const done = input.start === 'queue' ? await viaQueue(report, payload) : await viaCall(report, payload, input.retry === true, journal)
  done.elapsed_ms = Date.now() - began
  console.log(JSON.stringify({ run: index, request, workflow_id: workflowId, outcome: done.outcome, starts: done.starts, resumed: done.resumed, ...done.output, error: done.error }))
  return done
}

async function burst(input: BurstInput): Promise<BurstOutput> {
  const count = input.count ?? DEFAULT_COUNT
  const intervalMs = input.interval_ms ?? DEFAULT_INTERVAL_MS
  const burstId = `burst-${randomUUID().slice(0, 8)}`
  const journal = await journalRunning()
  if (input.start === 'queue') {
    await defineRunQueue()
  }

  const runs: Promise<RunReport>[] = []
  for (let index = 0; index < count; index++) {
    if (index > 0) {
      await sleep(intervalMs)
    }

    runs.push(runOne(index, burstId, input, journal))
  }

  const reports = await Promise.all(runs)
  const tally: Record<Outcome, number> = { booked: 0, failed: 0, errors: 0, paused: 0 }
  for (const report of reports) {
    tally[report.outcome] += 1
  }

  const resumed = reports.filter((report) => report.resumed).length
  return { sent: count, ...tally, resumed, ...(input.detail ? { runs: reports } : {}) }
}

const runCount = (description: string) => ({ type: 'integer', minimum: 0, description })

worker.registerFunction('traffic::burst', burst, {
  description: 'Sends a burst of booking requests to agent::run and counts the outcomes',
  metadata: { effects: ['writes'] },
  request_format: {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 0, default: DEFAULT_COUNT, description: 'How many requests to send' },
      interval_ms: {
        type: 'integer',
        minimum: 0,
        default: DEFAULT_INTERVAL_MS,
        description: 'How long to wait between sending one request and the next, in milliseconds',
      },
      start: {
        type: 'string',
        enum: ['call', 'queue'],
        default: 'call',
        description: `How each run starts: a call to agent::run, or a job on the ${RUN_QUEUE} queue, which delivers it again if the agent dies`,
      },
      retry: { type: 'boolean', default: false, description: 'Call a run again, with the same workflow id, when its call stops and the journal never saw it' },
      detail: { type: 'boolean', default: false, description: 'Also return each run with its workflow id and outcome' },
    },
  },
  response_format: {
    type: 'object',
    properties: {
      sent: runCount('How many requests were sent'),
      booked: runCount('Runs that replied with status booked'),
      failed: runCount('Runs that replied with status failed'),
      errors: runCount('Runs that threw, or stopped and never finished'),
      paused: runCount('Durable runs waiting for a person, because a call that may have done its work was cut off'),
      resumed: runCount('Runs whose call stopped and that finished on a restarted agent'),
      runs: { type: 'array', description: 'Each run, when detail is true', items: { type: 'object' } },
    },
    required: ['sent', 'booked', 'failed', 'errors', 'paused', 'resumed'],
  },
})

console.log(`traffic ready on ${ENGINE_URL}`)

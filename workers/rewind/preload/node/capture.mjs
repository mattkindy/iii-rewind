/**
 * What every kind of capture shares: the mode, the iii invocation the work ran
 * in, and the capture file Rewind reads. Each capture is one JSON line with
 * { v, kind, id, name, worker, namespace, invocation_id, function_id,
 * trace_id, span_id, started_at_ms, duration_ms, input, output, error }.
 *
 * The Node SDK keeps the current invocation in an AsyncLocalStorage it does not
 * export, so trackInvocations wraps AsyncLocalStorage's `run` and remembers each
 * storage entered with an invocation, as the SDK does for every handler.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export const MODE = process.env.REWIND_CAPTURE ?? 'record'
export const WORKER = process.env.REWIND_WORKER_NAME ?? path.basename(process.cwd())
const NAMESPACE = process.env.III_NAMESPACE ?? 'default'

function isInvocation(store) {
  return typeof store?.invocation_id === 'string' && typeof store?.function_id === 'string'
}

const invocationStorages = new Set()
let tracking = false

export function trackInvocations() {
  if (tracking) {
    return
  }

  tracking = true
  const run = AsyncLocalStorage.prototype.run
  AsyncLocalStorage.prototype.run = function runAndRemember(store, ...rest) {
    if (isInvocation(store)) {
      invocationStorages.add(this)
    }

    return run.call(this, store, ...rest)
  }
}

function currentStore() {
  for (const storage of invocationStorages) {
    const store = storage.getStore()
    if (isInvocation(store)) {
      return store
    }
  }

  return undefined
}

/** The iii call running now, or undefined outside a handler. */
export function currentInvocation() {
  const store = currentStore()
  return store && { invocation_id: store.invocation_id, function_id: store.function_id }
}

/** The iii call running now and the call that made it, which Rewind uses to place a request a copy makes. */
export function currentCall() {
  const store = currentStore()
  return store && { invocation_id: store.invocation_id, caller_invocation_id: store.caller?.invocation_id ?? null }
}

function projectDir() {
  if (process.env.III_COMPOSE_DIR) {
    return process.env.III_COMPOSE_DIR
  }

  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'worker-compose.yaml'))) {
      return dir
    }

    if (path.dirname(dir) === dir) {
      return process.cwd()
    }
  }
}

let captureFile

function captureFilePath() {
  captureFile ??= process.env.REWIND_CAPTURE_FILE ?? path.join(projectDir(), 'data', 'captures.jsonl')
  return captureFile
}

/** The trace and span ids in a W3C traceparent header. */
export function traceOf(traceparent) {
  const [, traceId, spanId] = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec(String(traceparent ?? '')) ?? []
  return { trace_id: traceId ?? null, span_id: spanId ?? null }
}

// One synchronous append per capture keeps lines from two processes apart.
export function writeCapture(capture) {
  const line = JSON.stringify({ v: 1, id: randomUUID(), worker: WORKER, namespace: NAMESPACE, ...capture })
  const file = captureFilePath()
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${line}\n`)
  } catch (error) {
    process.stderr.write(`rewind preload: could not write ${file}: ${error.message}\n`)
  }
}

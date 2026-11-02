/**
 * Function spans for the functions someone asked to trace, named as
 * `<file>:<function>` with the file relative to the worker's folder. The list
 * comes from REWIND_TRACE_FUNCTIONS, comma separated, or else from
 * `trace_functions` in rewind.json in the worker's folder.
 *
 * Each call made inside an iii handler becomes a `function` capture with its
 * arguments, its result or error, and its timing, and an OpenTelemetry span in
 * the current context, so the ADE's Traces view puts it under the iii span.
 * A copy started by Rewind still makes the spans but writes no captures.
 */
import { existsSync, readFileSync } from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { MODE, currentInvocation, writeCapture } from './capture.mjs'
import { summarize } from './values.mjs'

const OTEL_API = Symbol.for('opentelemetry.js.api.1')
const SPAN_ERROR = 2

function configured() {
  if (process.env.REWIND_TRACE_FUNCTIONS) {
    return process.env.REWIND_TRACE_FUNCTIONS.split(',')
  }

  const file = path.join(process.cwd(), 'rewind.json')
  if (!existsSync(file)) {
    return []
  }

  return JSON.parse(readFileSync(file, 'utf8')).trace_functions ?? []
}

function targets() {
  return configured()
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes(':'))
    .map((id) => {
      const at = id.lastIndexOf(':')
      return { id, file: path.resolve(process.cwd(), id.slice(0, at)), name: id.slice(at + 1) }
    })
}

/** The iii SDK registers its tracer provider with the OpenTelemetry API, which keeps it on globalThis. */
function withSpan(name, attributes, work) {
  const tracer = globalThis[OTEL_API]?.trace?.getTracer?.('rewind')
  if (!tracer?.startActiveSpan) {
    return work(undefined)
  }

  return tracer.startActiveSpan(name, { attributes }, work)
}

function errorOf(error) {
  return { code: error?.name ?? 'Error', message: String(error?.message ?? error) }
}

function traceFunction(id, untraced) {
  const name = id.slice(id.lastIndexOf(':') + 1)
  const traced = function (...args) {
    const invocation = currentInvocation()
    if (!invocation) {
      return untraced.apply(this, args)
    }

    const startedAtMs = Date.now()
    const startedAt = performance.now()
    return withSpan(name, { 'code.function': name, 'rewind.function': id }, (span) => {
      const finish = (result, error) => {
        if (error !== undefined) {
          span?.recordException(error)
          span?.setStatus({ code: SPAN_ERROR, message: errorOf(error).message })
        }

        span?.end()
        if (MODE !== 'record') {
          return
        }

        const context = span?.spanContext()
        writeCapture({
          kind: 'function',
          name: `function ${id}`,
          ...invocation,
          trace_id: context?.traceId ?? null,
          span_id: context?.spanId ?? null,
          started_at_ms: startedAtMs,
          duration_ms: performance.now() - startedAt,
          input: { args: summarize(args) },
          output: error === undefined ? summarize(result) : null,
          error: error === undefined ? null : errorOf(error),
        })
      }

      let result
      try {
        result = untraced.apply(this, args)
      } catch (error) {
        finish(undefined, error)
        throw error
      }

      if (typeof result?.then !== 'function') {
        finish(result, undefined)
        return result
      }

      return result.then(
        (value) => {
          finish(value, undefined)
          return value
        },
        (error) => {
          finish(undefined, error)
          throw error
        },
      )
    })
  }
  Object.defineProperty(traced, 'name', { value: name })
  return traced
}

export function installSpans() {
  const wanted = targets()
  if (wanted.length === 0) {
    return
  }

  globalThis[Symbol.for('rewind.trace')] = traceFunction
  register('./hooks.mjs', import.meta.url, { data: { targets: wanted } })
}

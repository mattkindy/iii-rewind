/**
 * Requests arriving at the worker's own HTTP server, captured as `http_in`
 * through Node's diagnostics channels. Rewind treats each one as the root of a
 * run, and replays it by sending the recorded request to a copy of the worker.
 *
 * In a copy, every server listens on a port the system picks instead of the
 * one in its code, so it can run beside the live worker, and the preload
 * prints `REWIND_LISTENING <host>:<port>` for Rewind to send the request to.
 * The recorded request has REDACTED in place of each secret header, and the
 * copy removes those headers before its handler sees the request.
 */
import diagnostics from 'node:diagnostics_channel'
import http from 'node:http'
import { performance } from 'node:perf_hooks'
import { storedBody } from './body.mjs'
import { traceOf, writeCapture } from './capture.mjs'
import { REDACTED, recordedHeaders } from './headers.mjs'

function bytes(chunk, encoding) {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') {
    return Buffer.alloc(0)
  }

  return Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined)
}

/** Copies what the parser pushes into the request and what the handler writes, without changing either. */
function watch(request, response) {
  const received = storedBody()
  const sent = storedBody()
  const push = request.push
  request.push = function (chunk, encoding) {
    received.add(bytes(chunk, encoding))
    return push.call(this, chunk, encoding)
  }

  for (const method of ['write', 'end']) {
    const original = response[method]
    response[method] = function (chunk, encoding, ...rest) {
      sent.add(bytes(chunk, encoding))
      return original.call(this, chunk, encoding, ...rest)
    }
  }

  return { received, sent, startedAtMs: Date.now(), startedAt: performance.now() }
}

function capture(request, response, exchange) {
  const url = `http://${request.headers.host ?? 'localhost'}${request.url}`
  writeCapture({
    kind: 'http_in',
    name: `http_in ${request.method} ${url}`,
    invocation_id: null,
    function_id: null,
    ...traceOf(request.headers.traceparent),
    started_at_ms: exchange.startedAtMs,
    duration_ms: performance.now() - exchange.startedAt,
    input: { method: request.method, url, headers: recordedHeaders(request.headers), ...exchange.received.fields() },
    output: {
      status: response.statusCode,
      status_text: response.statusMessage ?? '',
      headers: recordedHeaders(response.getHeaders()),
      ...exchange.sent.fields(),
    },
    error: null,
  })
}

/** Takes out each header whose recorded value was hidden, before the handler reads any of them. */
export function removeRedacted(request) {
  const raw = request.rawHeaders
  for (let at = raw.length - 2; at >= 0; at -= 2) {
    if (raw[at + 1] === REDACTED) {
      delete request.headers[raw[at].toLowerCase()]
      raw.splice(at, 2)
    }
  }
}

function listenAnywhere() {
  const listen = http.Server.prototype.listen
  http.Server.prototype.listen = function (...args) {
    const [first] = args
    if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      args[0] = 0
    }

    if (first !== null && typeof first === 'object' && 'port' in first) {
      args[0] = { ...first, port: 0 }
    }

    this.once('listening', () => {
      const { address, port } = this.address()
      process.stdout.write(`REWIND_LISTENING ${address}:${port}\n`)
    })
    return listen.apply(this, args)
  }
}

export function installInbound(mode) {
  if (mode === 'replay') {
    listenAnywhere()
    diagnostics.subscribe('http.server.request.start', ({ request }) => removeRedacted(request))
    return
  }

  const exchanges = new WeakMap()
  diagnostics.subscribe('http.server.request.start', ({ request, response }) => {
    exchanges.set(response, watch(request, response))
  })
  diagnostics.subscribe('http.server.response.finish', ({ request, response }) => {
    const exchange = exchanges.get(response)
    if (exchange) {
      exchanges.delete(response)
      capture(request, response, exchange)
    }
  })
}

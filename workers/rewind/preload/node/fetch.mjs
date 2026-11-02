/**
 * The fetch hook. Node's fetch sends every request through undici's global
 * dispatcher, which lives on globalThis under a symbol, so this module puts its
 * own dispatcher there and keeps the original for the requests that go out.
 * The iii SDK wraps fetch to add traceparent and baggage, and its wrapper calls
 * the same fetch, so those requests come through here too.
 *
 * In record mode a fetch made inside an iii handler goes out as usual, and its
 * request and response become one capture. In replay mode every fetch goes to
 * Rewind instead, and the response Rewind returns is fed to fetch as if it came
 * off the wire. Clients built on node:http do not use the dispatcher.
 */
import { performance } from 'node:perf_hooks'
import { bodyBytes, bodyFields, storedBody } from './body.mjs'
import { WORKER, currentInvocation, traceOf, writeCapture } from './capture.mjs'
import { askedHeaders, recordedHeaders, withoutRedacted } from './headers.mjs'
import { askRewind } from './rewind.mjs'

const DISPATCHER = Symbol.for('undici.globalDispatcher.1')

function headerPairs(headers) {
  if (!headers) {
    return []
  }

  if (!Array.isArray(headers)) {
    return typeof headers[Symbol.iterator] === 'function' ? [...headers] : Object.entries(headers)
  }

  if (Array.isArray(headers[0])) {
    return headers
  }

  const pairs = []
  for (let i = 0; i < headers.length; i += 2) {
    pairs.push([headers[i], headers[i + 1]])
  }

  return pairs
}

/** Header names in lower case, with repeated headers joined the way fetch joins them. */
function headerObject(headers) {
  const out = {}
  for (const [name, value] of headerPairs(headers)) {
    const key = String(name).toLowerCase()
    const text = Buffer.isBuffer(value) ? value.toString('latin1') : String(value)
    out[key] = key in out ? `${out[key]}, ${text}` : text
  }

  return out
}

async function bodyOf(body) {
  if (body === null || body === undefined) {
    return Buffer.alloc(0)
  }

  if (typeof body === 'string' || body instanceof Uint8Array) {
    return Buffer.from(body)
  }

  const chunks = []
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

/**
 * The request as a capture stores it (`input`) and as a copy asks Rewind about it (`question`),
 * plus its bytes, which still go out whole, and its trace ids.
 */
export async function readRequest(options) {
  const headers = headerObject(options.headers)
  const bytes = await bodyOf(options.body)
  const request = { method: options.method.toUpperCase(), url: new URL(options.path, options.origin).href }
  const body = bodyFields(bytes)
  return {
    input: { ...request, headers: recordedHeaders(headers), ...body },
    question: { ...request, ...askedHeaders(headers), ...body },
    bytes,
    trace: traceOf(headers.traceparent),
  }
}

/** The handler with some of its callbacks wrapped. Everything else still reaches the original. */
function overriding(handler, overrides) {
  return new Proxy(handler, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        return overrides[property]
      }

      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function failure(error) {
  const cause = error?.cause?.message
  return { code: 'FETCH_FAILED', message: cause ? `${error.message}: ${cause}` : String(error?.message ?? error) }
}

async function record(original, options, handler) {
  const invocation = currentInvocation()
  if (!invocation) {
    original.dispatch(options, handler)
    return
  }

  const { input, bytes, trace } = await readRequest(options)
  const startedAtMs = Date.now()
  const startedAt = performance.now()
  const response = { status: 0, status_text: '', headers: {}, body: storedBody() }
  const finish = (error) =>
    writeCapture({
      kind: 'fetch',
      name: `fetch ${input.method} ${input.url}`,
      ...invocation,
      ...trace,
      started_at_ms: startedAtMs,
      duration_ms: performance.now() - startedAt,
      input,
      output: error ? null : { status: response.status, status_text: response.status_text, headers: response.headers, ...response.body.fields() },
      error: error ? failure(error) : null,
    })
  const watched = overriding(handler, {
    onHeaders(status, rawHeaders, resume, statusText) {
      Object.assign(response, { status, status_text: statusText ?? '', headers: recordedHeaders(headerObject(rawHeaders)) })
      return handler.onHeaders(status, rawHeaders, resume, statusText)
    },
    onData(chunk) {
      response.body.add(chunk)
      return handler.onData(chunk)
    },
    onComplete(trailers) {
      finish()
      return handler.onComplete(trailers)
    },
    onError(error) {
      finish(error)
      return handler.onError(error)
    },
  })
  const body = options.body === null || options.body === undefined ? options.body : bytes
  original.dispatch({ ...options, body }, watched)
}

/** Plays a response into the handler the way undici would after reading it from a socket. */
function deliver(handler, response) {
  const body = bodyBytes(response)
  const rawHeaders = Object.entries(withoutRedacted(response.headers)).flatMap(([name, value]) => [Buffer.from(name), Buffer.from(String(value))])
  handler.onHeaders(response.status, rawHeaders, () => {}, response.status_text ?? '')
  if (body.length > 0) {
    handler.onData(body)
  }

  handler.onComplete([])
}

async function replay(_original, options, handler) {
  let aborted = false
  handler.onConnect?.(() => {
    aborted = true
  })
  const { question } = await readRequest(options)
  const response = await askRewind({ kind: 'fetch', worker: WORKER, ...question })
  if (!aborted) {
    deliver(handler, response)
  }
}

const MODES = { record, replay }

export async function installFetchHook(mode) {
  const handle = MODES[mode]
  if (!handle) {
    process.stderr.write(`rewind preload: unknown REWIND_CAPTURE ${mode}, fetch is not hooked\n`)
    return
  }

  // undici loads on the first fetch, and only then sets its dispatcher.
  await (await fetch('data:,')).arrayBuffer()
  const original = globalThis[DISPATCHER]
  const dispatch = (options, handler) => {
    handle(original, options, handler).catch((error) => handler.onError(error))
    return true
  }
  globalThis[DISPATCHER] = overriding(original, { dispatch })
}

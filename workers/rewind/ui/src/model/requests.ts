/**
 * Requests that go around iii, such as the agent's fetch of the holidays API or
 * the email tool's POST to its provider. The core gives each one a function id
 * of its kind, method and URL: `fetch GET http://127.0.0.1:49335/holidays?…`.
 * The page shows a request by its method and a short form of the URL, under
 * the host it went to, which is outside iii and belongs to no worker. Bodies
 * are text, so a JSON body is parsed before anyone sees it, and JSON text never
 * shows inside JSON.
 */
import type { HttpRequest, HttpResponse } from '../client/types'

export type RequestId = { kind: 'fetch' | 'http_out'; method: string; url: string }

const REQUEST_ID = /^(fetch|http_out) ([A-Za-z]+) (\S+)$/

export function parseRequestId(functionId: string): RequestId | undefined {
  const match = REQUEST_ID.exec(functionId)
  return match ? { kind: match[1] as RequestId['kind'], method: match[2].toUpperCase(), url: match[3] } : undefined
}

export function isRequestId(functionId: string): boolean {
  return parseRequestId(functionId) !== undefined
}

function parsedUrl(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

export function hostOf(url: string): string {
  return parsedUrl(url)?.host ?? url
}

/** The host and path, without the scheme or the query, which the tooltip and inspector show in full. */
export function shortUrl(url: string): string {
  const parsed = parsedUrl(url)
  if (!parsed) {
    return url
  }

  const path = parsed.pathname === '/' ? '' : parsed.pathname
  return `${parsed.host}${path}${parsed.search ? '?…' : ''}`
}

/** "GET 127.0.0.1:49335/holidays?…" for a request, and the function id for anything else. */
export function callName(functionId: string): string {
  const request = parseRequestId(functionId)
  return request ? `${request.method} ${shortUrl(request.url)}` : functionId
}

/** The full URL, for a request's tooltip. */
export function callUrl(functionId: string): string | undefined {
  return parseRequestId(functionId)?.url
}

/** Who a call went to: its worker, or for a request the host, which no worker owns. */
export function participantOf(functionId: string, worker: string): { name: string; outside: boolean } {
  const request = parseRequestId(functionId)
  return request ? { name: hostOf(request.url), outside: true } : { name: worker, outside: false }
}

export function isResponse(value: unknown): value is HttpResponse {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  return typeof record?.status === 'number' && 'body' in record
}

function isRequestValue(value: unknown): value is HttpRequest {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  return typeof record?.method === 'string' && typeof record?.url === 'string'
}

/** A request whose body the preload cut, which Rewind never sends live. */
export function bodyWasCut(input: unknown): boolean {
  return isRequestValue(input) && input.body_truncated !== undefined
}

/** A body as a person reads it: parsed when it is JSON, a size when it is binary, and the text otherwise. */
export function readableBody(body: string | null | undefined, encoding?: string): unknown {
  if (body === null || body === undefined || body === '') {
    return null
  }

  if (encoding === 'base64') {
    return `${Math.floor((body.length * 3) / 4)} bytes (binary)`
  }

  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

/** A request or response with its body parsed; any other value as it is. */
export function readableValue(value: unknown): unknown {
  if (isResponse(value) || isRequestValue(value)) {
    const { body_encoding: encoding, ...rest } = value as { body?: string | null; body_encoding?: string }
    return { ...rest, body: readableBody(rest.body, encoding) }
  }

  return value
}

/**
 * The other way, for an answer someone edited as readable JSON: a response
 * body written as an object goes back to the text the code receives.
 */
export function withBodyAsText(value: unknown): unknown {
  const body = isResponse(value) ? (value as { body: unknown }).body : null
  if (body === null || typeof body === 'string') {
    return value
  }

  return { ...(value as object), body: JSON.stringify(body) }
}

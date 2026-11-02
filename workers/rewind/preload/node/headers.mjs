/**
 * Which headers Rewind keeps, and which values it hides. A capture keeps a
 * secret header's name with REDACTED as its value, so the page still shows
 * the request had one. A request a copy asks Rewind about leaves secret
 * headers out and lists their names, because Rewind may send that request
 * live, and it must never send REDACTED as a credential.
 *
 * REWIND_REDACT_HEADERS adds names to the list, comma separated.
 */
export const REDACTED = '[redacted]'

/** Headers the SDK's fetch wrapper adds, which differ on every run. */
export const TRACE_HEADERS = new Set(['traceparent', 'baggage'])

const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  ...(process.env.REWIND_REDACT_HEADERS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean),
])

// Services send API keys and tokens in headers of their own, such as x-api-key and x-goog-api-key.
const SECRET_WORDS = ['api-key', 'apikey', 'token', 'secret', 'password']

export function isSecretHeader(name) {
  const key = String(name).toLowerCase()
  return SECRET_HEADERS.has(key) || SECRET_WORDS.some((word) => key.includes(word))
}

function withoutTraceHeaders(headers) {
  return Object.entries(headers ?? {}).filter(([name]) => !TRACE_HEADERS.has(String(name).toLowerCase()))
}

/** Headers as a capture stores them: no trace headers, and REDACTED for each secret. */
export function recordedHeaders(headers) {
  return Object.fromEntries(withoutTraceHeaders(headers).map(([name, value]) => [name, isSecretHeader(name) ? REDACTED : value]))
}

/** Headers for a question to Rewind: no trace headers, no secrets, and the names of the secrets left out. */
export function askedHeaders(headers) {
  const kept = withoutTraceHeaders(headers)
  const redacted = kept.filter(([name]) => isSecretHeader(name)).map(([name]) => name)
  const fields = { headers: Object.fromEntries(kept.filter(([name]) => !isSecretHeader(name))) }
  return redacted.length > 0 ? { ...fields, redacted_headers: redacted } : fields
}

/** Recorded headers without the ones whose value was hidden, so nothing receives REDACTED as a value. */
export function withoutRedacted(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([, value]) => value !== REDACTED))
}

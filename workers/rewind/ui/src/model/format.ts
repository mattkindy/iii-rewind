/**
 * Turning values into the page's short text: times, durations, ids, JSON
 * previews, the request in a person's words, and error messages without the
 * codes the SDKs put in front of them. Error classes matter because the SDKs
 * pass a thrown error's message on but not its class, so a message such as
 * "SyntaxError: Unexpected end of JSON input" is the only place the class
 * shows, and the page shows it on its own.
 */
import { formatDuration, formatRelative } from '@iii-dev/console-ui/format'

/** `6h ago`, or `just now`. */
export function ago(ms: number): string {
  const relative = formatRelative(ms)
  return relative === 'just now' ? relative : `${relative} ago`
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i

/** Invocation ids are UUIDs; the first eight characters tell runs apart on screen. */
export function shortId(id: string): string {
  return UUID_LIKE.test(id) ? id.slice(0, 8) : id
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function dayAndTime(ms: number): string {
  const date = new Date(ms)
  const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `${day}, ${clockTime(ms)}`
}

export function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) {
    return ''
  }

  return formatDuration(Math.round(ms))
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** One line of JSON for previews; keys keep their order. */
export function compactJson(value: unknown, max = 72): string {
  const text = JSON.stringify(value)
  return truncate(text === undefined ? 'undefined' : text, max)
}

export function prettyJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  return text === undefined ? 'null' : text
}

const REQUEST_KEYS = ['request', 'prompt', 'message', 'text', 'query']

/** What a person asked for, in their words when the entry input has a field for it. */
export function requestText(input: unknown): string {
  if (typeof input === 'string') {
    return input
  }

  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const key = REQUEST_KEYS.find((k) => typeof record[k] === 'string')
  return key ? String(record[key]) : compactJson(input, 120)
}

const ERROR_CLASS = /^([A-Z][A-Za-z]*(?:Error|Exception))\b/
// `invocation_failed: ` or `TIMEOUT: `, which the SDKs put before a message.
const CODE_PREFIX = /^(?:[a-z][a-z_]*|[A-Z][A-Z_]{2,}):\s*/
const LEADING_LABEL = /^(?:[a-z][a-z_]*|[A-Z][A-Z_]{2,}|[A-Z][A-Za-z]*(?:Error|Exception)):\s*/

export function withoutCode(message: string): string {
  return message.trim().replace(CODE_PREFIX, '')
}

/** `SyntaxError` from `SyntaxError: Unexpected end of JSON input`, when the message starts with a class. */
export function errorClass(message: string): string | undefined {
  return ERROR_CLASS.exec(withoutCode(message))?.[1]
}

/** The message without leading codes and class names, which the page shows on their own. */
export function errorDetail(message: string): string {
  let text = message.trim()
  while (LEADING_LABEL.test(text)) {
    text = text.replace(LEADING_LABEL, '')
  }

  return text
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

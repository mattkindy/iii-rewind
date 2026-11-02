/**
 * Arguments and results as JSON Rewind can store. A value JSON can't hold is
 * described instead, and anything longer than MAX_CHARS once written out is
 * cut to a preview, so one large argument never makes a capture huge.
 */
const MAX_CHARS = 4_000

function replacer() {
  const seen = new WeakSet()
  return (_key, value) => {
    if (typeof value === 'bigint') {
      return `${value}n`
    }

    if (typeof value === 'function') {
      return `[function ${value.name || 'anonymous'}]`
    }

    if (typeof value === 'symbol') {
      return value.toString()
    }

    if (value instanceof Error) {
      return { $error: value.name, message: value.message }
    }

    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) {
        return '[circular]'
      }

      seen.add(value)
    }

    return value
  }
}

export function summarize(value) {
  let text
  try {
    text = JSON.stringify(value, replacer())
  } catch (error) {
    return { $unserializable: value?.constructor?.name ?? typeof value, reason: error.message }
  }

  if (text === undefined) {
    return { $type: typeof value }
  }

  if (text.length > MAX_CHARS) {
    return { $truncated: text.length, preview: text.slice(0, MAX_CHARS) }
  }

  return JSON.parse(text)
}

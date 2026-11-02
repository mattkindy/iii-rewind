/**
 * Bodies as a capture stores them: text, or base64 with `body_encoding` when
 * the bytes are not UTF-8. A body longer than REWIND_MAX_BODY_BYTES (64 KiB
 * by default) keeps its first bytes, and `body_truncated` gives the full
 * length and a SHA-256 of the whole body. Rewind matches requests on the
 * stored body, so a copy cuts the body of a request it asks about the same
 * way, and it matches the recording.
 */
import { createHash } from 'node:crypto'

const DEFAULT_MAX_BODY_BYTES = 64 * 1024

function maxBodyBytes() {
  const configured = Number(process.env.REWIND_MAX_BODY_BYTES)
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_BODY_BYTES
}

export const MAX_BODY_BYTES = maxBodyBytes()

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

function textOf(bytes) {
  try {
    return strictUtf8.decode(bytes)
  } catch {
    return undefined
  }
}

function encoded(bytes) {
  const text = textOf(bytes)
  if (text !== undefined) {
    return { body: text }
  }

  return { body: Buffer.from(bytes).toString('base64'), body_encoding: 'base64' }
}

// A cut can land inside a character of up to four bytes, so it may need to move back three.
function encodedPrefix(bytes) {
  for (let drop = 0; drop <= 3 && drop < bytes.length; drop += 1) {
    const text = textOf(bytes.subarray(0, bytes.length - drop))
    if (text !== undefined) {
      return { body: text }
    }
  }

  return encoded(bytes)
}

/** A body read in chunks. It keeps the bytes up to the cap, and counts and hashes all of them. */
export function storedBody() {
  const kept = []
  const hash = createHash('sha256')
  let keptBytes = 0
  let totalBytes = 0
  let digest
  return {
    add(chunk) {
      const bytes = Buffer.from(chunk)
      totalBytes += bytes.length
      hash.update(bytes)
      const room = MAX_BODY_BYTES - keptBytes
      if (room > 0) {
        kept.push(bytes.subarray(0, room))
        keptBytes += Math.min(room, bytes.length)
      }
    },
    fields() {
      if (totalBytes === 0) {
        return { body: null }
      }

      if (totalBytes <= MAX_BODY_BYTES) {
        return encoded(Buffer.concat(kept))
      }

      digest ??= hash.digest('hex')
      return { ...encodedPrefix(Buffer.concat(kept)), body_truncated: { bytes: totalBytes, sha256: digest } }
    },
  }
}

export function bodyFields(bytes) {
  const body = storedBody()
  if (bytes) {
    body.add(bytes)
  }

  return body.fields()
}

export function bodyBytes({ body, body_encoding: encoding }) {
  if (body === null || body === undefined) {
    return Buffer.alloc(0)
  }

  return Buffer.from(body, encoding === 'base64' ? 'base64' : 'utf8')
}

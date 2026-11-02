/**
 * The request and response formats the sample app registers, read from the
 * JSON blocks under each function in docs/contract.md, so the mock reports the
 * same schemas the app does. Keys come back in alphabetical order, as
 * `engine::functions::info` returns them.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JsonSchema } from '../src/model/schema'

export type Formats = { request_format?: JsonSchema; response_format?: JsonSchema }

const CONTRACT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/contract.md')

const HEADING = /^### `([^`]+)`/
const BLOCK = /^(Request|Response) format:\s*\n+```json\n([\s\S]*?)\n```/m

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedKeys)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])]),
  )
}

/** Each function's formats by function id. */
export function contractFormats(): Record<string, Formats> {
  const sections = readFileSync(CONTRACT, 'utf8').split(/\n(?=### )/)
  const out: Record<string, Formats> = {}
  for (const section of sections) {
    const id = HEADING.exec(section)?.[1]
    if (!id) {
      continue
    }

    let rest = section
    for (let match = BLOCK.exec(rest); match; match = BLOCK.exec(rest)) {
      const key = match[1] === 'Request' ? 'request_format' : 'response_format'
      out[id] = { ...out[id], [key]: sortedKeys(JSON.parse(match[2])) as JsonSchema }
      rest = rest.slice((match.index ?? 0) + match[0].length)
    }
  }

  return out
}

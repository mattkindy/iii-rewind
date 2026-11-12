/**
 * What a failed saved test says about the call where the code left the test's file behind. A
 * test gives each call the answer the file has at its place only when the call sends the input
 * the file saved, so a change in the code shows up as one call: one that sent another input, one
 * the file has no answer for, or one where the file has another function. For another input, each
 * field that changed comes with the value the test saved and the one the code sent.
 *
 * The core gives each field as a JSON pointer, such as `/messages/1/result`. The page writes it
 * the way schema problems do, `messages[1].result`, and reads the inputs to tell a list's index
 * from an object's key, since a pointer writes both the same way.
 */
import type { InputDifference, TestDiverged } from '../client/types'
import { compactJson, plural, prettyJson } from './format'
import { callName } from './requests'

/** How the run left the file: another input to the same function, a call the file lacks, or another function. */
export type DivergenceKind = 'input' | 'new-call' | 'other-call'

/** One side of a field, short enough for one line, and the whole value for its tooltip. Null when that side has no such field. */
export type ShownValue = { short: string; full: string } | null

/** `field` is empty when the whole input differs, as when one side isn't an object. */
export type FieldChange = { field: string; saved: ShownValue; sent: ShownValue }

export type Divergence = {
  kind: DivergenceKind
  /** "Diverged at call 3 · model::complete" */
  headline: string
  /** What happened at that call, in a few words. */
  detail: string
  fields: FieldChange[]
}

/** How many fields show before the rest fold behind a button. */
export const FIELDS_SHOWN = 4

const SHORT_VALUE = 56

function kindOf(diverged: TestDiverged): DivergenceKind {
  if (!diverged.saved) {
    return 'new-call'
  }

  if (diverged.saved.function_id !== diverged.function_id) {
    return 'other-call'
  }

  return 'input'
}

const DETAIL: Record<DivergenceKind, (diverged: TestDiverged, fields: number) => string> = {
  input: (_, fields) => (fields > 0 ? `Sent another input · ${plural(fields, 'field')} changed` : 'Sent another input'),
  'new-call': () => 'New call · the test has none here',
  'other-call': (diverged) => `The test has ${callName(diverged.saved?.function_id ?? '')} here`,
}

// A pointer escapes `/` as `~1` and `~` as `~0`.
function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

function isContainer(value: unknown): value is object {
  return value !== null && typeof value === 'object'
}

function child(value: unknown, token: string): unknown {
  return isContainer(value) ? (value as Record<string, unknown>)[token] : undefined
}

function withToken(label: string, token: string, container: unknown): string {
  if (Array.isArray(container)) {
    return `${label}[${token}]`
  }

  return label ? `${label}.${token}` : token
}

/**
 * `messages[1].result` from `/messages/1/result`. Each step reads whichever input has something
 * there, the one the code sent first, so a field only one side has still gets a label.
 */
export function fieldLabel(pointer: string, sent: unknown, saved: unknown): string {
  if (pointer === '') {
    return ''
  }

  let label = ''
  let inSent = sent
  let inSaved = saved
  for (const token of pointer.slice(1).split('/').map(unescapeToken)) {
    label = withToken(label, token, isContainer(inSent) ? inSent : inSaved)
    inSent = child(inSent, token)
    inSaved = child(inSaved, token)
  }

  return label
}

function shown(value: unknown): ShownValue {
  if (value === undefined) {
    return null
  }

  return { short: compactJson(value, SHORT_VALUE), full: prettyJson(value) }
}

function fieldChange(difference: InputDifference, sent: unknown, saved: unknown): FieldChange {
  return { field: fieldLabel(difference.field, sent, saved), saved: shown(difference.saved), sent: shown(difference.sent) }
}

/** What the page shows for a test that diverged. Calls count from 1, as the run view counts them. */
export function divergence(diverged: TestDiverged): Divergence {
  const kind = kindOf(diverged)
  const fields = kind === 'input' ? diverged.differences.map((d) => fieldChange(d, diverged.input, diverged.saved?.input)) : []
  return {
    kind,
    headline: `Diverged at call ${diverged.seq + 1} · ${callName(diverged.function_id)}`,
    detail: DETAIL[kind](diverged, fields.length),
    fields,
  }
}

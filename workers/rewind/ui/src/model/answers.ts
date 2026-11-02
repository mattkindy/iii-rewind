/**
 * Reading, summarizing and editing one call's answer.
 *
 * An answer is `{ value }` or `{ error }`. The editor shows a value as itself,
 * because that is what a person wants to change, and an error as
 * `{ "error": { ... } }`. A response to a request shows its body parsed, so no
 * JSON text sits inside the JSON. Parsing goes the other way: an object whose
 * only key is `error`, holding an object with a string `message`, is an error
 * answer, a response's body goes back to text, and anything else is a value.
 */
import type { Answer, ErrorValue, HttpResponse } from '../client/types'
import { compactJson, errorClass, errorDetail, prettyJson, truncate } from './format'
import { isResponse, readableBody, readableValue, withBodyAsText } from './requests'
import { type AnswerCheck, answerProblems, isPlainObject, jsonStop, lostFields, type Problem, schemaAt, textOnly } from './schema'

export function isError(answer: Answer): answer is { error: ErrorValue } {
  return 'error' in answer
}

export function answerText(answer: Answer): string {
  return isError(answer) ? prettyJson({ error: answer.error }) : prettyJson(readableValue(answer.value))
}

export type ParsedAnswer = { ok: true; answer: Answer } | { ok: false; message: string }

/**
 * The text a person edited, read back into an answer. `{ "error": { "message"
 * } }` alone is an error, and anything else is a value, with a response body
 * written as an object turned back into the text the code receives.
 */
export function parseAnswerText(text: string): ParsedAnswer {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }

  const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : []
  const error = (parsed as { error?: { message?: unknown } } | null)?.error
  if (keys.length === 1 && keys[0] === 'error' && typeof error?.message === 'string') {
    return { ok: true, answer: { error: error as ErrorValue } }
  }

  return { ok: true, answer: { value: withBodyAsText(parsed) } }
}

export type ParsedTyped = { ok: true; value: unknown } | { ok: false; message: string }

/**
 * A typed answer the way `rewind::answer` takes it: the raw JSON the call
 * returns, read the same way as an edited answer, and not wrapped in
 * `{ value }`. Text that reads as an error goes back as that same object.
 */
export function parseTypedText(text: string): ParsedTyped {
  const parsed = parseAnswerText(text)
  if (!parsed.ok) {
    return parsed
  }

  return { ok: true, value: isError(parsed.answer) ? { error: parsed.answer.error } : parsed.answer.value }
}

/** An edited answer as the editor reads it: whether it parses, whether it differs from the recording, and how it breaks the function's schema. */
export type DraftState = { parsed: ParsedAnswer; normalized: string; changed: boolean; problems: Problem[]; ready: boolean }

/**
 * Whether the text is ready to fork with: valid JSON, and changed. An answer that breaks the
 * function's schema can still be forked, because seeing how the code handles one is a reason to fork.
 */
export function draftState(recorded: Answer, text: string, check?: AnswerCheck): DraftState {
  const parsed = parseAnswerText(text)
  const normalized = parsed.ok ? answerText(parsed.answer) : text
  const changed = parsed.ok && normalized !== answerText(recorded)
  const problems = parsed.ok && check && !isError(parsed.answer) ? answerProblems(parsed.answer.value, check) : []
  return { parsed, normalized, changed, problems, ready: parsed.ok && changed }
}

// The SDKs pass an error's message on but not its class. These messages read
// the same in every recording, so they map back to the class a developer knows.
const KNOWN_CLASSES: { match: RegExp; name: string }[] = [
  { match: /\bJSON\b|^Unexpected (token|end of input)/, name: 'SyntaxError' },
  { match: /^unsupported (operand )?type|^can only concatenate|not supported between instances|object is not (callable|subscriptable|iterable)/, name: 'TypeError' },
  { match: /^Cannot read propert(y|ies) of|is not a function$|is not iterable$/, name: 'TypeError' },
  { match: /is not defined$/, name: 'ReferenceError' },
  // Python's KeyError message is the missing key in quotes and nothing else.
  { match: /^'[^']+'$/, name: 'KeyError' },
]

// The code every SDK uses for an ordinary thrown error says nothing on its own.
const GENERIC_CODES = ['invocation_failed']

/** A short name for an error, or undefined when nothing better than "an error" is known. */
export function errorName(error: ErrorValue): string | undefined {
  const message = errorDetail(error.message)
  const known = errorClass(error.message) ?? KNOWN_CLASSES.find((k) => k.match.test(message))?.name
  if (known) {
    return known
  }

  return error.code && !GENERIC_CODES.includes(error.code) ? error.code : undefined
}

export function errorLabel(error: ErrorValue): string {
  return errorName(error) ?? 'an error'
}

type Shape = { test: (value: Record<string, unknown>) => boolean; say: (value: Record<string, unknown>) => string }

const timeOf = (iso: unknown) => String(iso).slice(11, 16)
const dayOf = (iso: unknown) => String(iso).slice(0, 10)

// Common answer shapes, most specific first. They are about shapes, not about
// one app's functions, so an unknown answer falls through to compact JSON.
const SHAPES: Shape[] = [
  { test: isResponse, say: (v) => responseSummary(v as HttpResponse) },
  {
    test: (v) => typeof (v.tool_call as { name?: unknown } | undefined)?.name === 'string',
    say: (v) => {
      const call = v.tool_call as { name: string; args?: unknown }
      return `Calls ${call.name}${typeof call.args === 'string' ? ' · args as string' : ''}`
    },
  },
  { test: (v) => typeof v.text === 'string', say: (v) => `Says “${truncate(String(v.text), 64)}”` },
  { test: (v) => typeof v.now === 'string', say: (v) => String(v.now).replace('T', ' ').slice(0, 19) },
  {
    test: (v) => typeof v.start === 'string' && typeof v.end === 'string',
    say: (v) => `${dayOf(v.start)}, ${timeOf(v.start)} to ${timeOf(v.end)}`,
  },
  {
    test: (v) => typeof v.status === 'string',
    say: (v) => (typeof v.id === 'string' ? `${v.status} ${v.id}` : String(v.status)),
  },
]

export function summarizeValue(value: unknown, otherwise: (value: unknown) => string = (v) => compactJson(v, 64)): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const shape = SHAPES.find((s) => s.test(record))
    return shape ? shape.say(record) : otherwise(value)
  }

  return otherwise(value)
}

const FIELDS_SHOWN = 3

/** A few of an object's fields in words, as in "from 2026-11-02, to 2026-11-15, holidays (2)". */
function fieldsInWords(value: unknown): string {
  if (Array.isArray(value)) {
    return `list of ${value.length}`
  }

  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? `“${truncate(value, 64)}”` : compactJson(value, 64)
  }

  const words = Object.entries(value as Record<string, unknown>).flatMap(([key, field]) => {
    if (Array.isArray(field)) {
      return [`${key} (${field.length})`]
    }

    return field === null || typeof field !== 'object' ? [`${key} ${truncate(String(field), 32)}`] : []
  })
  return words.slice(0, FIELDS_SHOWN).join(', ') || compactJson(value, 64)
}

/** "200 OK · accepted msg_1a2b", the status and a few words about the body. */
export function responseSummary(response: HttpResponse): string {
  const status = `${response.status}${response.status_text ? ` ${response.status_text}` : ''}`
  const body = readableBody(response.body, response.body_encoding)
  if (body === null) {
    return `${status} · no body`
  }

  return `${status} · ${summarizeValue(body, fieldsInWords)}`
}

export function summarizeAnswer(answer: Answer): string {
  if (isError(answer)) {
    const name = errorName(answer.error)
    const detail = truncate(errorDetail(answer.error.message), 72)
    return name ? `${name}: ${detail}` : `Error: ${detail}`
  }

  return summarizeValue(answer.value)
}

/** The caller gave up on this call and sent it again; Rewind replays that as a timeout. */
export function isRepeatedCall(call: { inferred?: string; answer: Answer }): boolean {
  return Boolean(call.inferred) && isError(call.answer) && call.answer.error.code === 'TIMEOUT'
}

// ── what looks wrong in an answer ───────────────────────────────────────

export type Finding = {
  path: string
  kind: 'cut-json' | 'number-as-text'
  /** What is wrong at `path`, such as "tool_call.args: JSON cut off at 63", for the cause line. */
  title: string
  detail: string
  /** For JSON text: the text itself and where parsing stopped, when the runtime said. */
  text?: string
  position?: number
}

function looksLikeJson(text: string): boolean {
  return /^\s*[[{]/.test(text)
}

function walk(value: unknown, path: string, visit: (value: unknown, path: string) => void): void {
  visit(value, path)
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, path ? `${path}.${key}` : key, visit)
    }
  }
}

/** Strings that should have been structured data: JSON text that does not parse, and numbers sent as text. */
export function findings(answer: Answer): Finding[] {
  if (isError(answer)) {
    return []
  }

  const out: Finding[] = []
  walk(answer.value, '', (value, path) => {
    if (typeof value !== 'string' || !path) {
      return
    }

    if (looksLikeJson(value)) {
      const stop = jsonStop(value)
      if (stop) {
        out.push({ path, kind: 'cut-json', title: `${path}: ${stop.label}`, detail: stop.detail, text: value, position: stop.position })
      }

      return
    }

    if (/^-?\d+(\.\d+)?$/.test(value)) {
      out.push({ path, kind: 'number-as-text', title: `${path}: number sent as string "${value}"`, detail: 'Code on the other side that expects a number will fail on it.' })
    }
  })
  return out
}

export type ClosedJson = { value: unknown; dropped: string }

/**
 * Parses JSON text that was cut off by closing it at the last complete value.
 * A value cut mid way is left out and returned as `dropped`, so the editor can
 * say which field is missing.
 */
export function closeCutJson(text: string): ClosedJson | undefined {
  for (let end = text.length; end > 0; end--) {
    const kept = text.slice(0, end)
    const candidate = kept.replace(/[\s,:]+$/, '')
    const closers = closersFor(candidate)
    if (closers === undefined) {
      continue
    }

    try {
      return { value: JSON.parse(candidate + closers), dropped: text.slice(candidate.length).replace(/^[\s,]+/, '') }
    } catch {
      // keep trimming until a prefix parses
    }
  }

  return undefined
}

const CLOSER_OF: Record<string, string> = { '{': '}', '[': ']' }

/** The brackets that would close `text`, or undefined when it ends inside a string. */
function closersFor(text: string): string | undefined {
  const stack: string[] = []
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') {
        i += 1
        continue
      }

      inString = ch !== '"'
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (CLOSER_OF[ch]) {
      stack.push(CLOSER_OF[ch])
      continue
    }

    if (ch === '}' || ch === ']') {
      stack.pop()
    }
  }

  return inString ? undefined : stack.reverse().join('')
}

export function setPath(root: unknown, path: string, next: unknown): unknown {
  const keys = path.split('.')
  const copy = structuredClone(root) as Record<string, unknown>
  let cursor = copy
  for (const key of keys.slice(0, -1)) {
    cursor = cursor[key] as Record<string, unknown>
  }

  cursor[keys[keys.length - 1]] = next
  return copy
}

/** The value with JSON text at the findings' paths swapped for a pointer, since the text is shown on its own. */
export function withTextSetAside(value: unknown, found: Finding[]): unknown {
  return found.filter((f) => f.kind === 'cut-json').reduce((acc, f) => setPath(acc, f.path, '⋯ cut off, shown below ⋯'), value)
}

export function getPath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cursor, key) => (cursor as Record<string, unknown> | undefined)?.[key], root)
}

type Fixed = { value: unknown; dropped?: string }

const FIXES: Record<Finding['kind'], (current: unknown) => Fixed> = {
  'cut-json': (current) => closeCutJson(String(current)) ?? { value: current },
  'number-as-text': (current) => ({ value: Number(current) }),
}

/** The answer's value with every finding fixed, and any cut-off text the fix had to leave out. */
export function applyFixes(value: unknown, found: Finding[]): { value: unknown; dropped: string[] } {
  return found.reduce<{ value: unknown; dropped: string[] }>(
    (acc, finding) => {
      const fixed = FIXES[finding.kind](getPath(acc.value, finding.path))
      return { value: setPath(acc.value, finding.path, fixed.value), dropped: fixed.dropped ? [...acc.dropped, fixed.dropped] : acc.dropped }
    },
    { value, dropped: [] },
  )
}

/** Fields that cut-off tool arguments lost, by the path of those arguments, for the form to mark. */
export type LostFields = Record<string, string[]>

function parentPath(path: string): string {
  return path.split('.').slice(0, -1).join('.')
}

/**
 * The fix as the schema reads it. Closed JSON text goes back in as an object,
 * as a model's tool call `args` normally are, unless the schema allows only
 * text there. The fields of the tool's input that the cut took are listed.
 */
export function applyFixesFor(value: unknown, found: Finding[], check: AnswerCheck): { value: unknown; dropped: string[]; lost: LostFields } {
  const fixed = applyFixes(value, found)
  const cut = found.filter((f) => f.kind === 'cut-json')
  const lost: LostFields = {}
  for (const finding of cut) {
    const parentValue = finding.path.includes('.') ? getPath(fixed.value, parentPath(finding.path)) : fixed.value
    const name = isPlainObject(parentValue) ? parentValue.name : undefined
    const tool = typeof name === 'string' ? check.tools(name) : undefined
    if (tool) {
      lost[finding.path] = lostFields(tool, getPath(fixed.value, finding.path), closeCutJson(finding.text ?? '')?.dropped ?? '')
    }
  }

  const asText = cut.filter((f) => textOnly(schemaAt(check.schema, fixed.value, f.path)))
  const restored = asText.reduce((acc, f) => setPath(acc, f.path, JSON.stringify(getPath(acc, f.path))), fixed.value)
  return { value: restored, dropped: fixed.dropped, lost }
}

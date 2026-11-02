/**
 * The JSON schemas a function declares for what it takes (`request_format`)
 * and what it returns (`response_format`), as the engine reports them. The
 * page checks a value against one, builds a starting value that fits one, and
 * follows a model's tool call to the input schema of the tool it calls.
 *
 * Only the part of JSON Schema the sample app uses is read: `type`,
 * `properties`, `required`, `enum`, `const`, `items`, `minimum`, `maximum`,
 * `format` (`date`, `date-time`, `email`), and `oneOf` or `anyOf`. Anything
 * else is passed over, so a richer schema is checked less strictly, not more.
 *
 * A tool call is an object with `name` and `args`, where `name` is a function
 * with an input schema. String `args` are JSON text, parsed before checking.
 */
import type { FunctionRow } from '../client/types'

export type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'

export type JsonSchema = {
  /** `map` is how the iii SDKs spell an object with free keys. */
  type?: SchemaType | 'map' | (SchemaType | 'map')[]
  title?: string
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: unknown[]
  const?: unknown
  default?: unknown
  items?: JsonSchema
  format?: string
  minimum?: number
  maximum?: number
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
}

/** One way a value breaks its schema. `path` is empty for the value itself, else like `tool_call.name` or `messages[0].role`. */
export type Problem = { path: string; message: string }

/** The input schema of the function a tool call calls, when it declares one. */
export type ToolSchemas = (name: string) => JsonSchema | undefined

export type Formats = { request: ToolSchemas; response: ToolSchemas }

/** What an answer is checked against: the function's response schema, and the tools a tool call in it may name. */
export type AnswerCheck = { schema: JsonSchema; tools: ToolSchemas }

export function isSchema(value: unknown): value is JsonSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const schema = value as JsonSchema
  return Boolean(schema.type || schema.properties || schema.items || schema.enum || schema.oneOf || schema.anyOf || 'const' in schema)
}

export function formatsOf(functions: FunctionRow[]): Formats {
  const byId = new Map(functions.map((f) => [f.function_id, f]))
  const pick = (schema: unknown) => (isSchema(schema) ? schema : undefined)
  return {
    request: (functionId) => pick(byId.get(functionId)?.request_format),
    response: (functionId) => pick(byId.get(functionId)?.response_format),
  }
}

/** A pause may carry the schema itself; otherwise it comes from the function's row. */
export function answerCheck(formats: Formats, functionId: string, declared?: unknown): AnswerCheck | undefined {
  const schema = isSchema(declared) ? declared : formats.response(functionId)
  return schema ? { schema, tools: formats.request } : undefined
}

export function problemText(problem: Problem): string {
  return problem.path ? `${problem.path} · ${problem.message}` : problem.message
}

/** The first problem, and how many more there are. */
export function problemsText(problems: Problem[]): string {
  const first = problemText(problems[0])
  return problems.length > 1 ? `${first} · ${problems.length - 1} more` : first
}

// ── types ───────────────────────────────────────────────────────────────

/** The types a schema allows, with `map` read as an object, or inferred from `properties` and `items`. */
export function typesOf(schema: JsonSchema): SchemaType[] {
  if (schema.type) {
    const listed = Array.isArray(schema.type) ? schema.type : [schema.type]
    return listed.map((t) => (t === 'map' ? 'object' : t))
  }

  if (schema.properties) {
    return ['object']
  }

  return schema.items ? ['array'] : []
}

/** The types a schema allows, its branches' included. */
export function allowedTypes(schema: JsonSchema | undefined): SchemaType[] {
  if (!schema) {
    return []
  }

  return [...new Set([...typesOf(schema), ...(unionOf(schema) ?? []).flatMap(allowedTypes)])]
}

/** Whether a value here is JSON text: the schema allows a string and no object, so the text can't go back as an object. */
export function textOnly(schema: JsonSchema | undefined): boolean {
  const types = allowedTypes(schema)
  return types.includes('string') && !types.includes('object')
}

/** A schema's properties with the required ones first, in the order `required` gives, since the engine sorts keys alphabetically. */
export function orderedKeys(schema: JsonSchema): string[] {
  const keys = Object.keys(schema.properties ?? {})
  const required = (schema.required ?? []).filter((key) => keys.includes(key))
  return [...required, ...keys.filter((key) => !required.includes(key))]
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const MATCHES: Record<SchemaType, (value: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: isPlainObject,
  array: Array.isArray,
  null: (v) => v === null,
}

/** The JSON type of a value, as an error message says it. */
function typeName(value: unknown): string {
  if (value === null) {
    return 'null'
  }

  return Array.isArray(value) ? 'array' : typeof value
}

// A full date, RFC 3339's date-time, which needs an offset or Z, and an address with one @.
const FORMATS: Record<string, (text: string) => boolean> = {
  date: (text) => /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)),
  'date-time': (text) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$/.test(text) && !Number.isNaN(Date.parse(text)),
  email: (text) => /^[^@\s]+@[^@\s]+$/.test(text),
}

/** What a field for this format shows before anything is typed. */
export const FORMAT_PLACEHOLDER: Record<string, string> = {
  date: 'YYYY-MM-DD',
  'date-time': 'YYYY-MM-DDThh:mm:ss±hh:mm',
  email: 'name@example.com',
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function shown(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const ENUM_SHOWN = 4

function oneOfText(options: unknown[]): string {
  const listed = options.slice(0, ENUM_SHOWN).map(shown).join(', ')
  return options.length > ENUM_SHOWN ? `${listed}, …` : listed
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

// ── checking a value ────────────────────────────────────────────────────

/** Every way `value` breaks `schema`. A missing value is only a problem where its parent requires it. */
export function validate(schema: JsonSchema | undefined, value: unknown, path = ''): Problem[] {
  if (!schema || value === undefined) {
    return []
  }

  const branches = unionOf(schema)
  const own = ownProblems(schema, value, path)
  return branches ? [...own, ...closestBranch(branches, value, path).problems] : own
}

function ownProblems(schema: JsonSchema, value: unknown, path: string): Problem[] {
  if ('const' in schema && !sameValue(schema.const, value)) {
    return [{ path, message: `expected ${shown(schema.const)}` }]
  }

  if (schema.enum && !schema.enum.some((option) => sameValue(option, value))) {
    return [{ path, message: `expected one of ${oneOfText(schema.enum)}` }]
  }

  const types = typesOf(schema)
  if (types.length > 0 && !types.some((t) => MATCHES[t](value))) {
    return [{ path, message: `expected ${types.join(' or ')}, got ${typeName(value)}` }]
  }

  return [...formatProblems(schema, value, path), ...rangeProblems(schema, value, path), ...objectProblems(schema, value, path), ...arrayProblems(schema, value, path)]
}

function rangeProblems(schema: JsonSchema, value: unknown, path: string): Problem[] {
  if (typeof value !== 'number') {
    return []
  }

  if (schema.minimum !== undefined && value < schema.minimum) {
    return [{ path, message: `expected at least ${schema.minimum}` }]
  }

  return schema.maximum !== undefined && value > schema.maximum ? [{ path, message: `expected at most ${schema.maximum}` }] : []
}

function formatProblems(schema: JsonSchema, value: unknown, path: string): Problem[] {
  const test = schema.format ? FORMATS[schema.format] : undefined
  if (!test || typeof value !== 'string' || test(value)) {
    return []
  }

  return [{ path, message: `expected ${schema.format}` }]
}

function objectProblems(schema: JsonSchema, value: unknown, path: string): Problem[] {
  if (!isPlainObject(value)) {
    return []
  }

  const missing = (schema.required ?? []).filter((key) => value[key] === undefined).map((key) => ({ path: join(path, key), message: 'required' }))
  const fields = Object.entries(schema.properties ?? {}).flatMap(([key, child]) => validate(child, value[key], join(path, key)))
  return [...missing, ...fields]
}

function arrayProblems(schema: JsonSchema, value: unknown, path: string): Problem[] {
  if (!Array.isArray(value) || !schema.items) {
    return []
  }

  return value.flatMap((item, index) => validate(schema.items, item, `${path}[${index}]`))
}

// ── one of several shapes ───────────────────────────────────────────────

export function unionOf(schema: JsonSchema): JsonSchema[] | undefined {
  const branches = schema.oneOf ?? schema.anyOf
  return branches && branches.length > 0 ? branches : undefined
}

/** How many of the value's keys a branch knows, so `{ text }` reads as the reply and not as a tool call missing its `tool_call`. */
function keysKnown(branch: JsonSchema, value: unknown): number {
  if (!isPlainObject(value) || !branch.properties) {
    return 0
  }

  return Object.keys(value).filter((key) => key in (branch.properties ?? {})).length
}

/** The branch a value is closest to: the one that knows most of its keys, then the one it breaks least. */
export function closestBranch(branches: JsonSchema[], value: unknown, path = ''): { index: number; problems: Problem[] } {
  const scored = branches.map((branch, index) => ({ index, known: keysKnown(branch, value), problems: validate(branch, value, path) }))
  scored.sort((a, b) => b.known - a.known || a.problems.length - b.problems.length || a.index - b.index)
  const { index, problems } = scored[0]
  return { index, problems }
}

/** A branch's name in the picker: its title, else the keys it requires, else its type. */
export function branchLabel(branch: JsonSchema, index: number): string {
  if (branch.title) {
    return branch.title
  }

  if (branch.required?.length) {
    return branch.required.join(', ')
  }

  const types = typesOf(branch)
  return types.length > 0 ? types.join(' or ') : `Shape ${index + 1}`
}

// ── a value that fits ───────────────────────────────────────────────────

/**
 * A value that fits the schema, to start typing from: each enum's first value,
 * empty strings, zeros, and the required fields of an object. A tool call gets
 * the empty input of the tool it calls.
 */
export function skeleton(schema: JsonSchema | undefined, tools?: ToolSchemas): unknown {
  if (!schema) {
    return null
  }

  const branches = unionOf(schema)
  if (branches) {
    return skeleton(branches[0], tools)
  }

  if ('const' in schema) {
    return schema.const
  }

  if (schema.default !== undefined) {
    return schema.default
  }

  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[0]
  }

  const types = typesOf(schema)
  const type = types.find((t) => t !== 'null') ?? types[0]
  return type ? EMPTY[type](schema, tools) : null
}

/** Zero, or the nearest number the schema's range allows. */
function inRange(schema: JsonSchema): number {
  return Math.min(Math.max(0, schema.minimum ?? 0), schema.maximum ?? Number.POSITIVE_INFINITY)
}

const EMPTY: Record<SchemaType, (schema: JsonSchema, tools?: ToolSchemas) => unknown> = {
  string: () => '',
  number: inRange,
  integer: inRange,
  boolean: () => false,
  null: () => null,
  array: () => [],
  object: (schema, tools) => {
    const fields = Object.fromEntries((schema.required ?? []).map((key) => [key, skeleton(schema.properties?.[key], tools)]))
    return withToolArgs(schema, fields, tools)
  },
}

function withToolArgs(schema: JsonSchema, fields: Record<string, unknown>, tools?: ToolSchemas): Record<string, unknown> {
  const tool = typeof fields.name === 'string' ? tools?.(fields.name) : undefined
  const argsSchema = schema.properties?.args
  if (!tool || !argsSchema) {
    return fields
  }

  const args = skeleton(tool, tools)
  return { ...fields, args: textOnly(argsSchema) ? JSON.stringify(args) : args }
}

// ── JSON text ───────────────────────────────────────────────────────────

/** Where JSON text stops parsing: cut off at the end, or broken before it. */
export type JsonStop = { position?: number; cut: boolean; label: string; detail: string }

function stopLabel(cut: boolean, position: number | undefined): string {
  if (position === undefined) {
    return 'invalid JSON'
  }

  return cut ? `JSON cut off at ${position}` : `invalid JSON at ${position}`
}

// V8 says where parsing stopped, except at the very end of the text.
function stopPosition(text: string, detail: string): number | undefined {
  const at = /position (\d+)/.exec(detail)?.[1]
  if (at !== undefined) {
    return Number(at)
  }

  return /end of JSON input/.test(detail) ? text.length : undefined
}

/** Where the text stops parsing as JSON, or undefined when it parses. */
export function jsonStop(text: string): JsonStop | undefined {
  try {
    JSON.parse(text)
    return undefined
  } catch (error) {
    const detail = (error as Error).message
    const position = stopPosition(text, detail)
    const cut = position !== undefined && position >= text.trimEnd().length - 1
    return { position, cut, label: stopLabel(cut, position), detail }
  }
}

// ── tool calls ──────────────────────────────────────────────────────────

export type ToolCall = { path: string; name: string; args: unknown; schema: JsonSchema }

export type ParsedArgs = { ok: true; value: unknown } | { ok: false; message: string }

/** Every tool call in a value whose tool declares an input schema. Paths end with a dot, ready for `args`. */
export function toolCalls(value: unknown, tools: ToolSchemas, path = ''): ToolCall[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => toolCalls(item, tools, `${path}[${index}].`))
  }

  if (!isPlainObject(value)) {
    return []
  }

  const schema = typeof value.name === 'string' && 'args' in value ? tools(value.name) : undefined
  if (schema) {
    return [{ path, name: value.name as string, args: value.args, schema }]
  }

  return Object.entries(value).flatMap(([key, child]) => toolCalls(child, tools, `${path}${key}.`))
}

export function parseArgs(args: unknown): ParsedArgs {
  if (typeof args !== 'string') {
    return { ok: true, value: args }
  }

  try {
    return { ok: true, value: JSON.parse(args) }
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }
}

/** Arguments that don't parse, and arguments that break their tool's input schema, with paths inside the arguments. */
export function toolProblems(value: unknown, tools: ToolSchemas): Problem[] {
  return toolCalls(value, tools).flatMap((call) => {
    const parsed = parseArgs(call.args)
    if (!parsed.ok) {
      return [{ path: `${call.path}args`, message: jsonStop(String(call.args))?.label ?? 'invalid JSON' }]
    }

    return validate(call.schema, parsed.value)
  })
}

/** Everything wrong with an answer: its own schema, then the arguments of any tool call in it. */
export function answerProblems(value: unknown, check: AnswerCheck): Problem[] {
  return [...validate(check.schema, value), ...toolProblems(value, check.tools)]
}

/** The answer's problems when the text is JSON, and none when it isn't, which the editor reports on its own. */
export function textProblems(text: string, check: AnswerCheck | undefined): Problem[] {
  if (!check) {
    return []
  }

  try {
    return answerProblems(JSON.parse(text), check)
  } catch {
    return []
  }
}

/** The schema at a dotted path in a value, following the branch the value is closest to. */
export function schemaAt(schema: JsonSchema | undefined, value: unknown, path: string): JsonSchema | undefined {
  if (!schema || !path) {
    return schema
  }

  const branches = unionOf(schema)
  if (branches) {
    return schemaAt(branches[closestBranch(branches, value).index], value, path)
  }

  const [key, ...rest] = path.split('.')
  const child = /^\d+$/.test(key) && schema.items ? schema.items : schema.properties?.[key]
  const inner = isPlainObject(value) || Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined
  return schemaAt(child, inner, rest.join('.'))
}

/** The fields of a tool's input that cut-off arguments lost: required ones that are missing, and the one the text was cut inside. */
export function lostFields(tool: JsonSchema, recovered: unknown, dropped: string): string[] {
  const present = isPlainObject(recovered) ? recovered : {}
  const cutInside = /^"([^"\\]+)"?/.exec(dropped.trim())?.[1]
  const missing = (tool.required ?? []).filter((key) => present[key] === undefined)
  const named = cutInside && cutInside in (tool.properties ?? {}) && present[cutInside] === undefined ? [cutInside] : []
  return [...new Set([...named, ...missing])]
}

/** The first way a recorded call breaks its function's schemas: its input, then its output. */
export type CallIssue = { side: 'input' | 'output'; problem: Problem }

export function callIssue(call: { function_id: string; input: unknown; answer: { value: unknown } | { error: unknown } }, formats: Formats): CallIssue | undefined {
  const input = validate(formats.request(call.function_id), call.input)[0]
  if (input) {
    return { side: 'input', problem: input }
  }

  const output = 'value' in call.answer ? validate(formats.response(call.function_id), call.answer.value)[0] : undefined
  return output ? { side: 'output', problem: output } : undefined
}

const SIDE_LABEL: Record<CallIssue['side'], string> = { input: 'Input', output: 'Output' }

export function issueText(issue: CallIssue): string {
  return `${SIDE_LABEL[issue.side]} · ${problemText(issue.problem)}`
}

/**
 * An answer as a form built from the function's response schema: one field
 * per property, a select for an enum, a switch for a boolean, a number field,
 * a text field with the date format as its placeholder, an indented group for
 * an object and a repeatable group for a list. A field's description is its
 * tooltip, required fields have a star, and each field shows what is wrong
 * with it under the control.
 *
 * A number field shows a string with its quotes, so `"60"` where the schema
 * wants an integer reads as text, not as the number it looks like. A tool
 * call's `args`, an object or JSON text, are a form of the called tool's
 * input, written back as an object unless the schema allows only text.
 */
import { Button, Chip, IconButton, Input, Select, Switch, Tooltip } from '@iii-dev/console-ui'
import { Plus, X } from 'lucide-react'
import { type ComponentType, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { LostFields } from '../model/answers'
import {
  type AnswerCheck,
  branchLabel,
  closestBranch,
  FORMAT_PLACEHOLDER,
  isPlainObject,
  type JsonSchema,
  jsonStop,
  orderedKeys,
  parseArgs,
  type Problem,
  problemText,
  skeleton,
  textOnly,
  type ToolSchemas,
  typesOf,
  unionOf,
  validate,
} from '../model/schema'
import { CutText } from './bits'

type Context = { tools: ToolSchemas; lost: LostFields }

type NodeProps = {
  schema: JsonSchema
  value: unknown
  onChange: (next: unknown) => void
  /** Where the field is in this form's value, as problems give it. */
  path: string
  name: string
  required: boolean
  problems: Problem[]
  context: Context
  /** A group without its own head: the root of a form, or the shape a union picked. */
  headless?: boolean
  /** Fields of this object that cut-off arguments lost, marked until they have a value again. */
  marks?: string[]
  /** For a list's item: the button that removes it. */
  trailing?: ReactNode
}

type Kind = 'union' | 'enum' | 'boolean' | 'number' | 'text' | 'object' | 'array' | 'json'

function kindOf(schema: JsonSchema): Kind {
  if (unionOf(schema)) {
    return 'union'
  }

  if (schema.enum || 'const' in schema) {
    return 'enum'
  }

  const type = typesOf(schema).find((t) => t !== 'null')
  return type ? KIND_OF_TYPE[type] : 'json'
}

const KIND_OF_TYPE: Record<Exclude<ReturnType<typeof typesOf>[number], 'null'>, Kind> = {
  string: 'text',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
  object: 'object',
  array: 'array',
}

/** The type beside a field's name: its format when it has one, such as `date-time`. */
function typeHint(schema: JsonSchema): string {
  if (schema.format) {
    return schema.format
  }

  if (schema.enum || unionOf(schema)) {
    return ''
  }

  const types = typesOf(schema).filter((t) => t !== 'null')
  return types.includes('array') ? 'list' : types.join(' or ')
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

function withKey(record: Record<string, unknown>, key: string, next: unknown): Record<string, unknown> {
  if (next !== undefined) {
    return { ...record, [key]: next }
  }

  const { [key]: _gone, ...rest } = record
  return rest
}

/** What a text field shows: a string as itself, anything else as JSON. */
function textOf(value: unknown): string {
  if (value === undefined) {
    return ''
  }

  return typeof value === 'string' ? value : JSON.stringify(value)
}

function ownProblems(problems: Problem[], path: string): Problem[] {
  return problems.filter((p) => p.path === path)
}

function Errors({ problems }: { problems: Problem[] }) {
  return (
    <>
      {problems.map((problem) => (
        <p key={`${problem.path}:${problem.message}`} className="rw-field-error">
          {problemText(problem)}
        </p>
      ))}
    </>
  )
}

function Label({ htmlFor, name, schema, required, marked, hint = typeHint(schema) }: { htmlFor?: string; name: string; schema: JsonSchema; required: boolean; marked?: boolean; hint?: string }) {
  const label = (
    <label className="rw-field-label" htmlFor={htmlFor} data-described={schema.description ? '' : undefined}>
      <span className="rw-field-name">{name}</span>
      {required ? <span className="rw-field-required">*</span> : null}
      {hint ? <span className="rw-field-type">{hint}</span> : null}
      {marked ? (
        <Chip tone="warning" className="rw-chip">
          Cut off
        </Chip>
      ) : null}
    </label>
  )
  return schema.description ? <Tooltip label={schema.description}>{label}</Tooltip> : label
}

/** One labelled control, with what is wrong with it underneath. */
function Field({ props, id, children }: { props: NodeProps; id: string; children: ReactNode }) {
  const own = ownProblems(props.problems, props.path)
  return (
    <div className="rw-field" data-invalid={own.length > 0 || undefined}>
      <Label htmlFor={id} name={props.name} schema={props.schema} required={props.required} marked={props.marks?.includes(props.name)} />
      <div className="rw-field-control">
        <div className="rw-field-input-row">
          {children}
          {props.trailing}
        </div>
        <Errors problems={own} />
      </div>
    </div>
  )
}

function Group({ props, hint, children }: { props: NodeProps; hint?: string; children: ReactNode }) {
  const own = ownProblems(props.problems, props.path)
  if (props.headless) {
    return (
      <>
        <Errors problems={own} />
        {children}
      </>
    )
  }

  return (
    <div className="rw-field-group" data-invalid={own.length > 0 || undefined}>
      <div className="rw-field-group-head">
        <Label name={props.name} schema={props.schema} required={props.required} hint={hint} />
        {props.trailing}
      </div>
      <Errors problems={own} />
      <div className="rw-field-children">{children}</div>
    </div>
  )
}

// ── one node per kind ───────────────────────────────────────────────────

function TextNode(props: NodeProps) {
  const id = useId()
  const own = ownProblems(props.problems, props.path)
  return (
    <Field props={props} id={id}>
      <Input
        id={id}
        className="rw-field-input"
        value={textOf(props.value)}
        onChange={(next) => props.onChange(next === '' && !props.required ? undefined : next)}
        placeholder={FORMAT_PLACEHOLDER[props.schema.format ?? '']}
        spellCheck={false}
        aria-required={props.required}
        aria-invalid={own.length > 0}
      />
    </Field>
  )
}

const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

/** What a number field shows: a number as itself, a string in quotes, so it can't pass for a number. */
function numberText(value: unknown): string {
  if (value === undefined) {
    return ''
  }

  return typeof value === 'number' ? String(value) : JSON.stringify(value)
}

/** What a number field's text means: a number, a quoted string, or else the text as typed. */
function readNumber(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') {
    return undefined
  }

  if (NUMBER.test(trimmed)) {
    return Number(trimmed)
  }

  try {
    return /^".*"$/.test(trimmed) ? JSON.parse(trimmed) : text
  } catch {
    return text
  }
}

function NumberNode(props: NodeProps) {
  const id = useId()
  const own = ownProblems(props.problems, props.path)
  const [text, setText] = useState(() => numberText(props.value))

  // Keep what the person typed, such as "1.", while it means the same value.
  useEffect(() => {
    setText((current) => (JSON.stringify(readNumber(current)) === JSON.stringify(props.value) ? current : numberText(props.value)))
  }, [props.value])

  return (
    <Field props={props} id={id}>
      <Input
        id={id}
        className="rw-field-input"
        value={text}
        inputMode={typesOf(props.schema).includes('integer') ? 'numeric' : 'decimal'}
        onChange={(next) => {
          setText(next)
          props.onChange(readNumber(next))
        }}
        spellCheck={false}
        aria-required={props.required}
        aria-invalid={own.length > 0}
      />
    </Field>
  )
}

function BooleanNode(props: NodeProps) {
  const id = useId()
  return (
    <Field props={props} id={id}>
      <Switch id={id} checked={props.value === true} onChange={(event) => props.onChange(event.target.checked)} aria-required={props.required} />
    </Field>
  )
}

function EnumNode(props: NodeProps) {
  const id = useId()
  const options = props.schema.enum ?? [props.schema.const]
  const index = options.findIndex((o) => JSON.stringify(o) === JSON.stringify(props.value))
  return (
    <Field props={props} id={id}>
      <Select
        id={id}
        className="rw-field-select"
        value={index >= 0 ? String(index) : undefined}
        options={options.map((option, i) => ({ value: String(i), label: textOf(option) }))}
        onChange={(next) => props.onChange(options[Number(next)])}
        placeholder={textOf(props.value)}
        aria-label={props.name}
        aria-invalid={index < 0 && props.value !== undefined}
      />
    </Field>
  )
}

/** A value the schema says nothing about, edited as JSON in one line. */
function JsonNode(props: NodeProps) {
  const id = useId()
  const [text, setText] = useState(() => (props.value === undefined ? '' : JSON.stringify(props.value)))
  const [bad, setBad] = useState(false)
  return (
    <Field props={props} id={id}>
      <Input
        id={id}
        className="rw-field-input"
        value={text}
        onChange={(next) => {
          setText(next)
          try {
            props.onChange(next.trim() === '' ? undefined : JSON.parse(next))
            setBad(false)
          } catch {
            setBad(true)
          }
        }}
        placeholder="JSON"
        spellCheck={false}
        aria-invalid={bad}
      />
      {bad ? <span className="rw-field-error">invalid JSON</span> : null}
    </Field>
  )
}

/** One of several shapes: a select for the shape, then the shape's own fields. */
function UnionNode(props: NodeProps) {
  const id = useId()
  const branches = unionOf(props.schema) ?? []
  const index = closestBranch(branches, props.value).index
  const branch = branches[index]
  const label: NodeProps = props.headless ? { ...props, name: 'one of', required: false } : props
  return (
    <>
      <div className="rw-field">
        <Label htmlFor={id} name={label.name} schema={props.schema} required={label.required} hint="" />
        <div className="rw-field-control">
          <Select
            id={id}
            className="rw-field-select"
            value={String(index)}
            options={branches.map((b, i) => ({ value: String(i), label: branchLabel(b, i) }))}
            onChange={(next) => props.onChange(skeleton(branches[Number(next)], props.context.tools))}
            aria-label={`Shape of ${props.name}`}
          />
        </div>
      </div>
      <Node {...props} schema={branch} headless />
    </>
  )
}

/** A tool call's name and arguments, with the arguments reset to the new tool's when the name changes to a tool they don't fit. */
function withArgsFor(record: Record<string, unknown>, argsSchema: JsonSchema | undefined, tools: ToolSchemas): Record<string, unknown> {
  const tool = typeof record.name === 'string' ? tools(record.name) : undefined
  const parsed = parseArgs(record.args)
  if (!tool || (parsed.ok && validate(tool, parsed.value).length === 0)) {
    return record
  }

  const args = skeleton(tool, tools)
  return { ...record, args: textOnly(argsSchema) ? JSON.stringify(args) : args }
}

function ObjectNode(props: NodeProps) {
  const { schema, path, context } = props
  const record = isPlainObject(props.value) ? props.value : {}
  const required = new Set(schema.required ?? [])
  const tool = typeof record.name === 'string' && schema.properties?.args ? context.tools(record.name) : undefined

  const set = (key: string, next: unknown) => {
    const updated = withKey(record, key, next)
    props.onChange(key === 'name' && 'args' in updated ? withArgsFor(updated, schema.properties?.args, context.tools) : updated)
  }

  return (
    <Group props={props}>
      {orderedKeys(schema).map((key) => {
        const child = schema.properties?.[key] ?? {}
        const shared = {
          value: record[key],
          onChange: (next: unknown) => set(key, next),
          path: join(path, key),
          name: key,
          required: required.has(key),
          problems: props.problems,
          context,
          marks: props.marks?.includes(key) && record[key] === undefined ? [key] : undefined,
        }
        return key === 'args' && tool ? (
          <ToolArgs key={key} {...shared} schema={child} tool={tool} toolName={String(record.name)} />
        ) : (
          <Node key={key} {...shared} schema={child} />
        )
      })}
    </Group>
  )
}

/**
 * A key per list item that stays with the item when one before it is removed,
 * so a field's own state, such as a half-typed number, stays with its item.
 * The JSON tab can also change the list, adding or dropping items at its end.
 */
function useItemKeys(count: number): { keys: number[]; remove: (index: number) => void } {
  const next = useRef(0)
  const keys = useRef<number[]>([])
  keys.current = keys.current.slice(0, count)
  while (keys.current.length < count) {
    keys.current.push(next.current++)
  }

  return { keys: keys.current, remove: (index) => keys.current.splice(index, 1) }
}

function ArrayNode(props: NodeProps) {
  const items = Array.isArray(props.value) ? props.value : []
  const itemSchema = props.schema.items ?? {}
  const { keys, remove } = useItemKeys(items.length)
  const set = (index: number, next: unknown) => props.onChange(items.map((item, i) => (i === index ? next : item)))
  const removeAt = (index: number) => {
    remove(index)
    props.onChange(items.filter((_, i) => i !== index))
  }

  return (
    <Group props={props} hint={`list of ${items.length}`}>
      {items.map((item, index) => (
        <Node
          key={keys[index]}
          schema={itemSchema}
          value={item}
          onChange={(next) => set(index, next)}
          path={`${props.path}[${index}]`}
          name={String(index)}
          required={false}
          problems={props.problems}
          context={props.context}
          trailing={
            <IconButton label={`Remove ${props.name} ${index}`} variant="ghost" onClick={() => removeAt(index)}>
              <X aria-hidden />
            </IconButton>
          }
        />
      ))}
      <div>
        <Button variant="ghost" size="sm" onClick={() => props.onChange([...items, skeleton(itemSchema, props.context.tools)])}>
          <Plus aria-hidden />
          Add item
        </Button>
      </div>
    </Group>
  )
}

const NODES: Record<Kind, ComponentType<NodeProps>> = {
  union: UnionNode,
  enum: EnumNode,
  boolean: BooleanNode,
  number: NumberNode,
  text: TextNode,
  object: ObjectNode,
  array: ArrayNode,
  json: JsonNode,
}

function Node(props: NodeProps) {
  const Component = NODES[kindOf(props.schema)]
  return <Component {...props} />
}

// ── a tool call's arguments ─────────────────────────────────────────────

/**
 * The arguments as a form of the called tool's input. Arguments cut off mid
 * way show as the text, marked where it stops, until "Close cut-off JSON"
 * parses what is there; the fields that went with the cut are then marked.
 */
function ToolArgs(props: NodeProps & { tool: JsonSchema; toolName: string }) {
  const { tool, toolName, context } = props
  const parsed = parseArgs(props.value)
  const asText = textOnly(props.schema)
  const hint = `${toolName} input`

  if (!parsed.ok) {
    const text = String(props.value)
    const stop = jsonStop(text)
    return (
      <Group props={props} hint={hint}>
        <CutText text={text} position={stop?.position} />
        <Errors problems={[{ path: props.path, message: stop?.label ?? 'invalid JSON' }]} />
      </Group>
    )
  }

  const args = parsed.value
  return (
    <Group props={props} hint={hint}>
      <ObjectNode
        schema={tool}
        value={args}
        onChange={(next) => props.onChange(asText ? JSON.stringify(next) : next)}
        path=""
        name={props.name}
        required={props.required}
        problems={validate(tool, args)}
        context={context}
        marks={context.lost[props.path] ?? []}
        headless
      />
    </Group>
  )
}

export function SchemaForm({ check, value, onChange, lost }: { check: AnswerCheck; value: unknown; onChange: (next: unknown) => void; lost: LostFields }) {
  return (
    <div className="rw-form">
      <Node
        schema={check.schema}
        value={value}
        onChange={onChange}
        path=""
        name="value"
        required
        problems={validate(check.schema, value)}
        context={{ tools: check.tools, lost }}
        headless={kindOf(check.schema) === 'object' || kindOf(check.schema) === 'union'}
      />
    </div>
  )
}

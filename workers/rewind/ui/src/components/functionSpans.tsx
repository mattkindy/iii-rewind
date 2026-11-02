/**
 * Where an error happened inside a worker: the traced function that threw,
 * such as the agent's parseArgs on cut-off text or the tools worker's find_slot
 * on a duration sent as text. Its arguments are behind a disclosure. A string
 * argument shows as text, so JSON text in it never shows escaped.
 */
import { CollapsibleCard, CollapsibleCardContent, CollapsibleCardTrigger } from '@iii-dev/console-ui'
import { ChevronRight, SquareFunction } from 'lucide-react'
import type { FunctionSpan } from '../client/types'
import { duration } from '../model/format'
import { readableValue } from '../model/requests'
import { JsonBlock, SectionHead } from './bits'

type SpanError = { code?: string; message: string }

/** `function src/worker.ts:parseArgs` as its name and its file. */
function nameOf(span: FunctionSpan): { name: string; file?: string } {
  const target = span.name.replace(/^function\s+/, '')
  const colon = target.lastIndexOf(':')
  return colon > 0 ? { name: target.slice(colon + 1), file: target.slice(0, colon) } : { name: target }
}

function errorOf(span: FunctionSpan): SpanError | undefined {
  const error = span.error as { code?: unknown; message?: unknown } | null | undefined
  if (!error || typeof error.message !== 'string') {
    return undefined
  }

  return { code: typeof error.code === 'string' ? error.code : undefined, message: error.message }
}

function argumentsOf(span: FunctionSpan): unknown[] {
  const input = span.input as { args?: unknown } | null
  return Array.isArray(input?.args) ? input.args : [span.input]
}

function Argument({ value, index }: { value: unknown; index: number }) {
  if (typeof value === 'string') {
    return <pre className="rw-embedded">{value}</pre>
  }

  return <JsonBlock title={`Argument ${index + 1}`} value={readableValue(value)} />
}

function FailedSpan({ span }: { span: FunctionSpan }) {
  const { name, file } = nameOf(span)
  const error = errorOf(span)
  const args = argumentsOf(span)
  return (
    <div className="rw-span" data-span-name={name}>
      <p className="rw-span-head">
        <SquareFunction aria-hidden />
        <span>
          <code className="rw-mono">{name}</code> threw {error?.code ?? 'an error'}
          {span.worker ? ` in ${span.worker}` : ''}
        </span>
        {file ? <span className="rw-span-file">{file}</span> : null}
        <span className="rw-seq-duration">{duration(span.duration_ms)}</span>
      </p>
      {error ? <code className="rw-wrap rw-span-message">{error.message}</code> : null}
      <CollapsibleCard className="rw-collapse">
        <CollapsibleCardTrigger className="rw-collapse-trigger">
          <ChevronRight aria-hidden className="rw-collapse-caret" />
          <span>{args.length === 1 ? 'Input' : `Input (${args.length} arguments)`}</span>
        </CollapsibleCardTrigger>
        <CollapsibleCardContent>
          <div className="rw-details">
            {args.map((value, index) => (
              <Argument key={index} value={value} index={index} />
            ))}
          </div>
        </CollapsibleCardContent>
      </CollapsibleCard>
    </div>
  )
}

/** The functions that threw among `spans`, or nothing when none did. */
export function WhereItFailed({ spans }: { spans: FunctionSpan[] }) {
  const failed = spans.filter((s) => s.status === 'error' || errorOf(s))
  if (failed.length === 0) {
    return null
  }

  return (
    <section className="rw-block">
      <SectionHead title="Where it failed" />
      {failed.map((span) => (
        <FailedSpan key={span.id} span={span} />
      ))}
    </section>
  )
}

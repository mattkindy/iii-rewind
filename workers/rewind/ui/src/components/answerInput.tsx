/**
 * Where a person writes an answer. When the function declares a response
 * schema it is a form, with the raw JSON one tab away; otherwise it is the
 * JSON editor alone. Both tabs edit the same text: the form reads it each time
 * it draws and writes it back on every change, so the two never disagree.
 */
import { CodeEditor, SegmentedControl } from '@iii-dev/console-ui'
import type { ReactNode } from 'react'
import { isError, type LostFields, parseAnswerText } from '../model/answers'
import { prettyJson } from '../model/format'
import type { AnswerCheck } from '../model/schema'
import { SectionHead } from './bits'
import { SchemaForm } from './schemaForm'

export type AnswerMode = 'form' | 'json'

const MODES = [
  { value: 'form' as const, label: 'Form', icon: false as const },
  { value: 'json' as const, label: 'JSON', icon: false as const },
]

const NO_LOST: LostFields = {}

/** The form over the text, or why the text can't be one. */
function FormOverText({ text, onChange, check, lost }: { text: string; onChange: (text: string) => void; check: AnswerCheck; lost: LostFields }) {
  const parsed = parseAnswerText(text)
  if (!parsed.ok) {
    return <p className="rw-form-note">Invalid JSON · fix it in JSON</p>
  }

  if (isError(parsed.answer)) {
    return <p className="rw-form-note">Error answer · edit it in JSON</p>
  }

  return <SchemaForm check={check} value={parsed.answer.value} onChange={(next) => onChange(prettyJson(next))} lost={lost} />
}

export function AnswerInput({
  title,
  actions,
  text,
  onChange,
  check,
  mode,
  onMode,
  lost = NO_LOST,
  label,
}: {
  title: string
  actions?: ReactNode
  text: string
  onChange: (text: string) => void
  check?: AnswerCheck
  mode: AnswerMode
  onMode: (mode: AnswerMode) => void
  lost?: LostFields
  /** The JSON editor's accessible name. */
  label: string
}) {
  const json = (
    <div className="rw-editor-frame">
      <CodeEditor value={text} onChange={onChange} language="json" aria-label={label} autoFocus wordWrap />
    </div>
  )

  if (!check) {
    return (
      <>
        <SectionHead title={title}>{actions}</SectionHead>
        {json}
      </>
    )
  }

  return (
    <>
      <SectionHead title={title}>
        {actions}
        <SegmentedControl variant="tabs" value={mode} onChange={onMode} options={MODES} aria-label="Edit as" className="rw-mode" />
      </SectionHead>
      {mode === 'form' ? <FormOverText text={text} onChange={onChange} check={check} lost={lost} /> : json}
    </>
  )
}

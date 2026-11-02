/**
 * Edit answer and Change answer: the answer as JSON, or as a form when the
 * function has a response schema, with a one-click fix for cut-off JSON or
 * numbers sent as text, a verdict line, a diff against the recording, and
 * Fork. An answer that breaks the schema can still be forked, as "Fork
 * anyway", because seeing how the code copes with one is a reason to fork.
 * What the text means (whether it parses, changed, or breaks the schema) is
 * worked out by `draftState` in the model, which the run view also reads to
 * know whether Mod+Enter can fork.
 */
import { ActionLine, Button, FileDiff, KeyCombo, StatusPanel } from '@iii-dev/console-ui'
import { CircleAlert, CircleCheck, GitFork, TriangleAlert, WandSparkles } from 'lucide-react'
import { useState } from 'react'
import type { Answer, AnswerSource } from '../client/types'
import { answerText, applyFixes, applyFixesFor, draftState, type Finding, findings, isError, type LostFields, type ParsedAnswer } from '../model/answers'
import { prettyJson } from '../model/format'
import { type AnswerCheck, type Problem, problemsText } from '../model/schema'
import { type AnswerMode, AnswerInput } from './answerInput'
import { ButtonTip, SectionHead } from './bits'

function fixLabel(found: Finding[]): string {
  if (found.some((f) => f.kind === 'cut-json')) {
    return 'Close cut-off JSON'
  }

  return found.length === 1 ? `Make ${found[0].path} a number` : 'Make them numbers'
}

function forkLabel(busy: boolean, breaksSchema: boolean): string {
  if (busy) {
    return 'Forking…'
  }

  return breaksSchema ? 'Fork anyway' : 'Fork'
}

type Verdict = { tone: 'ok' | 'alert' | 'ghost'; text: string }

function verdictOf(parsed: ParsedAnswer, changed: boolean, source: AnswerSource, problems: Problem[]): Verdict {
  if (!parsed.ok) {
    return { tone: 'alert', text: `Invalid JSON (${parsed.message})` }
  }

  if (problems.length > 0) {
    return { tone: 'alert', text: problemsText(problems) }
  }

  if (!changed) {
    return { tone: 'ghost', text: source === 'recorded' ? 'Same as recorded' : 'Unchanged' }
  }

  return isError(parsed.answer) ? { tone: 'ok', text: 'Valid error' } : { tone: 'ok', text: 'Valid JSON' }
}

export function AnswerEditor({
  recorded,
  source = 'recorded',
  text,
  onChange,
  onFork,
  onCancel,
  busy,
  error,
  check,
}: {
  recorded: Answer
  /** Where the answer being changed came from, such as a live call in a fork. */
  source?: AnswerSource
  text: string
  onChange: (next: string) => void
  onFork: () => void
  onCancel: () => void
  busy: boolean
  error: string | null
  /** The function's response schema, which turns the editor into a form. */
  check?: AnswerCheck
}) {
  const { parsed, normalized, changed, problems, ready } = draftState(recorded, text, check)
  // With a schema, the schema says which strings should be numbers.
  const found = parsed.ok && !isError(parsed.answer) ? findings(parsed.answer).filter((f) => !check || f.kind === 'cut-json') : []
  const verdict = verdictOf(parsed, changed, source, problems)
  const VerdictIcon = verdict.tone === 'alert' ? CircleAlert : CircleCheck
  const [dropped, setDropped] = useState<string[]>([])
  const [lost, setLost] = useState<LostFields>({})
  const [mode, setMode] = useState<AnswerMode>('form')
  // The form marks each field a fix lost and each problem in place, so these lines are for the JSON.
  const inForm = Boolean(check) && mode === 'form'

  const applyFix = () => {
    if (!parsed.ok || isError(parsed.answer)) {
      return
    }

    const fixed = check ? applyFixesFor(parsed.answer.value, found, check) : { ...applyFixes(parsed.answer.value, found), lost: {} }
    setDropped(fixed.dropped.filter(Boolean))
    setLost(fixed.lost)
    onChange(prettyJson(fixed.value))
  }

  const breaksSchema = problems.length > 0
  const forkTip = breaksSchema ? `Breaks schema · ${problemsText(problems)}` : <>Fork <KeyCombo binding="Mod+Enter" /></>
  return (
    <section className="rw-editor" aria-label="Edit the answer">
      <AnswerInput
        title="Your answer"
        actions={
          found.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={applyFix}>
              <WandSparkles aria-hidden />
              {fixLabel(found)}
            </Button>
          ) : null
        }
        text={text}
        onChange={(next) => {
          // Once the person edits by hand, the note about what the fix left out has done its job.
          setDropped([])
          onChange(next)
        }}
        check={check}
        mode={mode}
        onMode={setMode}
        lost={lost}
        label="The answer as JSON"
      />
      {inForm && parsed.ok && problems.length > 0 ? null : (
        <p className="rw-verdict" data-tone={verdict.tone} role={verdict.tone === 'alert' ? 'alert' : undefined}>
          <VerdictIcon aria-hidden />
          <span>{verdict.text}</span>
        </p>
      )}
      {found
        .filter((finding) => !problems.some((p) => p.path === finding.path))
        .map((finding) => (
          <ActionLine key={finding.path} icon={<TriangleAlert aria-hidden />} tone="warn" className="rw-finding">
            {finding.title}
          </ActionLine>
        ))}
      {!inForm
        ? dropped.map((tail) => (
            <ActionLine key={tail} icon={<TriangleAlert aria-hidden />} tone="warn" className="rw-finding">
              Cut off: <code>{tail}</code> · dropped by the fix
            </ActionLine>
          ))
        : null}
      {changed ? (
        <section className="rw-block">
          <SectionHead title="Answer diff" />
          <div className="rw-diff">
            <FileDiff
              oldFile={{ name: `${source}.json`, contents: `${answerText(recorded)}\n` }}
              newFile={{ name: 'fork.json', contents: `${normalized}\n` }}
              diffStyle="unified"
              lineDiffType="word"
              disableFileHeader
              expandUnchanged
            />
          </div>
        </section>
      ) : null}
      {error ? <StatusPanel variant="alert" role="alert" headline="Fork failed" detail={error} /> : null}
      <div className="rw-actions">
        <ButtonTip tip={forkTip} disabled={!ready || busy}>
          <Button variant="primary" onClick={onFork} disabled={!ready || busy}>
            <GitFork aria-hidden />
            {forkLabel(busy, breaksSchema)}
          </Button>
        </ButtonTip>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </section>
  )
}

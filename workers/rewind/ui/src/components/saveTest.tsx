/**
 * Saving a finished fork as a regression test, then running it on the spot so
 * the person sees the fixture pass before trusting it. When a run of the test
 * fails because the code left the file behind, the result says at which call,
 * and for a call that sent another input, each field with what the test saved
 * and what the code sent, so the person can tell a regression from a change
 * they meant to make.
 */
import { Badge, Button, Input, StatusPanel } from '@iii-dev/console-ui'
import { FlaskConical, Play } from 'lucide-react'
import { useState } from 'react'
import type { SavedTest, TestResult } from '../client/types'
import { errorLabel } from '../model/answers'
import { plural } from '../model/format'
import { type Divergence, divergence, FIELDS_SHOWN, type ShownValue } from '../model/savedTests'

export type TestState = { saved: SavedTest | null; result: TestResult | null; busy: 'save' | 'run' | null; error: string | null }

export const NO_TEST: TestState = { saved: null, result: null, busy: null, error: null }

function divergenceOf(result: TestResult | null): Divergence | null {
  if (!result || result.pass || !result.diverged) {
    return null
  }

  return divergence(result.diverged)
}

function FieldValue({ value, missing }: { value: ShownValue; missing: string }) {
  if (!value) {
    return <span className="rw-test-missing">{missing}</span>
  }

  return (
    <code className="rw-test-value" title={value.full}>
      {value.short}
    </code>
  )
}

/**
 * What the code did at the call where the test diverged. The status panel
 * renders its detail as text, so the fields are spans laid out as a table.
 */
function DivergedDetail({ found }: { found: Divergence }) {
  const [all, setAll] = useState(false)
  const fields = all ? found.fields : found.fields.slice(0, FIELDS_SHOWN)
  const folded = found.fields.length - fields.length
  return (
    <span className="rw-test-diverged">
      <span>{found.headline}</span>
      <span className="rw-test-why">{found.detail}</span>
      {fields.length > 0 ? (
        <span className="rw-test-fields" role="table" aria-label="Fields the code sent differently">
          <span className="rw-test-row rw-test-head-row" role="row">
            <span role="columnheader">Field</span>
            <span role="columnheader">Test saved</span>
            <span role="columnheader">Code sent</span>
          </span>
          {fields.map((field) => (
            <span key={field.field} className="rw-test-row" role="row">
              <span className="rw-test-field" role="rowheader" title={field.field || undefined}>
                {field.field || 'Whole input'}
              </span>
              <span role="cell">
                <FieldValue value={field.saved} missing="Not saved" />
              </span>
              <span role="cell">
                <FieldValue value={field.sent} missing="Not sent" />
              </span>
            </span>
          ))}
        </span>
      ) : null}
      {folded > 0 ? (
        <Button variant="ghost" size="sm" className="rw-test-more" onClick={() => setAll(true)}>
          Show {plural(folded, 'more field')}
        </Button>
      ) : null}
    </span>
  )
}

/** What the fixture expects, as a noun phrase: `status booked`, the error's class for a run that throws, or `its output`. */
function expectation(saved: SavedTest): string {
  const expect = saved.fixture.expect
  if ('status' in expect) {
    return `status ${String(expect.status)}`
  }

  return 'throws' in expect ? errorLabel({ message: String(expect.throws) }) : 'its output'
}

function testDetail(saved: SavedTest, result: TestResult | null): string {
  if (!result) {
    return `Expects ${expectation(saved)}`
  }

  return result.pass ? `Expects ${expectation(saved)}` : `Expected ${expectation(saved)}`
}

function runLabel(busy: TestState['busy'], result: TestResult | null): string {
  if (busy === 'run') {
    return 'Running…'
  }

  return result ? 'Run again' : 'Run test'
}

export function SaveTest({
  state,
  defaultName,
  onSave,
  onRun,
  askName,
}: {
  state: TestState
  defaultName: string
  onSave: (name: string) => void
  onRun: () => void
  askName: boolean
}) {
  const [name, setName] = useState(defaultName)
  const { saved, result, busy, error } = state

  if (saved) {
    const diverged = divergenceOf(result)
    return (
      <div className="rw-test">
        <StatusPanel
          variant={result && !result.pass ? 'alert' : 'success'}
          icon={<FlaskConical aria-hidden />}
          headline={
            <span className="rw-test-head">
              Saved <code>{saved.path}</code>
              {result ? <Badge variant={result.pass ? 'ok' : 'alert'}>{result.pass ? 'Passed' : 'Failed'}</Badge> : null}
            </span>
          }
          detail={diverged ? <DivergedDetail key={result?.diverged?.seq} found={diverged} /> : testDetail(saved, result)}
          action={
            <Button variant="pill" size="sm" onClick={onRun} disabled={busy !== null}>
              <Play aria-hidden />
              {runLabel(busy, result)}
            </Button>
          }
        />
        {error ? <StatusPanel variant="alert" role="alert" headline="Test failed to run" detail={error} /> : null}
      </div>
    )
  }

  return (
    <div className="rw-test">
      <div className="rw-test-form">
        {askName ? <Input value={name} onChange={setName} aria-label="Test name" className="rw-test-name" spellCheck={false} /> : null}
        <Button variant="primary" onClick={() => onSave(name.trim() || defaultName)} disabled={busy !== null}>
          <FlaskConical aria-hidden />
          {busy === 'save' ? 'Saving…' : 'Save as test'}
        </Button>
        {askName ? <span className="rw-hint">Saves to tests/rewind/{name.trim() || defaultName}.json</span> : null}
      </div>
      {error ? <StatusPanel variant="alert" role="alert" headline="Save failed" detail={error} /> : null}
    </div>
  )
}

/**
 * Saving a finished fork as a regression test, then running it on the spot so
 * the person sees the fixture pass before trusting it.
 */
import { Badge, Button, Input, StatusPanel } from '@iii-dev/console-ui'
import { FlaskConical, Play } from 'lucide-react'
import { useState } from 'react'
import type { SavedTest, TestResult } from '../client/types'
import { errorLabel } from '../model/answers'

export type TestState = { saved: SavedTest | null; result: TestResult | null; busy: 'save' | 'run' | null; error: string | null }

export const NO_TEST: TestState = { saved: null, result: null, busy: null, error: null }

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
          detail={testDetail(saved, result)}
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

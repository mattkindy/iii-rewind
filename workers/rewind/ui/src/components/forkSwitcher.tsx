/**
 * Moving between the original and the forks a person made, and what a replay
 * found. The switcher appears only once a fork exists; the branch graph is a
 * toggle on it. A replay with no edit is a result on the original, so it shows
 * as one line of outcome instead of a branch.
 */
import { Button, IconButton, SegmentedControl, StatusPanel } from '@iii-dev/console-ui'
import { FlaskConical, GitBranch, GitCompareArrows, Play, Route } from 'lucide-react'
import { changedAtLabel, versionLabel } from '../model/code'
import { outcomeJson } from '../model/compare'
import { prettyJson } from '../model/format'
import { type Line, ordinal } from '../model/lines'
import { callName } from '../model/requests'
import { outcomeLook } from '../model/outcomes'
import { SaveTest, type TestState } from './saveTest'

export const COMPARE = 'compare'

export function ForkSwitcher({
  lines,
  current,
  comparing,
  onPick,
  onCompare,
  graphShown,
  onToggleGraph,
}: {
  lines: Line[]
  current: Line
  comparing: boolean
  onPick: (lineId: string) => void
  onCompare: () => void
  graphShown: boolean
  onToggleGraph: () => void
}) {
  const options = lines.map((line) => ({
    value: line.id,
    label: (
      <span className="rw-switch-label">
        {line.label}
        <span className="rw-switch-outcome" data-tone={outcomeLook(line.outcome).tone}>
          {outcomeLook(line.outcome).short}
        </span>
      </span>
    ),
    icon: false as const,
  }))
  const canCompare = current.kind !== 'original'
  return (
    <div className="rw-switcher">
      <SegmentedControl
        variant="tabs"
        aria-label="The original and your forks"
        value={comparing ? COMPARE : current.id}
        onChange={(next) => (next === COMPARE ? onCompare() : onPick(next))}
        options={canCompare ? [...options, { value: COMPARE, label: 'Compare', icon: false as const }] : options}
      />
      <IconButton label={graphShown ? 'Hide branch graph' : 'Show branch graph'} aria-pressed={graphShown} onClick={onToggleGraph}>
        <GitBranch aria-hidden />
      </IconButton>
    </div>
  )
}

function sameEnding(a: Line, b: Line): boolean {
  return prettyJson(outcomeJson(a.outcome)) === prettyJson(outcomeJson(b.outcome))
}

/** What the latest replay found, said against the recording. A replay that ends differently can be kept as a test. */
export function ReplayResult({
  replay,
  original,
  onOpen,
  onCompare,
  test,
  defaultName,
  onSave,
  onRun,
}: {
  replay: Line
  original: Line
  onOpen: () => void
  onCompare: () => void
  test: TestState
  defaultName: string
  onSave: (name: string) => void
  onRun: () => void
}) {
  const code = replay.fork?.code
  // Which code the replay ran, on every result, since the headline leaves it out.
  const ran = code ? `Code ${versionLabel(code)} · changed ${changedAtLabel(code)}` : undefined
  if (replay.outcome.state === 'paused') {
    const need = replay.outcome.need
    const at = ordinal(replay, need.seq)
    return (
      <StatusPanel
        variant="info"
        icon={<Route aria-hidden />}
        headline={`Replay diverged at call ${at} · ${callName(need.function_id)}`}
        detail={ran}
        action={
          <Button variant="pill" size="sm" onClick={onOpen}>
            Open replay
          </Button>
        }
      />
    )
  }

  const allRecorded = replay.calls.every((c) => c.source === 'recorded')
  if (allRecorded && sameEnding(replay, original)) {
    return <StatusPanel variant="info" icon={<Play aria-hidden />} headline={`Reproduced · ${outcomeLook(replay.outcome).phrase}`} detail={ran} />
  }

  return (
    <div className="rw-banner">
      <StatusPanel
        variant={outcomeLook(replay.outcome).tone === 'success' ? 'success' : 'warn'}
        icon={<Play aria-hidden />}
        headline={`Replay ${outcomeLook(replay.outcome).phrase} · recording ${outcomeLook(original.outcome).phrase}`}
        detail={ran}
        action={
          <span className="rw-banner-actions">
            <Button variant="pill" size="sm" onClick={onCompare}>
              <GitCompareArrows aria-hidden />
              Compare
            </Button>
            {test.saved ? null : (
              <Button variant="primary" size="sm" onClick={() => onSave(defaultName)} disabled={test.busy !== null}>
                <FlaskConical aria-hidden />
                {test.busy === 'save' ? 'Saving…' : 'Save as test'}
              </Button>
            )}
          </span>
        }
      />
      {test.saved || test.error ? <SaveTest state={test} defaultName={defaultName} onSave={onSave} onRun={onRun} askName={false} /> : null}
    </div>
  )
}

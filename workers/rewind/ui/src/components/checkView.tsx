/**
 * A check of runs against the current code, in two passes.
 *
 * The first pass gives every call its recorded answer. A fix that changes the
 * code's path makes runs reach a call the recording does not have. That is
 * expected, so the page says the run diverges and keeps it neutral. When runs
 * diverged, the page offers a second pass that runs those calls live where their
 * effects allow and fills irreversible ones from another run's recorded
 * success. That pass reads as outcomes: how many now succeed and how many
 * still fail, with the failing runs first so they are one click away.
 */
import { Button, Chip, type ChipTone, Eyebrow, List, ListItem, StatusDot, StatusPanel, uiClasses } from '@iii-dev/console-ui'
import { ChevronRight, LoaderCircle, Radio, Route } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { CheckResult, ForkOutcome, FunctionRow } from '../client/types'
import type { CheckItem, CheckPass, CheckRun, PassKind } from '../data/useCheck'
import { outputReply } from '../model/appOutput'
import { changedAtLabel, versionLabel } from '../model/code'
import { errorDetail, plural, requestText, shortId, truncate } from '../model/format'
import { outcomeLook, outcomeTally } from '../model/outcomes'
import { callName } from '../model/requests'
import type { TriageRow } from '../model/signatures'

type Dot = 'ink' | 'ok' | 'warn' | 'alert'

type ResultLook = { label: string; tone: ChipTone; dot: Dot }

const RECORDED_RESULTS: Record<CheckResult['result'], ResultLook> = {
  same: { label: 'Same as recorded', tone: 'neutral', dot: 'ink' },
  different: { label: 'Ends differently', tone: 'accent', dot: 'ok' },
  stopped: { label: 'Diverges', tone: 'neutral', dot: 'ink' },
}

function isFixed(result: CheckResult): boolean {
  return result.outcome.state !== 'paused' && outcomeLook(result.outcome).tone === 'success'
}

function liveLook(result: CheckResult): ResultLook {
  if (result.outcome.state === 'paused') {
    return { label: 'Paused', tone: 'warning', dot: 'warn' }
  }

  return isFixed(result) ? { label: 'Fixed', tone: 'success', dot: 'ok' } : { label: 'Fails', tone: 'danger', dot: 'alert' }
}

function doneResults(pass: CheckPass): CheckResult[] {
  return pass.items.flatMap((item) => (item.result ? [item.result] : []))
}

function callNumber(seq: number): number {
  return seq + 1
}

/** Every run stopped at the same new call: the usual result of a fix, said as what it means. */
function sharedNewPath(results: CheckResult[]): CheckResult['stopped_at'] | undefined {
  const first = results[0]?.stopped_at
  const all = results.length > 0 && results.every((r) => r.result === 'stopped' && r.stopped_at?.seq === first?.seq && r.stopped_at?.function_id === first?.function_id)
  return all ? first : undefined
}

function recordedSummary(results: CheckResult[], total: number): string {
  const shared = sharedNewPath(results)
  if (shared && results.length === total) {
    const who = total === 1 ? 'Diverges' : `All ${total} diverge`
    return `${who} at call ${callNumber(shared.seq)} · ${callName(shared.function_id)}`
  }

  const count = (result: CheckResult['result']) => results.filter((r) => r.result === result).length
  const parts = [
    count('same') ? `${count('same')} same as recorded` : '',
    count('different') ? `${count('different')} end differently` : '',
    count('stopped') ? `${count('stopped')} diverge` : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'No results'
}

/** What a live pass will do, from the effects each function declares. */
function liveExplanation(functions: FunctionRow[], entry: string): string {
  const external = functions.filter((f) => f.function_id !== entry && f.effects.includes('external') && !f.effects.includes('irreversible'))
  const irreversible = functions.filter((f) => f.effects.includes('irreversible'))
  const live = `Live: ${[...external.map((f) => f.function_id), 'read-only calls'].join(', ')}`
  if (irreversible.length === 0) {
    return live
  }

  const filled = irreversible.length === 1 ? 'filled from another run' : 'each filled from another run'
  return `${live} · ${irreversible.map((f) => f.function_id).join(', ')} not sent · ${filled}`
}

function endingText(result: CheckResult): string {
  const outcome = result.outcome
  if (outcome.state === 'paused') {
    return `Paused at call ${callNumber(outcome.need.seq)} · ${callName(outcome.need.function_id)} · no answer`
  }

  const look = outcomeLook(outcome)
  if (outcome.state === 'crashed') {
    return `${look.short} · ${truncate(errorDetail(outcome.error.message), 90)}`
  }

  // A run that returned a failure says why in its reply, which is where a second bug shows up.
  const reply = outputReply(outcome.output)
  return look.tone !== 'success' && reply !== undefined ? `${look.short} · “${truncate(reply, 110)}”` : look.short
}

function liveNote(result: CheckResult): string {
  const live = result.live_calls ? `${plural(result.live_calls, 'call')} live` : ''
  const filled = (result.filled ?? []).map((f) => `${callName(f.function_id)} from run ${shortId(f.from_run_id)}`)
  return [live, ...filled].filter(Boolean).join(' · ')
}

const DESCRIBE: Record<PassKind, (result: CheckResult) => string> = {
  recorded: (r) => {
    const lines: Record<CheckResult['result'], () => string> = {
      same: () => `Same · ${outcomeLook(r.outcome).phrase}`,
      different: () => `${outcomeLook(r.recorded).short} → ${outcomeLook(r.outcome).phrase}`,
      stopped: () => `Diverges at call ${callNumber(r.stopped_at?.seq ?? 0)} · ${r.stopped_at ? callName(r.stopped_at.function_id) : 'a call'}`,
    }
    return lines[r.result]()
  },
  live: (r) => [endingText(r), liveNote(r)].filter(Boolean).join(' · '),
}

const LOOK: Record<PassKind, (result: CheckResult) => ResultLook> = {
  recorded: (r) => RECORDED_RESULTS[r.result],
  live: liveLook,
}

function Rows({ items, kind, runs, onOpen }: { items: CheckItem[]; kind: PassKind; runs: TriageRow[]; onOpen: (runId: string, kind: PassKind) => void }) {
  const byId = new Map(runs.map((r) => [r.run_id, r]))
  return (
    <List aria-label="Checked runs">
      {items.map((item) => {
        const run = byId.get(item.run_id)
        const look = item.result ? LOOK[kind](item.result) : null
        return (
          <ListItem
            key={item.run_id}
            className="rw-landing-row"
            leading={look ? <StatusDot tone={look.dot} /> : <StatusDot tone="ink" />}
            label={<span className="rw-run-label">{run ? requestText(run.input) : shortId(item.run_id)}</span>}
            description={item.result ? DESCRIBE[kind](item.result) : `Not run · ${item.error ?? 'no reason given'}`}
            trailing={
              look ? (
                <span className="rw-landing-trailing">
                  <Chip tone={look.tone} className="rw-chip">
                    {look.label}
                  </Chip>
                  <ChevronRight aria-hidden />
                </span>
              ) : undefined
            }
            disabled={!item.result}
            onClick={() => onOpen(item.run_id, kind)}
          />
        )
      })}
    </List>
  )
}

function Progress({ pass }: { pass: CheckPass }) {
  const done = pass.items.filter((i) => i.state !== 'waiting').length
  return (
    <StatusPanel
      variant="info"
      role="status"
      icon={<LoaderCircle aria-hidden className={uiClasses.spin} />}
      headline={`Checked ${done}/${plural(pass.items.length, 'run')}`}
    />
  )
}

// Runs that changed are the ones to open, so they come before the ones that ended the same.
const RECORDED_ORDER: Record<CheckResult['result'], number> = { different: 0, stopped: 1, same: 2 }

function RecordedPass({ check, runs, onOpen, offer }: { check: CheckRun; runs: TriageRow[]; onOpen: (runId: string, kind: PassKind) => void; offer: ReactNode }) {
  const pass = check.recorded
  const results = doneResults(pass)
  const uniform = Boolean(sharedNewPath(results)) && results.length === pass.items.length
  // Rows that all say the same thing add nothing, so they wait behind a button:
  // runs that ended as recorded, and the new path rows once the summary says it all.
  const [showRows, setShowRows] = useState(false)
  const [showSame, setShowSame] = useState(false)
  const rowsShown = !uniform && !check.live ? true : showRows
  const order = (item: CheckItem) => (item.result ? RECORDED_ORDER[item.result.result] : 3)
  const sorted = [...pass.items].sort((a, b) => order(a) - order(b))
  const same = sorted.filter((item) => item.result?.result === 'same')
  const changed = sorted.filter((item) => item.result?.result !== 'same')

  if (!pass.finished) {
    return <Progress pass={pass} />
  }

  return (
    <section className="rw-landing-section">
      <Eyebrow as="h3">Recorded answers</Eyebrow>
      {pass.error ? (
        <StatusPanel variant="alert" role="alert" headline="Check failed" detail={pass.error} />
      ) : (
        <StatusPanel variant="info" icon={<Route aria-hidden />} headline={recordedSummary(results, pass.items.length)} />
      )}
      {offer}
      {rowsShown && changed.length > 0 ? <Rows items={changed} kind="recorded" runs={runs} onOpen={onOpen} /> : null}
      {showSame ? <Rows items={same} kind="recorded" runs={runs} onOpen={onOpen} /> : null}
      <div className="rw-landing-actions">
        {changed.length > 0 && (uniform || check.live) ? (
          <Button variant="ghost" size="sm" onClick={() => setShowRows((shown) => !shown)}>
            {showRows ? 'Hide runs' : `Show ${plural(changed.length, 'run')}`}
          </Button>
        ) : null}
        {same.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setShowSame((shown) => !shown)}>
            {showSame ? 'Hide unchanged' : `Show ${same.length} unchanged`}
          </Button>
        ) : null}
      </div>
    </section>
  )
}

function LivePass({ pass, runs, onOpen }: { pass: CheckPass; runs: TriageRow[]; onOpen: (runId: string, kind: PassKind) => void }) {
  if (!pass.finished) {
    return <Progress pass={pass} />
  }

  const results = doneResults(pass)
  const fixed = results.filter(isFixed).length
  // The runs that still fail are the ones a person opens next, so they come first.
  const order = (item: CheckItem) => (item.result && isFixed(item.result) ? 1 : 0)
  const items = [...pass.items].sort((a, b) => order(a) - order(b))
  return (
    <section className="rw-landing-section">
      <Eyebrow as="h3">Live calls</Eyebrow>
      {pass.error ? (
        <StatusPanel variant="alert" role="alert" headline="Live check failed" detail={pass.error} />
      ) : (
        <StatusPanel
          variant={fixed === pass.items.length ? 'success' : 'warn'}
          icon={<Radio aria-hidden />}
          headline={[`${fixed}/${pass.items.length} fixed`, outcomeTally(results.map((r) => r.outcome))].filter(Boolean).join(' · ')}
        />
      )}
      <Rows items={items} kind="live" runs={runs} onOpen={onOpen} />
    </section>
  )
}

/** Why a live check ended a run as it did: the error it threw, or the agent's reply when it did not succeed. */
function checkNoteWhy(outcome: ForkOutcome, fixed: boolean): string {
  if (outcome.state === 'crashed') {
    return errorDetail(outcome.error.message)
  }

  const reply = outcome.state === 'done' ? outputReply(outcome.output) : undefined
  return reply !== undefined && !fixed ? `“${reply}”` : ''
}

/** On a run opened from the live pass: how the check ended it, since a check is not kept as a fork. */
export function CheckNote({ result }: { result: CheckResult }) {
  const look = liveLook(result)
  const outcome = result.outcome
  const ended = outcome.state === 'paused' ? `paused at ${outcome.need.function_id}` : outcomeLook(outcome).phrase
  const why = checkNoteWhy(result.outcome, look.dot === 'ok')
  const detail = [why, liveNote(result)].filter(Boolean).join(' · ')
  return (
    <StatusPanel
      variant={look.dot === 'ok' ? 'success' : 'warn'}
      icon={<Radio aria-hidden />}
      headline={`Live check · ${ended}`}
      detail={detail || undefined}
    />
  )
}

export function CheckView({
  check,
  runs,
  functions,
  entry,
  onOpen,
  onRunLive,
}: {
  check: CheckRun
  runs: TriageRow[]
  functions: FunctionRow[]
  entry: string
  onOpen: (runId: string, kind: PassKind) => void
  onRunLive: () => void
}) {
  const recorded = doneResults(check.recorded)
  const offerLive = check.recorded.finished && !check.live && recorded.some((r) => r.result === 'stopped')

  return (
    <div className="rw-scroll">
      <div className="rw-level">
        <header className="rw-level-head">
          <h2>{check.title}</h2>
          {check.code ? (
            <p>
              Code {versionLabel(check.code)} · changed {changedAtLabel(check.code)}
            </p>
          ) : null}
        </header>
        <RecordedPass
          check={check}
          runs={runs}
          onOpen={onOpen}
          offer={
            offerLive ? (
              <div className="rw-live-offer">
                <p className="rw-step-text">{liveExplanation(functions, entry)}</p>
                <div className="rw-actions">
                  <Button variant="primary" onClick={onRunLive}>
                    <Radio aria-hidden />
                    Run new calls live
                  </Button>
                </div>
              </div>
            ) : null
          }
        />
        {check.live ? <LivePass pass={check.live} runs={runs} onOpen={onOpen} /> : null}
      </div>
    </div>
  )
}

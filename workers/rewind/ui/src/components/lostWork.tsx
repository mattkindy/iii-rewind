/**
 * The runs one dead worker cut off at one time. Recovering one replays what
 * finished, runs read-only and external calls live, and stops before anything
 * else, so "Recover all" finishes the safe runs in one step. The runs left
 * waiting split into calls lost mid-call, which the provider may have, and
 * calls that never went out, because the recovery reached them afterwards
 * or their worker was already gone when the run made them. Each group
 * gets one decision, which the page applies to one run after another with
 * `rewind::answer`. It goes on past a run that fails and lists the failures
 * with a retry at the end. A run that pauses again joins the group it now
 * belongs to.
 */
import { Button, type ConfirmOptions, Eyebrow, List, ListItem, StatusDot, StatusPanel, useConfirm } from '@iii-dev/console-ui'
import { errorMessage } from '@iii-dev/console-ui/format'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { Fork, ForkOutcome, LostRun, RunRow } from '../client/types'
import { BATCH_PARALLEL, type Batch, type BatchEntry, type BatchStep, newBatch, recoveryStep, skippedOutcome, withStep } from '../model/batch'
import { clockTime, plural, requestText, shortId } from '../model/format'
import { type Incident, incidentHeadline, type LostState, lostState, RECOVER_LINE } from '../model/lost'
import { callName } from '../model/requests'
import { byKind, GROUP_CHOICES, type GroupApply, type GroupChoice, type WaitingGroup, type WaitingRun, waitingGroups } from '../model/waiting'
import { BatchProgress } from './batchProgress'
import { outcomeTally } from '../model/outcomes'
import { RecoverButton } from './bits'
import { type GroupDecision, WaitingGroupPanel } from './waitingGroup'

const STATE_TONE: Record<LostState, 'warn' | 'ink' | 'ok'> = { waiting: 'warn', open: 'ink', done: 'ok', skipped: 'ink' }

// Waiting runs are in their groups' decisions instead of a list of their own.
const SECTIONS: { state: LostState; title: string }[] = [
  { state: 'open', title: 'Open' },
  { state: 'done', title: 'Recovered' },
  { state: 'skipped', title: 'Skipped' },
]

const CONFIRM: Partial<Record<GroupChoice, (count: number) => ConfirmOptions>> = {
  resend: (n) => ({ title: 'Resend all?', description: `Resend ${n} · up to ${plural(n, 'duplicate')}`, confirmLabel: 'Resend', tone: 'danger' }),
  skip: (n) => ({ title: 'Skip all?', description: `Discards ${plural(n, 'recovery', 'recoveries')} · nothing is sent`, confirmLabel: 'Skip', tone: 'danger' }),
}

type Failure = { waiting: WaitingRun; error: string }

type BatchResult = { decision: GroupDecision; apply: GroupApply; total: number; outcomes: ForkOutcome[]; failures: Failure[] }

/** The batch running now. `key` is Recover all's or the group's, and `group` is the group as it was when its batch started. */
type Active = { key: string; batch: Batch; group?: WaitingGroup }

const RECOVER_ALL = 'recover-all'

/** One run's place in a batch, and the call that takes its turn. */
type Turn = { entry: Omit<BatchEntry, keyof BatchStep>; take: () => Promise<Fork> }

/** How one run's turn in a batch ended. */
type Settled = { runId: string; outcome: ForkOutcome } | { runId: string; error: string }

/** "3/3 marked sent · 2 booked, 1 paused at email::send". A skipped run has no outcome to count. */
function resultLine(result: BatchResult): string {
  const answered = `${result.total - result.failures.length}/${result.total} ${result.apply.done}`
  const ended = result.outcomes.filter((o) => !skippedOutcome(o))
  return [answered, outcomeTally(ended)].filter(Boolean).join(' · ')
}

function BatchOutcome({ result, busy, onRetry }: { result: BatchResult; busy: boolean; onRetry: () => void }) {
  const failed = result.failures.length
  return (
    <StatusPanel
      variant={failed > 0 ? 'warn' : 'success'}
      role="status"
      headline={resultLine(result)}
      detail={
        failed > 0 ? (
          <ul className="rw-failures">
            {result.failures.map((failure) => (
              <li key={failure.waiting.run.run_id}>
                <span>{requestText(failure.waiting.run.input)}</span>
                <span className="rw-mono">{failure.error}</span>
              </li>
            ))}
          </ul>
        ) : undefined
      }
      action={
        failed > 0 ? (
          <Button variant="pill" size="sm" onClick={onRetry} disabled={busy}>
            Retry {failed}
          </Button>
        ) : undefined
      }
    />
  )
}

/** `moved` marks a run a batch finished while the page was open, so it rises into the list it moved to. */
function LostRunRow({ run, state, moved, onOpen }: { run: LostRun; state: LostState; moved: boolean; onOpen: () => void }) {
  const need = run.recovery?.outcome.state === 'paused' ? run.recovery.outcome.need : undefined
  return (
    <ListItem
      className="rw-landing-row"
      data-new={moved || undefined}
      leading={<StatusDot tone={STATE_TONE[state]} />}
      label={<span className="rw-run-label">{requestText(run.input)}</span>}
      description={
        <span className="rw-run-meta">
          {shortId(run.run_id)} · stopped {clockTime(run.started_at_ms + run.duration_ms)}
          {need ? ` · waiting at ${need.function_id}` : ''}
        </span>
      }
      trailing={<ChevronRight aria-hidden />}
      onClick={onOpen}
    />
  )
}

/** One slot per group: the group being applied as it was when it started, else the group now, else only its last result. */
function groupSlots(live: WaitingGroup[], applying: WaitingGroup | undefined, results: Record<string, BatchResult>): WaitingGroup[] {
  const slots = new Map<string, WaitingGroup>()
  for (const group of [...Object.values(results).map((r) => r.decision.group), ...live, ...(applying ? [applying] : [])]) {
    slots.set(group.key, group)
  }

  return [...slots.values()].sort(byKind)
}

export function LostWork({
  client,
  incident,
  runs,
  skipped,
  onSkipped,
  onOpen,
  onChanged,
  announce,
}: {
  client: RewindClient
  incident: Incident
  /** Recorded runs, newest first, where Mark all sent finds its result. */
  runs: RunRow[]
  /** Runs someone skipped while the page is open. */
  skipped: ReadonlySet<string>
  onSkipped: (runIds: string[]) => void
  onOpen: (runId: string) => void
  onChanged: () => void
  announce: (text: string) => void
}) {
  const { confirm, dialog } = useConfirm()
  const [active, setActive] = useState<Active | null>(null)
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, BatchResult>>({})
  const busy = active !== null
  const lost = incident.runs
  const open = lost.filter((l) => lostState(l, skipped) === 'open')
  const groups = waitingGroups(lost)

  /**
   * Takes the runs' turns a few at a time, starting them in the order they appear, and shows
   * each one's progress. The page reloads after every run, so a finished run moves to its new
   * list at once. The results come back in the order of `turns`.
   */
  const runBatch = async (key: string, verb: string, turns: Turn[], group?: WaitingGroup): Promise<Settled[]> => {
    const step = (runId: string, next: BatchStep) => setActive((now) => (now?.key === key ? { ...now, batch: withStep(now.batch, runId, next) } : now))
    setActive({ key, batch: newBatch(verb, turns.map((t) => t.entry)), group })
    const settled: Settled[] = new Array(turns.length)
    let next = 0

    const takeTurns = async () => {
      while (next < turns.length) {
        const at = next++
        const { entry, take } = turns[at]
        settled[at] = await takeTurn(entry.runId, take, step)
        onChanged()
      }
    }

    await Promise.all(Array.from({ length: Math.min(BATCH_PARALLEL, turns.length) }, takeTurns))
    setActive(null)
    return settled
  }

  const takeTurn = async (runId: string, take: Turn['take'], step: (runId: string, next: BatchStep) => void): Promise<Settled> => {
    step(runId, { state: 'running', startedAt: Date.now() })
    try {
      const { outcome } = await take()
      step(runId, { state: 'landed', outcome })
      setMoved((before) => new Set([...before, runId]))
      return { runId, outcome }
    } catch (e) {
      const message = errorMessage(e)
      step(runId, { state: 'failed', error: message })
      return { runId, error: message }
    }
  }

  const recoverAll = async () => {
    setError(null)
    const turns = open.map((run) => ({ entry: { runId: run.run_id, request: requestText(run.input), doing: recoveryStep(run) }, take: () => client.recover(run.run_id) }))
    const settled = await runBatch(RECOVER_ALL, 'Recovering', turns)
    const failed = settled.flatMap((s) => ('error' in s ? [s.error] : []))
    if (failed.length > 0) {
      setError(failed.at(-1) ?? null)
    }

    announce('Safe runs recovered')
  }

  /** Applies one decision to every run in its group, or on a retry to the runs that failed in `retry`. */
  const applyDecision = async (decision: GroupDecision, retry?: BatchResult) => {
    const only = retry ? retry.failures.map((f) => f.waiting) : decision.group.runs
    const apply = GROUP_CHOICES[decision.choice].apply
    if (!apply || only.length === 0) {
      return
    }

    const ask = CONFIRM[decision.choice]
    if (ask && !(await confirm(ask(only.length)))) {
      return
    }

    const doing = apply.step(callName(decision.group.functionId))
    const turns = only.map((w) => ({
      entry: { runId: w.run.run_id, request: requestText(w.run.input), doing },
      take: () => client.answer({ fork_id: w.forkId, choice: apply.answer, value: decision.value }),
    }))
    const settled = await runBatch(decision.group.key, apply.doing, turns, { ...decision.group, runs: only })
    const outcomes = settled.flatMap((s) => ('outcome' in s ? [s.outcome] : []))
    const failures: Failure[] = only.flatMap((waiting) => {
      const ended = settled.find((s) => s.runId === waiting.run.run_id)
      return ended && 'error' in ended ? [{ waiting, error: ended.error }] : []
    })

    if (decision.choice === 'skip') {
      onSkipped(only.filter((w) => !failures.some((f) => f.waiting === w)).map((w) => w.run.run_id))
    }

    // A retry adds to the group's result, so it still counts every run the decision was for.
    const result: BatchResult = retry ? { ...retry, outcomes: [...retry.outcomes, ...outcomes], failures } : { decision, apply, total: only.length, outcomes, failures }
    setResults((prev) => ({ ...prev, [decision.group.key]: result }))
    announce(resultLine(result))
  }

  const liveGroup = (key: string) => groups.find((g) => g.key === key)

  return (
    <div className="rw-run">
      {dialog}
      <div className="rw-scroll">
        <div className="rw-level">
          <header className="rw-level-head">
            <h2>{incidentHeadline(incident)}</h2>
            <p>{RECOVER_LINE}</p>
            {open.length > 0 ? (
              <div className="rw-actions">
                <RecoverButton variant="primary" onClick={() => void recoverAll()} disabled={busy} lineShown>
                  Recover all {active?.key === RECOVER_ALL ? active.batch.entries.length : open.length}
                </RecoverButton>
              </div>
            ) : null}
          </header>
          {active?.key === RECOVER_ALL ? <BatchProgress batch={active.batch} label="Runs being recovered" /> : null}
          {error ? <StatusPanel variant="alert" role="alert" headline="Recovery failed to start" detail={error} /> : null}
          {groupSlots(groups, active?.group, results).map((slot) => {
            const result = results[slot.key]
            const group = liveGroup(slot.key)
            // While its decision runs, a group shows the runs going through instead of the choice.
            if (active?.key === slot.key) {
              return (
                <div key={slot.key} className="rw-group-slot">
                  <BatchProgress batch={active.batch} label={`${active.batch.entries.length} runs being decided`} />
                </div>
              )
            }

            return (
              <div key={slot.key} className="rw-group-slot">
                {result ? (
                  <BatchOutcome
                    result={result}
                    busy={busy}
                    onRetry={() => void applyDecision(result.decision, result)}
                  />
                ) : null}
                {group ? (
                  <WaitingGroupPanel
                    client={client}
                    group={group}
                    runs={runs}
                    busy={busy}
                    onApply={(decision) => void applyDecision(decision)}
                    perRun={
                      <List aria-label={`${group.runs.length} waiting runs`}>
                        {group.runs.map((w) => (
                          <LostRunRow key={w.run.run_id} run={w.run} state="waiting" moved={moved.has(w.run.run_id)} onOpen={() => onOpen(w.run.run_id)} />
                        ))}
                      </List>
                    }
                  />
                ) : null}
              </div>
            )
          })}
          {SECTIONS.map((section) => {
            const rows = lost.filter((l) => lostState(l, skipped) === section.state)
            // Recover all lists the open runs in its progress, so they are not listed twice.
            const recovering = section.state === 'open' && active?.key === RECOVER_ALL
            if (rows.length === 0 || recovering) {
              return null
            }

            return (
              <section key={section.state} className="rw-landing-section">
                <Eyebrow as="h3">
                  {section.title} · {rows.length}
                </Eyebrow>
                <List aria-label={section.title}>
                  {rows.map((run) => (
                    <LostRunRow key={run.run_id} run={run} state={section.state} moved={moved.has(run.run_id)} onOpen={() => onOpen(run.run_id)} />
                  ))}
                </List>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

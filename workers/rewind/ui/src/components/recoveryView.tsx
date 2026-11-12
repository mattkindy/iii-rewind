/**
 * Runs a dead worker cut off, and how to finish them. Each run reads top to
 * bottom: what finished before the stop, what was cut off, what Rewind ran
 * live, and what is waiting for a person. Recovery is a fork in recover mode,
 * so the decision panel is the same one the debugger uses, with recovery copy.
 */
import { type BreadcrumbItem, Button, Chip, type PageCommandsApi, StatusPanel, useConfirm } from '@iii-dev/console-ui'
import { CircleCheck, Diamond, History, LifeBuoy, Radio, SquarePen, Unplug } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { Call, Choice, Fork, FunctionRow, LostRun, RunRow } from '../client/types'
import { useAnswerTemplate } from '../data/useAnswerTemplate'
import { useForkActions } from '../data/useForkActions'
import type { LoadedRun } from '../data/useRunDetail'
import { summarizeAnswer } from '../model/answers'
import { defaultChoice } from '../model/choices'
import { type DecisionState, typedIsValid } from '../model/decision'
import { plural } from '../model/format'
import { type Lane, laneOf, lanesOfLines } from '../model/lanes'
import { buildLines, type Line } from '../model/lines'
import { type LostKind, type LostState, lostMark, recoveryState, stoppedFunction } from '../model/lost'
import { outcomeLook } from '../model/outcomes'
import { callName, callUrl } from '../model/requests'
import { answerCheck, formatsOf } from '../model/schema'
import { RecoverButton, SourceChip, Step, WorkerGlyph } from './bits'
import { DecisionPanel } from './decisionPanel'
import { LevelBar } from './levelBar'
import { RECOVERY_COMMANDS } from './runCommands'
import { RunMasthead } from './runMasthead'
import { RunProgress } from './runProgress'
import { usePageCommands } from './usePageCommands'

const STATE_CHIP: Record<LostState, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  waiting: { label: 'Waiting for you', tone: 'warning' },
  open: { label: 'Not recovered', tone: 'neutral' },
  done: { label: 'Recovered', tone: 'success' },
  skipped: { label: 'Skipped', tone: 'neutral' },
}

function CallRows({ calls, laneFor }: { calls: Call[]; laneFor: (functionId: string, worker?: string) => Lane }) {
  return (
    <ul className="rw-call-rows">
      {calls.map((call) => (
        <li key={call.seq} className="rw-call-row">
          <WorkerGlyph lane={laneFor(call.function_id, call.worker)} />
          <span className="rw-mono rw-call-fn" title={callUrl(call.function_id)}>
            {callName(call.function_id)}
          </span>
          <span className="rw-call-summary">{summarizeAnswer(call.answer)}</span>
          {call.source !== 'recorded' ? <SourceChip source={call.source} /> : null}
        </li>
      ))}
    </ul>
  )
}

/** Which function the lost call went to: what the recovery called there, or failing that what the run's output says. */
function lostFunction(recovery: Line | undefined, lost: LostRun): string | undefined {
  const next = recovery?.calls.find((c) => c.seq === lost.lost_at)
  if (next) {
    return next.function_id
  }

  if (recovery?.outcome.state === 'paused' && recovery.outcome.need.seq === lost.lost_at) {
    return recovery.outcome.need.function_id
  }

  return stoppedFunction(lost)
}

const CUT_OFF: Record<LostKind, (finished: string, at: string | undefined) => string> = {
  'mid-call': (finished, at) => (at ? `Interrupted at ${at} after ${finished}` : `Interrupted after ${finished}`),
  'not-found': (finished, at) => `${at ?? 'A call'} not found after ${finished} · worker was down`,
}

function cutOffText(kind: LostKind, finishedCount: number, at: string | undefined): string {
  return CUT_OFF[kind](plural(finishedCount, 'call'), at)
}

export function RecoveryWorkspace({
  client,
  lost,
  loaded,
  functions,
  entry,
  runs,
  applyFork,
  dropFork,
  skipped,
  onSkipped,
  onOpenInRuns,
  announce,
  commands,
  crumbs,
  onBack,
}: {
  client: RewindClient
  lost: LostRun
  loaded: LoadedRun
  functions: FunctionRow[]
  entry: string
  runs: RunRow[]
  applyFork: (fork: Fork) => void
  dropFork: (forkId: string) => void
  /** Whether someone skipped this run while the page is open. */
  skipped: boolean
  onSkipped: (runIds: string[]) => void
  onOpenInRuns: (runId: string, forkId: string) => void
  announce: (text: string) => void
  commands?: PageCommandsApi
  crumbs: BreadcrumbItem[]
  onBack: () => void
}) {
  const { confirm, dialog } = useConfirm()
  const mark = useMemo(() => lostMark(lost), [lost])
  const lines = useMemo(() => buildLines(loaded.detail, loaded.forks, mark), [loaded, mark])
  const original = lines[0]
  const recovery = lines.find((l) => l.kind === 'recovery')
  const finishedCalls = original.calls.filter((c) => c.seq < lost.lost_at)
  const carriedOn = original.calls.filter((c) => c.seq >= lost.lost_at)
  const { running, busy, error, perform, ...actions } = useForkActions(client)
  const need = recovery?.outcome.state === 'paused' ? recovery.outcome.need : undefined
  const [decision, setDecision] = useState<DecisionState | null>(null)
  const check = need ? answerCheck(formatsOf(functions), need.function_id, need.response_format) : undefined
  const template = useAnswerTemplate(client, need?.function_id, lines, runs, check)
  const current = need ? (decision ?? { choice: defaultChoice(need, 'recover'), typed: template.text, autoRead: false }) : null

  const lanes = useMemo(() => lanesOfLines(lines, entry, functions), [lines, entry, functions])
  const laneFor = (functionId: string, worker?: string): Lane => laneOf(lanes, functionId, worker, functions)

  const recover = () =>
    perform('Recovering…', async () => {
      const fork = await client.recover(lost.run_id)
      applyFork(fork)
      announce(`Recovery ${outcomeLook(fork.outcome).phrase}`)
    })

  const answer = async () => {
    const fork = recovery?.fork
    if (!fork || !current || !typedIsValid(current)) {
      return
    }

    if (current.choice === 'stop') {
      const ok = await confirm({
        title: 'Skip run?',
        description: 'Discards the recovery · nothing is sent',
        confirmLabel: 'Skip',
        tone: 'danger',
      })
      if (!ok) {
        return
      }
    }

    await perform('Rerunning recovery…', async () => {
      const next = await actions.answer(fork, current)
      setDecision(null)
      if (current.choice === 'stop') {
        dropFork(fork.fork_id)
        onSkipped([lost.run_id])
        announce('Recovery discarded')
        return
      }

      applyFork(next)
      announce(`Recovery ${outcomeLook(next.outcome).phrase}`)
    })
  }

  const choose = (choice: Choice) => {
    if (need && current && need.choices.includes(choice)) {
      setDecision({ ...current, choice })
    }
  }

  usePageCommands(commands, RECOVERY_COMMANDS, {
    act: {
      recover: () => void recover(),
      answer: () => void answer(),
      live: () => choose('live'),
      typed: () => choose('typed'),
      inject: () => choose('inject'),
    },
    can: {
      recover: !recovery && !busy,
      answer: Boolean(need) && !busy,
      live: Boolean(need?.choices.includes('live')) && !busy,
    },
  })

  // Rewind runs a call live without asking only when nothing about it is
  // irreversible; a live irreversible call means a person chose it.
  const chosen = (call: Call) => call.source !== 'live' || call.effects.includes('irreversible')
  const live = recovery?.calls.filter((c) => c.source === 'live' && !chosen(c)) ?? []
  const byYou = recovery?.calls.filter((c) => c.source !== 'recorded' && chosen(c)) ?? []
  const finished = recovery && recovery.outcome.state !== 'paused'
  const chip = STATE_CHIP[recoveryState(recovery?.fork, skipped)]

  return (
    <div className="rw-run">
      {dialog}
      <LevelBar crumbs={crumbs} onBack={onBack} />
      <RunMasthead run={loaded.detail.run}>
        <Chip tone={chip.tone} className="rw-chip">
          {chip.label}
        </Chip>
      </RunMasthead>
      {running ? <RunProgress running={running} /> : null}
      <div className="rw-scroll">
        <div className="rw-recovery">
          <Step icon={CircleCheck} tone="ok" title="Completed before the stop" aside={plural(finishedCalls.length, 'call')}>
            <p className="rw-step-text">Reused from the recording</p>
            {finishedCalls.length > 0 ? <CallRows calls={finishedCalls} laneFor={laneFor} /> : null}
          </Step>
          <Step icon={Unplug} tone="alert" title="Cut off">
            <p className="rw-step-text">{cutOffText(mark.kind, finishedCalls.length, lostFunction(recovery, lost))}</p>
            {carriedOn.length > 0 ? (
              <>
                <p className="rw-step-text">Ran after the error · not reused</p>
                <CallRows calls={carriedOn} laneFor={laneFor} />
              </>
            ) : null}
          </Step>
          {recovery ? null : (
            <Step icon={LifeBuoy} tone="accent" title="Recover" last>
              <div className="rw-actions">
                <RecoverButton variant="primary" onClick={() => void recover()} disabled={busy}>
                  {busy ? 'Recovering…' : 'Recover run'}
                </RecoverButton>
              </div>
              {error ? <StatusPanel variant="alert" role="alert" headline="Recovery failed to start" detail={error} /> : null}
            </Step>
          )}
          {live.length > 0 ? (
            <Step icon={Radio} tone="teal" title="Ran live" aside={plural(live.length, 'call')}>
              <p className="rw-step-text">Safe to rerun · read-only or external</p>
              <CallRows calls={live} laneFor={laneFor} />
            </Step>
          ) : null}
          {byYou.length > 0 ? (
            <Step icon={SquarePen} tone="accent" title="Answered by you" aside={plural(byYou.length, 'call')}>
              <CallRows calls={byYou} laneFor={laneFor} />
            </Step>
          ) : null}
          {need && current && recovery?.fork ? (
            <Step icon={Diamond} tone="warn" title="Waiting for you" last>
              <DecisionPanel
                need={need}
                mode="recover"
                state={current}
                onChange={setDecision}
                onContinue={() => void answer()}
                busy={busy}
                error={error}
                template={template}
                lostHere={need.seq === mark.at && mark.kind === 'mid-call'}
                check={check}
              />
            </Step>
          ) : null}
          {finished && recovery?.fork ? (
            <Step icon={History} tone="ok" title="Recovered" last>
              <StatusPanel
                variant={outcomeLook(recovery.outcome).tone === 'success' ? 'success' : 'warn'}
                headline={outcomeLook(recovery.outcome).short}
                action={
                  <Button variant="pill" size="sm" onClick={() => onOpenInRuns(lost.run_id, recovery.id)}>
                    Open recovery
                  </Button>
                }
              />
            </Step>
          ) : null}
        </div>
      </div>
    </div>
  )
}

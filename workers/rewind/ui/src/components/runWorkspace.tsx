/**
 * One run. The calls read top to bottom at full width, and the likely cause is
 * open with its answer and "Edit answer". Replay is a result on the original;
 * forks a person made get a switcher once one exists, and compare lines one up
 * against the original. When the worker's code changed since the recording,
 * the run offers to replay with the current code. The player takes the call
 * list's place while it is open.
 *
 * A fork runs with `auto` on, so it reaches an ending by itself and pauses
 * only at the run's stops. Stops belong to the run and outlive this view, and
 * changing one reruns the fork on screen with `rewind::fork-set`. Running a
 * fork goes through `useForkActions`, and the keys through `usePageCommands`.
 */
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  KeyCombo,
  type PageCommandsApi,
  StatusPanel,
  useConfirm,
} from '@iii-dev/console-ui'
import type { BreadcrumbItem } from '@iii-dev/console-ui'
import { errorMessage } from '@iii-dev/console-ui/format'
import { useContainerNarrow } from '@iii-dev/console-ui/hooks'
import { ChevronLeft, ChevronRight, CirclePlay, Ellipsis, FlaskConical, Play, Workflow } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { Answer, CheckResult, Choice, Fork } from '../client/types'
import { useAnswerTemplate } from '../data/useAnswerTemplate'
import { useForkActions } from '../data/useForkActions'
import type { Overview } from '../data/useOverview'
import type { LoadedRun } from '../data/useRunDetail'
import { answerText, draftState } from '../model/answers'
import { defaultChoice } from '../model/choices'
import { changedAtLabel, codeChangedSince, versionLabel } from '../model/code'
import { type DecisionState, typedIsValid } from '../model/decision'
import { shortId } from '../model/format'
import { type Lane, laneOf, lanesOfLines } from '../model/lanes'
import {
  branchLines,
  buildLines,
  callAt,
  clampCursor,
  type Cursor,
  functionsCalled,
  latestReplay,
  likelyCause,
  lineById,
  ORIGINAL,
  pausedNeed,
  step,
} from '../model/lines'
import type { LostMark } from '../model/lost'
import type { CheckPassKind, ReplayThen } from '../model/nav'
import { outcomeLook } from '../model/outcomes'
import { callName } from '../model/requests'
import { answerCheck, formatsOf } from '../model/schema'
import { signatureOf } from '../model/signatures'
import { traceTargetAt } from '../model/traceTarget'
import { CallInspector } from './callInspector'
import { CheckNote } from './checkView'
import { CompareView, OutcomeBanner, StoppedBanner } from './compareView'
import { DecisionPanel } from './decisionPanel'
import { ForkLines } from './forkLines'
import { ForkSwitcher, ReplayResult } from './forkSwitcher'
import { LevelBar } from './levelBar'
import { PathLine } from './pathLine'
import { Player, type PlayerHandle } from './player'
import { RUN_COMMANDS } from './runCommands'
import { RunMasthead } from './runMasthead'
import { RunProgress } from './runProgress'
import { NO_TEST, type TestState } from './saveTest'
import { SequenceView } from './sequenceView'
import { StopsMenu } from './stopsMenu'
import type { TraceLinks } from './traceLink'
import type { TraceSync } from './traceSync'
import { usePageCommands } from './usePageCommands'

type Draft = { lineId: string; seq: number; text: string }

/** Moving through the run's failure group. `onCheck` is missing while the core cannot check runs. */
export type GroupNav = { index: number; total: number; label: string; onPrevious?: () => void; onNext?: () => void; onCheck?: () => void }

/** A replay the page started as it opened this run, and what to show once it returns. */
export type OpeningReplay = { then: ReplayThen; fork: Promise<Fork> }

// Lanes need room for every worker's column; below this the calls stay a list.
const LANES_FROM = 720

export type RunWorkspaceProps = {
  client: RewindClient
  overview: Overview
  loaded: LoadedRun
  applyFork: (fork: Fork) => void
  dropFork: (forkId: string) => void
  commands?: PageCommandsApi
  traces: TraceSync
  setDirty?: (dirty: boolean | string) => void
  initialLine: string | null
  /** Where a dead worker cost this run its call, and how. */
  lost: LostMark | null
  onOpenRecovery: (runId: string) => void
  announce: (text: string) => void
  crumbs: BreadcrumbItem[]
  onBack: () => void
  group: GroupNav | null
  /** The check result this run was opened from, if any. */
  fromCheck: { kind: CheckPassKind; result: CheckResult } | null
  /** A replay started when the run was opened from a check; `onOpened` says this view has taken it. */
  opening: OpeningReplay | null
  onOpened: () => void
  /** Functions a fork of this run pauses at. */
  stops: string[]
  onStopsChange: (stops: string[]) => void
}

function landing(fork: Fork): Cursor {
  return fork.outcome.state === 'paused' ? fork.outcome.need.seq : 'end'
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function lineLabel(loaded: LoadedRun, fork: Fork): string {
  const forks = [...loaded.forks.filter((f) => f.fork_id !== fork.fork_id), fork]
  const summaries = loaded.detail.forks.some((f) => f.fork_id === fork.fork_id)
    ? loaded.detail.forks
    : [...loaded.detail.forks, { ...fork, created_at_ms: Date.now() }]
  return buildLines({ ...loaded.detail, forks: summaries }, forks).find((l) => l.id === fork.fork_id)?.label ?? 'The fork'
}

export function RunWorkspace(props: RunWorkspaceProps) {
  const { client, overview, loaded, applyFork, dropFork, commands, traces, setDirty, initialLine, lost, onOpenRecovery, announce, stops, onStopsChange } = props
  const run = loaded.detail.run
  const entry = overview.status.entry
  const functions = overview.functions
  const formats = useMemo(() => formatsOf(functions), [functions])
  const lines = useMemo(() => buildLines(loaded.detail, loaded.forks, lost), [loaded, lost])
  const original = lines[0]
  const replay = latestReplay(lines)

  const [lineId, setLineId] = useState(initialLine ?? ORIGINAL)
  const line = lineById(lines, lineId)
  // A replay is a result, not a branch, until someone opens it to answer its new calls.
  const branches = [...branchLines(lines), ...(line.kind === 'replay' ? [line] : [])]
  const [cursorState, setCursor] = useState<Cursor | null>(null)
  const cursor = clampCursor(line, cursorState) ?? likelyCause(line)
  const cause = likelyCause(original)
  const [comparingId, setComparingId] = useState<string | null>(null)
  const comparing = comparingId ? lines.find((l) => l.id === comparingId) : undefined
  const [draft, setDraft] = useState<Draft | null>(null)
  const actions = useForkActions(client)
  const { running, busy, perform } = actions
  const [rerunError, setRerunError] = useState<string | null>(null)
  const [decisions, setDecisions] = useState<Record<string, DecisionState>>({})
  const [autoRead, setAutoRead] = useState(false)
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [showWorkers, setShowWorkers] = useState(false)
  const [showGraph, setShowGraph] = useState(false)
  const [playerOpen, setPlayerOpen] = useState(false)
  const player = useRef<PlayerHandle | null>(null)
  const [playheadAt, setPlayheadAt] = useState<Cursor | null>(null)
  const { confirm, dialog } = useConfirm()
  const { ref: callsRef, narrow: tooNarrowForLanes } = useContainerNarrow({ below: LANES_FROM })

  const lanes = useMemo(() => lanesOfLines(lines, entry, functions), [lines, entry, functions])
  const laneFor = (functionId: string, worker?: string): Lane => laneOf(lanes, functionId, worker, functions)

  const need = pausedNeed(line)
  const decisionKey = need ? `${line.id}:${need.seq}` : ''
  const typedCheck = need ? answerCheck(formats, need.function_id, need.response_format) : undefined
  const template = useAnswerTemplate(client, need?.function_id, lines, overview.runs, typedCheck)
  const decision: DecisionState | null = need
    ? (decisions[decisionKey] ?? { choice: defaultChoice(need, line.fork?.mode), typed: template.text, autoRead: line.fork?.auto_read ?? autoRead })
    : null

  const call = typeof cursor === 'number' ? callAt(line, cursor) : undefined
  const functionAtCursor = call?.function_id ?? (need && cursor === need.seq ? need.function_id : undefined)
  const called = useMemo(() => functionsCalled(lines), [lines])
  const editingHere = draft !== null && draft.lineId === line.id && draft.seq === cursor
  const draftInfo = editingHere && call ? draftState(call.answer, draft.text, answerCheck(formats, call.function_id)) : null
  const testLine = comparing ?? line
  const test = testLine.fork ? (tests[testLine.fork.fork_id] ?? NO_TEST) : NO_TEST
  const finishedFork = line.kind !== 'original' && line.outcome.state !== 'paused'
  const defaultTestName = `${slug(signatureOf(run).label)}-${shortId(run.run_id)}`
  const codeChanged = codeChangedSince(run, overview.status)
  const replayedCurrent = replay?.fork?.code?.version === overview.status.target_code?.version
  const replayLabel = codeChanged ? 'Replay with current code' : 'Replay'
  const replayHeadline = codeChanged ? 'Replaying with current code…' : 'Replaying…'

  useEffect(() => {
    setDirty?.(draftInfo?.changed ? 'Edited answer not forked' : false)
  }, [draftInfo?.changed, setDirty])

  useEffect(() => () => setDirty?.(false), [setDirty])

  // With sync on, Traces shows the call at the cursor, or at the playhead while the player is open.
  const traceTarget = traceTargetAt(line, run, playerOpen && playheadAt !== null ? playheadAt : cursor)
  useEffect(() => {
    traces.follow(traceTarget)
  }, [traces, traceTarget?.traceId, traceTarget?.spanId])

  const links: TraceLinks = {
    targetAt: (at) => traceTargetAt(line, run, at),
    available: traces.available,
    spanSelectable: traces.spanSelectable,
    onShow: traces.show,
  }

  const select = (next: Cursor) => {
    setCursor(next)
    actions.setError(null)
  }

  const pickLine = (id: string, next: Cursor | null = null) => {
    setLineId(id)
    setCursor(next)
    setComparingId(null)
    actions.setError(null)
    setRerunError(null)
  }

  const openPlayer = () => {
    setComparingId(null)
    setPlayerOpen(true)
  }

  // The call list opens where the playhead stopped.
  const closePlayer = (at: Cursor) => {
    setPlayerOpen(false)
    select(at)
  }

  const togglePlayer = () => {
    if (playerOpen) {
      player.current?.close()
      return
    }

    openPlayer()
  }

  const runFork = (seq: number, answer: Answer, source: 'edited' | 'injected') =>
    perform('Forking…', async () => {
      const base = line.kind === 'original' ? undefined : line.id
      const fork = await client.fork({ run_id: run.run_id, base, at_seq: seq, answer, source, auto_read: autoRead, auto: true, stops })
      applyFork(fork)
      setDraft(null)
      pickLine(fork.fork_id, landing(fork))
      announce(`${lineLabel(loaded, fork)} ${outcomeLook(fork.outcome).phrase}`)
    })

  const toggleStop = (functionId: string) => {
    const on = !stops.includes(functionId)
    const next = on ? [...stops, functionId] : stops.filter((s) => s !== functionId)
    onStopsChange(next)
    const fork = line.fork
    // A fork from a core without stops has no `auto` at all, and keeps the stop for the next fork.
    if (fork?.auto === undefined) {
      announce(`${on ? 'Stop set' : 'Stop removed'} · ${callName(functionId)}`)
      return
    }

    setRerunError(null)
    void perform(`Rerunning ${line.label.toLowerCase()}…`, async () => {
      try {
        const rerun = await client.forkSet({ fork_id: fork.fork_id, stops: next })
        applyFork(rerun)
        setCursor(landing(rerun))
        announce(`${line.label} ${outcomeLook(rerun.outcome).phrase}`)
      } catch (error) {
        onStopsChange(stops)
        setRerunError(errorMessage(error))
      }
    })
  }

  const AFTER_REPLAY: Record<ReplayThen, (fork: Fork) => void> = {
    stay: () => setComparingId(null),
    compare: (fork) => setComparingId(fork.outcome.state === 'paused' ? null : fork.fork_id),
    open: (fork) => pickLine(fork.fork_id, landing(fork)),
  }

  /** Shows a replay's progress until it returns, then applies it and shows it as `then` says. */
  const showReplay = (replaying: Promise<Fork>, then: ReplayThen) =>
    perform(replayHeadline, async () => {
      const fork = await replaying
      applyFork(fork)
      AFTER_REPLAY[then](fork)
      announce(`Replay ${outcomeLook(fork.outcome).phrase}`)
    })

  const replayRun = () => showReplay(client.replay(run.run_id, { auto_read: autoRead }), 'stay')

  // A check started this replay as it opened the run, so the run shows it running from the first frame.
  const { opening, onOpened } = props
  useEffect(() => {
    if (opening) {
      onOpened()
      void showReplay(opening.fork, opening.then)
    }
  }, [opening])

  const startEdit = () => {
    if (call) {
      setDraft({ lineId: line.id, seq: call.seq, text: answerText(call.answer) })
      actions.setError(null)
    }
  }

  const submitDraft = () => {
    if (draftInfo?.ready && draftInfo.parsed.ok && typeof cursor === 'number') {
      void runFork(cursor, draftInfo.parsed.answer, 'edited')
    }
  }

  const injectHere = () => {
    if (call) {
      void runFork(call.seq, { error: { code: 'UNAVAILABLE', message: 'injected by rewind' } }, 'injected')
    }
  }

  const setDecision = (next: DecisionState) => {
    setDecisions((prev) => ({ ...prev, [decisionKey]: next }))
    setAutoRead(next.autoRead)
  }

  const chooseOnly = (choice: Choice) => {
    if (need && decision && need.choices.includes(choice)) {
      setCursor(need.seq)
      setDecision({ ...decision, choice, typed: choice === 'typed' && !decision.typed ? template.text : decision.typed })
    }
  }

  const stopFork = async (fork: Fork) => {
    const ok = await confirm({
      title: `Discard ${line.label.toLowerCase()}?`,
      description: 'Discards the fork and its worker copy',
      confirmLabel: 'Discard',
      tone: 'danger',
    })
    if (!ok) {
      return
    }

    await perform(`Discarding ${line.label.toLowerCase()}…`, async () => {
      await client.answer({ fork_id: fork.fork_id, choice: 'stop' })
      dropFork(fork.fork_id)
      pickLine(line.parent ?? ORIGINAL)
      announce(`${line.label} discarded`)
    })
  }

  const continueFork = async () => {
    const fork = line.fork
    if (!fork || !need || !decision || !typedIsValid(decision)) {
      return
    }

    if (decision.choice === 'stop') {
      await stopFork(fork)
      return
    }

    await perform(`Rerunning ${line.label.toLowerCase()}…`, async () => {
      const next = await actions.answer(fork, decision, decision.autoRead)
      applyFork(next)
      setCursor(landing(next))
      announce(`${line.label} ${outcomeLook(next.outcome).phrase}`)
    })
  }

  const updateTest = (forkId: string, patch: Partial<TestState>) =>
    setTests((prev) => ({ ...prev, [forkId]: { ...(prev[forkId] ?? NO_TEST), ...patch } }))

  const saveTest = async (name: string, forkId = testLine.fork?.fork_id) => {
    if (!forkId) {
      return
    }

    updateTest(forkId, { busy: 'save', error: null })
    try {
      const saved = await client.saveTest(forkId, name)
      updateTest(forkId, { saved, busy: null })
      announce(`Saved ${saved.path}`)
    } catch (error) {
      updateTest(forkId, { busy: null, error: errorMessage(error) })
    }
  }

  const runTest = async (forkId = testLine.fork?.fork_id) => {
    const saved = forkId ? tests[forkId]?.saved : null
    if (!forkId || !saved) {
      return
    }

    updateTest(forkId, { busy: 'run', error: null })
    try {
      const result = await client.test(saved.path)
      updateTest(forkId, { result, busy: null })
      announce(result.pass ? 'Test passed' : 'Test failed')
    } catch (error) {
      updateTest(forkId, { busy: null, error: errorMessage(error) })
    }
  }

  usePageCommands(commands, RUN_COMMANDS, {
    act: {
      next: () => (playerOpen ? player.current?.step(1) : select(step(line, cursor, 1))),
      previous: () => (playerOpen ? player.current?.step(-1) : select(step(line, cursor, -1))),
      cause: () => select(likelyCause(line)),
      edit: startEdit,
      inject: () => (need ? chooseOnly('inject') : injectHere()),
      live: () => chooseOnly('live'),
      typed: () => chooseOnly('typed'),
      submit: () => (need ? void continueFork() : submitDraft()),
      cancel: () => (playerOpen ? player.current?.close() : setDraft(null)),
      stop: () => (line.fork && need ? void stopFork(line.fork) : undefined),
      compare: () => setComparingId((id) => (id ? null : line.id)),
      save: () => void saveTest(defaultTestName),
      replay: () => void replayRun(),
      workers: () => setShowWorkers((shown) => !shown),
      nextRun: () => props.group?.onNext?.(),
      previousRun: () => props.group?.onPrevious?.(),
      player: togglePlayer,
      toggleStop: () => (functionAtCursor ? toggleStop(functionAtCursor) : undefined),
      trace: () => (traceTarget ? traces.show(traceTarget) : undefined),
      playPause: () => player.current?.toggle(),
      faster: () => player.current?.faster(),
      slower: () => player.current?.slower(),
    },
    can: {
      edit: Boolean(call) && !editingHere && !busy && !playerOpen,
      inject: (Boolean(call) || Boolean(need)) && !busy && !playerOpen,
      paused: Boolean(need) && !busy,
      live: Boolean(need?.choices.includes('live')) && !busy,
      submit: !busy && (Boolean(need) || Boolean(draftInfo?.ready)),
      cancel: editingHere || playerOpen,
      compare: line.kind !== 'original' && !playerOpen,
      save: finishedFork && !test.saved && test.busy === null,
      replay: !busy,
      nextRun: Boolean(props.group?.onNext),
      previousRun: Boolean(props.group?.onPrevious),
      toggleStop: Boolean(functionAtCursor) && !busy && !playerOpen,
      trace: traces.available && traceTarget !== null,
      playerOpen,
    },
  })

  // ── layout ──────────────────────────────────────────────────────────
  const editing = {
    text: editingHere ? draft.text : null,
    onStart: startEdit,
    onChange: (text: string) => setDraft((d) => (d ? { ...d, text } : d)),
    onFork: submitDraft,
    onCancel: () => setDraft(null),
    onInject: injectHere,
    busy,
    error: actions.error,
  }

  const panel = (
    <CallInspector
      client={client}
      runInvocation={run.run_id}
      line={line}
      original={original}
      cursor={cursor}
      cause={cause}
      entry={entry}
      input={run.input}
      editing={editing}
      trace={{ target: traceTargetAt(line, run, cursor), available: traces.available, spanSelectable: traces.spanSelectable, onShow: traces.show }}
      onOpenRecovery={() => onOpenRecovery(run.run_id)}
      replay={line.kind === 'original' ? { label: replayLabel, onReplay: () => void replayRun() } : undefined}
      formats={formats}
    />
  )

  const decisionPanel =
    need && decision && line.fork ? (
      <DecisionPanel
        need={need}
        mode={line.fork.mode}
        state={decision}
        onChange={setDecision}
        onContinue={() => void continueFork()}
        busy={busy}
        error={actions.error}
        template={template}
        line={line.kind === 'replay' ? 'replay' : 'fork'}
        auto={Boolean(line.fork.auto)}
        check={typedCheck}
      />
    ) : undefined

  const group = props.group
  const playLabel = line.kind === 'original' ? 'Play back this run' : `Play back ${line.label}`
  const toolbarEnd = (
    <>
      {group ? (
        <span className="rw-group-nav">
          <IconButton label="Previous run in this group" disabled={!group.onPrevious} onClick={group.onPrevious}>
            <ChevronLeft aria-hidden />
          </IconButton>
          <span className="rw-position">
            {group.index + 1}/{group.total}
          </span>
          <IconButton label="Next run in this group" disabled={!group.onNext} onClick={group.onNext}>
            <ChevronRight aria-hidden />
          </IconButton>
        </span>
      ) : null}
      <StopsMenu targets={called} stops={stops} onToggle={toggleStop} disabled={busy} />
      <IconButton
        label={playerOpen ? 'Close the player' : playLabel}
        tooltip={<>{playerOpen ? 'Close the player' : playLabel} <KeyCombo binding="Alt+V" /></>}
        aria-pressed={playerOpen}
        onClick={togglePlayer}
      >
        <CirclePlay aria-hidden />
      </IconButton>
      <IconButton
        label={showWorkers ? 'Hide workers' : 'Show workers'}
        tooltip={<>{showWorkers ? 'Hide workers' : 'Show workers as lanes'} <KeyCombo binding="Alt+W" /></>}
        aria-pressed={showWorkers}
        onClick={() => setShowWorkers((shown) => !shown)}
      >
        <Workflow aria-hidden />
      </IconButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="More for this run" tooltip={false}>
            <Ellipsis aria-hidden />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void replayRun()} disabled={busy}>
            <Play aria-hidden />
            {replayLabel}
          </DropdownMenuItem>
          {group?.onCheck ? (
            <DropdownMenuItem onSelect={group.onCheck}>
              <FlaskConical aria-hidden />
              Check similar runs
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )

  const body = () => {
    if (playerOpen) {
      return (
        <Player
          key={line.id}
          client={client}
          line={line}
          original={original}
          run={run}
          entry={entry}
          functions={functions}
          workerChanges={line.kind === 'original' ? loaded.detail.worker_changes : undefined}
          lanes={lanes}
          handle={player}
          onCursor={setPlayheadAt}
          onClose={closePlayer}
          links={links}
        />
      )
    }

    if (comparing) {
      return (
        <CompareView
          original={original}
          line={comparing}
          laneFor={laneFor}
          onPick={(seq) => {
            pickLine(comparing.id, seq)
          }}
          onClose={() => setComparingId(null)}
          test={test}
          defaultName={defaultTestName}
          onSave={(name) => void saveTest(name)}
          onRun={() => void runTest()}
        />
      )
    }

    return (
      <>
        {line.kind === 'original' ? null : <PathLine line={line} />}
        <SequenceView
          line={line}
          lanes={lanes}
          laneFor={laneFor}
          entry={entry}
          cursor={cursor}
          cause={cause}
          onSelect={select}
          showLanes={showWorkers && !tooNarrowForLanes}
          expanded={panel}
          decision={decisionPanel}
          stops={stops}
          onToggleStop={busy ? undefined : toggleStop}
          links={links}
          formats={formats}
        />
      </>
    )
  }

  return (
    <div className="rw-run">
      {dialog}
      <LevelBar crumbs={props.crumbs} onBack={props.onBack} end={toolbarEnd} />
      <div className="rw-scroll" ref={callsRef}>
        <RunMasthead run={run} viewing={line} />
        <div className="rw-run-notes" hidden={playerOpen}>
          {props.fromCheck?.kind === 'live' && line.kind === 'original' && !replay ? (
            <CheckNote result={props.fromCheck.result} />
          ) : null}
          {codeChanged && !replayedCurrent && overview.status.target_code && props.fromCheck?.kind !== 'live' ? (
            <StatusPanel
              variant="info"
              icon={<FlaskConical aria-hidden />}
              headline="Code changed since recording"
              detail={`${run.code_version?.slice(0, 7)} → ${versionLabel(overview.status.target_code)} · changed ${changedAtLabel(overview.status.target_code)}`}
              action={
                <span className="rw-banner-actions">
                  {/* The open likely cause has this button beside Edit answer already. */}
                  {cursor !== cause || line.kind !== 'original' ? (
                    <Button variant="pill" size="sm" onClick={() => void replayRun()} disabled={busy}>
                      <Play aria-hidden />
                      Replay with current code
                    </Button>
                  ) : null}
                  {group?.onCheck ? (
                    <Button variant="pill" size="sm" onClick={group.onCheck}>
                      Check similar runs
                    </Button>
                  ) : null}
                </span>
              }
            />
          ) : null}
          {replay && line.kind === 'original' && !comparing ? (
            <ReplayResult
              replay={replay}
              original={original}
              onOpen={() => pickLine(replay.id)}
              onCompare={() => setComparingId(replay.id)}
              test={tests[replay.id] ?? NO_TEST}
              defaultName={defaultTestName}
              onSave={(name) => void saveTest(name, replay.id)}
              onRun={() => void runTest(replay.id)}
            />
          ) : null}
          {running ? <RunProgress running={running} /> : null}
          {rerunError ? <StatusPanel variant="alert" role="alert" headline={`Failed to rerun ${line.label.toLowerCase()}`} detail={rerunError} /> : null}
          {!running && line.kind === 'original' && line.outcome.state === 'stopped' ? (
            <StoppedBanner kind={line.lost?.kind ?? 'mid-call'} onOpenRecovery={() => onOpenRecovery(run.run_id)} />
          ) : null}
          {!running && finishedFork && !comparing ? (
            <OutcomeBanner
              line={line}
              original={original}
              comparing={false}
              onCompare={() => setComparingId(line.id)}
              test={test}
              defaultName={defaultTestName}
              onSave={(name) => void saveTest(name)}
              onRun={() => void runTest()}
            />
          ) : null}
        </div>
        {branches.length > 1 ? (
          <ForkSwitcher
            lines={branches}
            current={line}
            comparing={Boolean(comparing)}
            onPick={(id) => pickLine(id)}
            onCompare={() => {
              setPlayerOpen(false)
              setComparingId(line.id)
            }}
            graphShown={showGraph}
            onToggleGraph={() => setShowGraph((shown) => !shown)}
          />
        ) : null}
        {showGraph && branches.length > 1 ? <ForkLines lines={branches} currentId={line.id} cursor={cursor} onPick={pickLine} /> : null}
        {body()}
      </div>
    </div>
  )
}

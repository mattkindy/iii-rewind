/**
 * Rewind's page, built as levels that each answer one question: what needs
 * attention, then one run, the lost work, a check, or every run, then one lost
 * run. Each click goes one level down and Back goes one up, at every pane
 * width, so the page never shows a list, a run and its details all at once.
 * The level is kept per pane, so a reload comes back to it.
 */
import {
  type BreadcrumbItem,
  Button,
  ErrorBoundary,
  type Host,
  IconButton,
  type LiveAnnouncement,
  LiveRegion,
  PageBody,
  PageHeader,
  PageMain,
  type PageRenderProps,
  PageShell,
  StatusPanel,
} from '@iii-dev/console-ui'
import { usePaneState } from '@iii-dev/console-ui/hooks'
import { History, Waypoints } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRewindClient } from '../client/rewindClient'
import { type CheckRequest, useCheck } from '../data/useCheck'
import { useChangedFeed } from '../data/useChangedFeed'
import { type Overview, useOverview } from '../data/useOverview'
import { useRunDetail } from '../data/useRunDetail'
import { type Cases, caseOf } from '../model/cases'
import { shortId } from '../model/format'
import { type Incident, lostIncidents, lostMark, settled } from '../model/lost'
import { type CheckPassKind, HOME, levelKey, type Nav, parentOf, REPLAY_ON_OPEN } from '../model/nav'
import { groupRuns, type RunGroup, signatureOf } from '../model/signatures'
import { LiveIndicator } from './bits'
import { CheckView } from './checkView'
import { Landing } from './landing'
import { LevelBar } from './levelBar'
import { LostWork } from './lostWork'
import { RecordingMenu } from './recordingMenu'
import { RecoveryWorkspace } from './recoveryView'
import { AllRuns } from './runList'
import { type OpeningReplay, RunWorkspace } from './runWorkspace'
import { LoadError, NoRunsYet, WorkspaceSkeleton } from './states'
import { FILTERS_HIDE, NO_SPAN_SELECTION, useTraceSync } from './traceSync'
import { usePageCommands } from './usePageCommands'

export const PAGE_ID = 'rewind'

const RECENT_RUNS = 25
const NO_STOPS: string[] = []
// A check replays its runs one after another, so a group checks its newest 200 rather than the 500 the core takes.
const GROUP_CHECK_LIMIT = 200

const PAGE_COMMANDS = [
  { id: 'home', title: 'Show what needs attention', keywords: ['home', 'landing'], act: 'home' },
  { id: 'check-recent', title: 'Check against current code', keywords: ['shadow', 'change'], act: 'checkRecent', can: 'check' },
  { id: 'show-traces', title: 'Show traces beside Rewind', keywords: ['traces'], act: 'showTraces' },
  { id: 'sync-traces', title: 'Toggle Traces sync', keywords: ['traces', 'follow', 'span'], act: 'syncTraces', can: 'sync' },
] as const

/** A replay started as a run opened from a check, for the run it belongs to. */
type Opening = OpeningReplay & { runId: string }

function readContext(value: unknown): { run_id?: string } {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return { run_id: typeof record.run_id === 'string' ? record.run_id : undefined }
}

export function RewindPage({ host, ...props }: { host: Host } & PageRenderProps) {
  const { panelSide, onRequestClose, commands, setDirty, panelContext } = props
  const client = useMemo(() => createRewindClient(host.iii), [host])
  const feed = useChangedFeed(host.iii)
  const overview = useOverview(feed, client)
  const paneKey = `rewind:${props.paneId || props.tabId || 'page'}`
  const [nav, setNav] = usePaneState<Nav>(`${paneKey}:nav`, HOME)
  const [announcement, setAnnouncement] = useState<LiveAnnouncement | null>(null)
  // A render error stays on screen until the level or the run changes, or a retry at the landing.
  const [renderTries, setRenderTries] = useState(0)
  const { check, start, startLive } = useCheck(feed, client)
  const [opening, setOpening] = useState<Opening | null>(null)
  // Stops last while the page is open, so they live here and not in the run's view or in storage.
  const [stopsByRun, setStopsByRun] = useState<Record<string, string[]>>({})
  // The core deletes a skipped recovery, so which runs someone skipped lasts while the page is open.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set())
  const markSkipped = useCallback((runIds: string[]) => setSkipped((prev) => new Set([...prev, ...runIds])), [])

  const data = overview.data
  const runs = data?.runs ?? []
  const lost = data?.lost ?? []
  const groups = useMemo(() => groupRuns(runs), [runs])
  const incidents = useMemo(() => lostIncidents(lost, data?.functions ?? []), [lost, data?.functions])
  // A core that reports the code on disk can also replay runs against it.
  const canCheck = Boolean(data?.status.target_code)

  const activeRunId = nav.level === 'run' || nav.level === 'lost-run' ? nav.runId : null
  const detail = useRunDetail(client, activeRunId, overview.pulse)
  const activeLost = lost.find((l) => l.run_id === activeRunId)
  // A run view rebuilds its lines when this changes, so it stays the same object while the lost run does.
  const activeLostMark = useMemo(() => (activeLost ? lostMark(activeLost) : null), [activeLost])

  /** The incident with this key, or the newest one still waiting on someone, or the newest. */
  const incidentFor = (key?: string): Incident | undefined =>
    incidents.find((i) => i.key === key) ?? incidents.find((i) => i.runs.some((r) => !settled(r, skipped))) ?? incidents[0]
  const incidentOfRun = (runId: string) => incidents.find((i) => i.runs.some((r) => r.run_id === runId))?.key

  const announce = useCallback((text: string) => {
    setAnnouncement((prev) => ({ seq: (prev?.seq ?? 0) + 1, text, urgency: 'polite' }))
  }, [])

  const home = () => setNav(HOME)
  const back = () => setNav(parentOf(nav, check?.key ?? null))

  const openGroup = (group: RunGroup) => setNav({ level: 'run', runId: group.runs[0].run_id, group: group.signature.key })

  const checkRuns = (request: CheckRequest) => {
    void start(request)
    setNav({ level: 'check', key: request.key })
  }

  const checkGroup = (key: string) => {
    const group = groups.find((g) => g.signature.key === key)
    if (!group) {
      return
    }

    checkRuns({
      key: `group:${key}`,
      title: `“${group.signature.label}” runs vs current code`,
      group: key,
      code: data?.status.target_code,
      runIds: group.runs.slice(0, GROUP_CHECK_LIMIT).map((r) => r.run_id),
    })
  }

  const checkRecent = () =>
    checkRuns({
      key: 'recent',
      title: `Last ${Math.min(RECENT_RUNS, runs.length)} runs vs current code`,
      code: data?.status.target_code,
      runIds: runs.slice(0, RECENT_RUNS).map((r) => r.run_id),
    })

  const openRun = (runId: string) => {
    const row = runs.find((r) => r.run_id === runId)
    setNav({ level: 'run', runId, group: row ? signatureOf(row).key : undefined })
  }

  // A run opened from the recorded pass of a check replays at once, so the replay starts with the click.
  const openFromCheck = (runId: string, kind: CheckPassKind) => {
    const result = check?.[kind]?.items.find((i) => i.run_id === runId)?.result
    const then = kind === 'recorded' && result ? REPLAY_ON_OPEN[result.result] : undefined
    setNav({ level: 'run', runId, group: check?.group, fromCheck: kind })
    if (!then) {
      setOpening(null)
      return
    }

    const fork = client.replay(runId, { auto_read: false })
    // The run view reports a failure; this only keeps a replay nobody waits on any more from being unhandled.
    fork.catch(() => undefined)
    setOpening({ runId, then, fork })
  }

  const showTraces = useCallback(() => {
    const openScreen = host.panels?.openScreen
    if (openScreen) {
      openScreen({ screen: 'traces', relativeTo: `ext:${PAGE_ID}`, direction: 'left' })
      return
    }

    void host.iii.call('ade::workspace::open', { screen: 'traces' }).catch(() => undefined)
  }, [host])

  const [syncOn, setSyncOn] = usePaneState<boolean>(`${paneKey}:sync-traces`, false)
  const { sync, mention } = useTraceSync(host, syncOn, `ext:${PAGE_ID}`)
  // Turning sync on puts Traces beside Rewind, so it has somewhere to show the call.
  const toggleSync = () => {
    if (!syncOn) {
      showTraces()
    }

    setSyncOn(!syncOn)
  }

  const appliedContext = useRef(0)
  useEffect(() => {
    if (!panelContext || panelContext.id === appliedContext.current) {
      return
    }

    appliedContext.current = panelContext.id
    const context = readContext(panelContext.context)
    if (context.run_id) {
      setNav({ level: 'run', runId: context.run_id })
    }
  }, [panelContext, setNav])

  usePageCommands(commands, PAGE_COMMANDS, {
    act: { home, checkRecent, showTraces, syncTraces: toggleSync },
    can: { check: canCheck, sync: sync.available },
  })

  const homeCrumb: BreadcrumbItem = { key: 'home', label: 'Needs attention', onClick: home }
  const loadingRun = () => (detail.error ? <LoadError what="run" error={detail.error} onRetry={detail.reload} /> : <WorkspaceSkeleton />)

  const runLevel = (current: Extract<Nav, { level: 'run' }>, overviewData: Overview) => {
    if (!detail.data) {
      return loadingRun()
    }

    const group = current.group ? groups.find((g) => g.signature.key === current.group) : undefined
    const index = group ? group.runs.findIndex((r) => r.run_id === current.runId) : -1
    const goTo = (offset: number) => {
      const next = group?.runs[index + offset]
      return next ? () => setNav({ level: 'run', runId: next.run_id, group: current.group }) : undefined
    }
    const fromCheck = current.fromCheck && check ? check : null
    const checked = fromCheck && current.fromCheck ? fromCheck[current.fromCheck]?.items.find((i) => i.run_id === current.runId)?.result : undefined
    const middle: BreadcrumbItem[] = fromCheck
      ? [{ key: 'check', label: 'Check', onClick: () => setNav({ level: 'check', key: fromCheck.key }) }]
      : group
        ? [{ key: 'group', label: group.signature.label }]
        : [{ key: 'runs', label: 'All runs', onClick: () => setNav({ level: 'runs' }) }]
    return (
      <RunWorkspace
        key={`${detail.data.runId}:${current.fromCheck ?? 'run'}`}
        client={client}
        overview={overviewData}
        loaded={detail.data}
        applyFork={detail.applyFork}
        dropFork={detail.dropFork}
        commands={commands}
        traces={sync}
        setDirty={setDirty}
        initialLine={current.line ?? null}
        lost={activeLostMark}
        onOpenRecovery={(runId) => setNav({ level: 'lost-run', runId, incident: incidentOfRun(runId) })}
        announce={announce}
        crumbs={[homeCrumb, ...middle, { key: 'run', label: shortId(current.runId) }]}
        onBack={back}
        fromCheck={checked && current.fromCheck ? { kind: current.fromCheck, result: checked } : null}
        opening={opening?.runId === current.runId && current.fromCheck === 'recorded' ? opening : null}
        onOpened={() => setOpening(null)}
        stops={stopsByRun[current.runId] ?? NO_STOPS}
        onStopsChange={(stops) => setStopsByRun((prev) => ({ ...prev, [current.runId]: stops }))}
        group={
          group && index >= 0
            ? {
                index,
                total: group.runs.length,
                label: group.signature.label,
                onPrevious: goTo(-1),
                onNext: goTo(1),
                onCheck: canCheck ? () => checkGroup(group.signature.key) : undefined,
              }
            : null
        }
      />
    )
  }

  const levelView = (current: Nav, overviewData: Overview): ReactNode => {
    const levels: Cases<Nav, ReactNode, 'level'> = {
      home: () => (
        <Landing
          status={overviewData.status}
          runs={runs}
          groups={groups}
          incidents={incidents}
          skipped={skipped}
          capped={overviewData.capped}
          canCheck={canCheck}
          onOpenGroup={openGroup}
          onOpenLost={(incident) => setNav({ level: 'lost', incident })}
          onOpenAll={() => setNav({ level: 'runs' })}
          onCheckRecent={checkRecent}
        />
      ),
      runs: () => (
        <div className="rw-run">
          <LevelBar crumbs={[homeCrumb, { key: 'runs', label: 'All runs' }]} onBack={back} />
          <AllRuns client={client} runs={runs} onOpen={(run) => openRun(run.run_id)} />
        </div>
      ),
      run: (level) => runLevel(level, overviewData),
      lost: (level) => {
        const incident = incidentFor(level.incident)
        return (
          <div className="rw-run">
            <LevelBar crumbs={[homeCrumb, { key: 'lost', label: 'Interrupted' }]} onBack={back} />
            {incident ? (
              <LostWork
                key={incident.key}
                client={client}
                incident={incident}
                runs={runs}
                skipped={skipped}
                onSkipped={markSkipped}
                onOpen={(runId) => setNav({ level: 'lost-run', runId, incident: incident.key })}
                onChanged={overview.refresh}
                announce={announce}
              />
            ) : (
              <div className="rw-error">
                <StatusPanel variant="info" headline="No interrupted runs" />
              </div>
            )}
          </div>
        )
      },
      'lost-run': (level) => {
        if (!detail.data || !activeLost) {
          return loadingRun()
        }

        return (
          <RecoveryWorkspace
            key={activeLost.run_id}
            client={client}
            lost={activeLost}
            loaded={detail.data}
            functions={overviewData.functions}
            entry={overviewData.status.entry}
            runs={runs}
            applyFork={detail.applyFork}
            dropFork={detail.dropFork}
            skipped={skipped.has(activeLost.run_id)}
            onSkipped={markSkipped}
            onOpenInRuns={(runId, forkId) => setNav({ level: 'run', runId, line: forkId })}
            announce={announce}
            commands={commands}
            crumbs={[
              homeCrumb,
              { key: 'lost', label: 'Interrupted', onClick: () => setNav({ level: 'lost', incident: level.incident }) },
              { key: 'run', label: shortId(activeLost.run_id) },
            ]}
            onBack={back}
          />
        )
      },
      check: () => (
        <div className="rw-run">
          <LevelBar crumbs={[homeCrumb, { key: 'check', label: 'Check' }]} onBack={back} />
          {check ? (
            <CheckView
              check={check}
              runs={runs}
              functions={overviewData.functions}
              entry={overviewData.status.entry}
              onOpen={openFromCheck}
              onRunLive={() => void startLive()}
            />
          ) : (
            <div className="rw-error">
              <StatusPanel
                variant="info"
                headline="Check not kept"
                detail="Run it again from the landing"
                action={
                  <Button variant="pill" size="sm" onClick={home}>
                    Back
                  </Button>
                }
              />
            </div>
          )}
        </div>
      ),
    }
    return caseOf(current, 'level', levels)
  }

  const main = (() => {
    if (!data) {
      return overview.error ? <LoadError what="Rewind" error={overview.error} onRetry={overview.refresh} /> : <WorkspaceSkeleton />
    }

    if (nav.level === 'home' && runs.length === 0 && lost.length === 0) {
      return <NoRunsYet />
    }

    return levelView(nav, data)
  })()

  return (
    <PageShell className="rw-shell">
      <PageHeader
        icon={<History />}
        title="Rewind"
        onClose={onRequestClose}
        actions={
          <>
            <LiveIndicator live={overview.live} />
            {data ? (
              <RecordingMenu
                client={client}
                functions={data.functions}
                recording={data.status.recording.length}
                backlog={data.status.recorder}
                onChanged={overview.refresh}
              />
            ) : null}
            {sync.available ? (
              <IconButton
                label={syncOn ? 'Stop syncing with Traces' : 'Sync with Traces'}
                tooltip={
                  <>
                    {syncOn ? 'Stop Traces sync' : 'Sync with Traces'}
                    {sync.spanSelectable ? null : (
                      <>
                        <br />
                        {NO_SPAN_SELECTION}
                        <br />
                        {FILTERS_HIDE}
                      </>
                    )}
                  </>
                }
                aria-pressed={syncOn}
                className="rw-sync"
                onClick={toggleSync}
              >
                <Waypoints aria-hidden />
              </IconButton>
            ) : null}
          </>
        }
      />
      <LiveRegion announcement={announcement} />
      {mention}
      <PageBody side={panelSide}>
        <PageMain className="rw-main">
          <ErrorBoundary
            key={`${levelKey(nav)}:${renderTries}`}
            fallback={(error) => (
              <div className="rw-error">
                <StatusPanel
                  variant="alert"
                  role="alert"
                  headline="Render error"
                  detail={error.message}
                  action={
                    <Button variant="pill" size="sm" onClick={nav.level === 'home' ? () => setRenderTries((n) => n + 1) : back}>
                      {nav.level === 'home' ? 'Retry' : 'Back'}
                    </Button>
                  }
                />
              </div>
            )}
          >
            {main}
          </ErrorBoundary>
        </PageMain>
      </PageBody>
    </PageShell>
  )
}

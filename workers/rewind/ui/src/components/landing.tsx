/**
 * The first screen: what needs attention. A strip at the top shows the last
 * minute of runs as they arrive. Interrupted runs come first, because they wait
 * on someone: the newest incident gets a row, and earlier ones fold away. Then
 * failures, grouped by how they failed, each with a count, one plain line and
 * how recent the newest is. A group opens its newest run. When the worker's
 * code has changed, the landing offers to check recent runs against it.
 *
 * The landing fills in while traffic runs. A count steps up to its new value,
 * a row that changed is lit for a moment, and a new row rises into place.
 */
import { Button, EmptyState, Eyebrow, List, ListItem, StatusDot, StatusPanel } from '@iii-dev/console-ui'
import { ChevronDown, ChevronRight, CircleCheck, FlaskConical, LifeBuoy, ListTree } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { LostRun, Status } from '../client/types'
import { MOST_RUNS } from '../data/useOverview'
import { changedAtLabel, codeChangedSince, versionLabel } from '../model/code'
import { ago, dayAndTime, plural } from '../model/format'
import { type Incident, incidentRowLabel, lostState, settled } from '../model/lost'
import { explainGroup, KINDS, type RunGroup, type TriageRow } from '../model/signatures'
import { ActivityStrip } from './activityStrip'
import { useNow, useReducedMotion, useRecentChanges } from './motion'

// How long a row that changed stays lit, and how often a count steps.
const LIT_MS = 1_200
const STEP_MS = 60
const MAX_STEPS = 8
// While the newest run is under a minute old its age is in seconds, so it ticks every second.
const RECENT_MS = 60_000

function lostDetail(lost: LostRun[], skipped: ReadonlySet<string>): string {
  const waiting = lost.filter((l) => lostState(l, skipped) === 'waiting').length
  const open = lost.filter((l) => lostState(l, skipped) === 'open').length
  const parts = [waiting > 0 ? `${waiting} waiting for you` : '', open > 0 ? `${open} open` : ''].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'All recovered'
}

/** A number that steps up to a new value instead of jumping to it. */
function StepCount({ value, children }: { value: number; children: (shown: number) => ReactNode }) {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(value)
  useEffect(() => {
    if (shown === value) {
      return
    }

    if (reduced) {
      setShown(value)
      return
    }

    const step = Math.max(1, Math.ceil(Math.abs(value - shown) / MAX_STEPS))
    const timer = window.setTimeout(() => setShown((s) => (s < value ? Math.min(value, s + step) : Math.max(value, s - step))), STEP_MS)
    return () => window.clearTimeout(timer)
  }, [value, shown, reduced])
  return <>{children(shown)}</>
}

/** How long ago the newest run in a group ran, with the exact time on hover. The landing re-renders every second to keep it current. */
function Recency({ ms }: { ms: number }) {
  return (
    <span className="rw-recency" title={dayAndTime(ms)}>
      {ago(ms)}
    </span>
  )
}

function IncidentRow({
  incident,
  skipped,
  lit,
  risen,
  onOpen,
}: {
  incident: Incident
  skipped: ReadonlySet<string>
  lit: boolean
  risen: boolean
  onOpen: () => void
}) {
  return (
    <ListItem
      className="rw-landing-row"
      data-incident={incident.key}
      data-changed={lit || undefined}
      data-new={risen || undefined}
      leading={<LifeBuoy aria-hidden />}
      label={
        <StepCount value={incident.runs.length}>
          {(shown) => <span className="rw-landing-title">{incidentRowLabel(incident, shown)}</span>}
        </StepCount>
      }
      description={lostDetail(incident.runs, skipped)}
      trailing={<ChevronRight aria-hidden />}
      onClick={onOpen}
    />
  )
}

export function Landing({
  status,
  runs,
  groups,
  incidents: allIncidents,
  skipped,
  capped,
  canCheck,
  onOpenGroup,
  onOpenLost,
  onOpenAll,
  onCheckRecent,
}: {
  status: Status
  runs: TriageRow[]
  /** Every run grouped by how it failed, worst first. */
  groups: RunGroup[]
  /** Every incident of lost work, newest first. */
  incidents: Incident[]
  /** Lost runs someone skipped while the page is open. */
  skipped: ReadonlySet<string>
  /** The page could not read every recorded run, so counts start from the newest ones. */
  capped: boolean
  /** False until the core can replay runs against the current code. */
  canCheck: boolean
  onOpenGroup: (group: RunGroup) => void
  onOpenLost: (incident: string) => void
  onOpenAll: () => void
  onCheckRecent: () => void
}) {
  // Stopped runs are listed above under Interrupted, so they are not a failure group here.
  const failures = useMemo(() => groups.filter((g) => KINDS[g.signature.kind].attention && g.signature.kind !== 'stopped'), [groups])
  const incidents = useMemo(() => allIncidents.filter((i) => i.runs.some((r) => !settled(r, skipped))), [allIncidents, skipped])
  const [newest, ...earlier] = incidents
  const [showEarlier, setShowEarlier] = useState(false)
  const older = runs.filter((r) => codeChangedSince(r, status)).length
  const code = status.target_code
  const codeNote = Boolean(code && canCheck && older > 0)

  const counts = useMemo(
    () => new Map([...failures.map((g): [string, number] => [g.signature.key, g.runs.length]), ...incidents.map((i): [string, number] => [`lost:${i.key}`, i.runs.length])]),
    [failures, incidents],
  )
  const { changed, added } = useRecentChanges(counts, LIT_MS)
  const newestRun = runs[0]?.started_at_ms ?? 0
  useNow(Date.now() - newestRun < RECENT_MS ? 1_000 : 15_000)

  return (
    <div className="rw-scroll">
      <div className="rw-landing">
        <ActivityStrip runs={runs} recording={status.recording.length > 0} />

        {code && codeNote ? (
          <StatusPanel
            variant="info"
            icon={<FlaskConical aria-hidden />}
            headline={`Code changed ${changedAtLabel(code)} · ${versionLabel(code)}`}
            detail={`${plural(older, 'run')} on older code`}
            action={
              <Button variant="pill" size="sm" onClick={onCheckRecent}>
                Check recent runs
              </Button>
            }
          />
        ) : null}

        {newest ? (
          <section className="rw-landing-section">
            <Eyebrow as="h2">Interrupted</Eyebrow>
            <List aria-label="Interrupted runs">
              <IncidentRow
                incident={newest}
                skipped={skipped}
                lit={changed.has(`lost:${newest.key}`)}
                risen={added.has(`lost:${newest.key}`)}
                onOpen={() => onOpenLost(newest.key)}
              />
              {showEarlier
                ? earlier.map((incident) => (
                    <IncidentRow key={incident.key} incident={incident} skipped={skipped} lit={false} risen={false} onOpen={() => onOpenLost(incident.key)} />
                  ))
                : null}
            </List>
            {earlier.length > 0 ? (
              <span className="rw-landing-actions">
                <Button variant="ghost" size="sm" aria-expanded={showEarlier} onClick={() => setShowEarlier((shown) => !shown)}>
                  {showEarlier ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                  {plural(earlier.length, 'earlier incident')}
                </Button>
              </span>
            ) : null}
          </section>
        ) : null}

        <section className="rw-landing-section">
          <Eyebrow as="h2">Failures</Eyebrow>
          {failures.length === 0 ? (
            <EmptyState compact icon={CircleCheck} title="No failures" description={plural(runs.length, 'run')} />
          ) : (
            <List aria-label="Failures, worst first">
              {failures.map((group) => (
                <ListItem
                  key={group.signature.key}
                  className="rw-landing-row"
                  data-group={group.signature.key}
                  data-changed={changed.has(group.signature.key) || undefined}
                  data-new={added.has(group.signature.key) || undefined}
                  leading={<StatusDot tone={KINDS[group.signature.kind].tone} />}
                  label={<span className="rw-landing-title">{group.signature.label}</span>}
                  description={explainGroup(group)}
                  trailing={
                    <span className="rw-landing-trailing">
                      <StepCount value={group.runs.length}>{(shown) => <span className="rw-landing-count">{plural(shown, 'run')}</span>}</StepCount>
                      <Recency ms={group.runs[0].started_at_ms} />
                      <ChevronRight aria-hidden />
                    </span>
                  }
                  onClick={() => onOpenGroup(group)}
                />
              ))}
            </List>
          )}
          {capped ? <p className="rw-side-note">Counts from the newest {MOST_RUNS.toLocaleString()} runs</p> : null}
        </section>

        <div className="rw-landing-actions">
          <Button variant="ghost" size="sm" onClick={onOpenAll}>
            <ListTree aria-hidden />
            <StepCount value={runs.length}>{(shown) => <>All {plural(shown, 'run')}</>}</StepCount>
          </Button>
          {canCheck && !codeNote ? (
            <Button variant="ghost" size="sm" onClick={onCheckRecent}>
              <FlaskConical aria-hidden />
              Check against current code
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

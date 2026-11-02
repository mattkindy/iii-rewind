/**
 * The player's waterfall: the run's own bar, then one row per call, on the same
 * time axis as the scrubber above it. A bar grows while the playhead is inside
 * its call, and the answer's one line summary lands beside it when the call
 * ends. Calls still ahead show as a faint outline, so the shape of the run is
 * visible before it plays. A call the caller gave up on ends at the timeout
 * with a mark, and a dashed line shows how long the callee kept going.
 */
import type { CSSProperties, ReactNode } from 'react'
import { Diamond } from 'lucide-react'
import { returnedFailed } from '../model/appOutput'
import { type Cases, caseOf } from '../model/cases'
import { duration as formatMs } from '../model/format'
import type { Lane } from '../model/lanes'
import type { Line, LineOutcome } from '../model/lines'
import type { LostKind } from '../model/lost'
import { outcomeLook } from '../model/outcomes'
import { type PlayClock, playSpan } from '../model/playClock'
import { callName, callUrl } from '../model/requests'
import type { Span, Timeline } from '../model/timeline'
import { WorkerGlyph } from './bits'
import { FnLink, type TraceLinks } from './traceLink'

type RowState = 'ahead' | 'running' | 'done'

export type WaterfallProps = {
  line: Line
  timeline: Timeline
  clock: PlayClock
  /** The playhead on the player's clock, and the run's time there. */
  p: number
  t: number
  entry: string
  entryLane: Lane
  laneFor: (functionId: string, worker?: string) => Lane
  current: Span | undefined
  onSelect: (span: Span) => void
  scrubber: ReactNode
  divergeLabel?: string
  links: TraceLinks
}

type LabelPlace = 'after' | 'before' | 'below'

// A summary goes after its bar when the bar ends early enough, before it when
// it starts late enough, and under it when the bar spans most of the run.
const LABEL_ROOM = 0.66

function labelPlace(from: number, to: number): LabelPlace {
  if (to <= LABEL_ROOM) {
    return 'after'
  }

  return from >= 1 - LABEL_ROOM ? 'before' : 'below'
}

function labelStyle(place: LabelPlace, from: number, to: number): CSSProperties {
  const styles: Record<LabelPlace, () => CSSProperties> = {
    after: () => ({ left: `calc(${to * 100}% + 8px)`, maxWidth: `calc(${(1 - to) * 100}% - 8px)` }),
    before: () => ({ right: `calc(${(1 - from) * 100}% + 8px)`, maxWidth: `calc(${from * 100}% - 8px)`, textAlign: 'right' }),
    below: () => ({ left: `${from * 100}%`, maxWidth: `${(1 - from) * 100}%` }),
  }
  return styles[place]()
}

const ENDING_TONE: Cases<LineOutcome, 'ok' | 'warn' | 'alert' | 'ink'> = {
  done: ({ output }) => (returnedFailed(output) ? 'warn' : 'ok'),
  crashed: () => 'alert',
  stopped: () => 'ink',
  paused: () => 'warn',
}

// Read on the player's clock, so a call that took no time still runs for a moment.
function stateOf(p: number, range: { from: number; to: number }): RowState {
  if (p < range.from) {
    return 'ahead'
  }

  return p < range.to ? 'running' : 'done'
}

function elapsed(state: RowState, t: number, span: Span): string {
  const shown: Record<RowState, () => string> = {
    ahead: () => '',
    running: () => formatMs(t - span.start),
    done: () => formatMs(span.end - span.start),
  }
  return shown[state]()
}

type Axis = { share: (ms: number) => number; pct: (ms: number) => string; bar: (from: number, to: number) => CSSProperties }

const LOST_LABEL: Record<LostKind, (worker: string) => string> = {
  'mid-call': (worker) => `Call interrupted when ${worker} stopped`,
  'not-found': (worker) => `Call not found while ${worker} was down`,
}

function rowLabel(span: Span): string {
  if (span.lost) {
    return `${LOST_LABEL[span.lost](span.call.worker)}. Select to move the playhead here.`
  }

  return `Call ${span.number} to ${callName(span.call.function_id)}, ${formatMs(span.end - span.start)}. Select to move the playhead here.`
}

/** Where on a call's bar each request its worker made went out, by its own clock against the call's. */
function innerMarks(span: Span): { key: string; at: number; title: string }[] {
  const startedAt = span.call.started_at_ms
  return (span.call.inner ?? []).map((request, index) => {
    const offset = startedAt !== undefined && request.started_at_ms !== undefined ? request.started_at_ms - startedAt : (span.calleeEnd - span.start) / 2
    return {
      key: request.invocation_id ?? String(index),
      at: Math.min(span.calleeEnd, Math.max(span.start, span.start + offset)),
      title: `Outbound request · ${callName(request.function_id)}`,
    }
  })
}

type CallRowProps = {
  span: Span
  lane: Lane
  state: RowState
  current: boolean
  t: number
  axis: Axis
  /** When the callee's worker went away during this call. */
  breakAt: number | undefined
  onSelect: (span: Span) => void
  links: TraceLinks
}

/** A lost call was never recorded, so it has no span to link to. */
function CallName({ span, links }: { span: Span; links: TraceLinks }) {
  const name = callName(span.call.function_id)
  if (span.lost) {
    return <span className="rw-wf-fn">{name}</span>
  }

  return <FnLink name={name} title={callUrl(span.call.function_id)} target={links.targetAt(span.seq)} links={links} className="rw-wf-fn rw-fn" />
}

function CallRow({ span, lane, state, current, t, axis, breakAt, onSelect, links }: CallRowProps) {
  const { share, pct, bar } = axis
  const place = labelPlace(share(span.start), share(span.end))
  // A call the caller gave up on, and one whose worker went away, both end in a dashed line.
  const solidUntil = breakAt ?? span.end
  const dashedFrom = span.gaveUp ? span.end : solidUntil
  const dashedTo = span.gaveUp ? span.calleeEnd : span.end
  const dashed = t > dashedFrom && dashedTo > dashedFrom ? Math.min(t, dashedTo) : null
  // The timeout's label reads from the mark, or up to it near the right edge.
  const timeoutLabel: CSSProperties =
    share(span.end) <= LABEL_ROOM ? { left: `calc(${pct(span.end)} + 6px)` } : { right: `calc(${100 - share(span.end) * 100}% + 6px)` }
  return (
    <button
      type="button"
      className="rw-wf-row"
      data-state={state}
      data-gave-up={span.gaveUp || undefined}
      data-lost={span.lost || undefined}
      data-label={span.gaveUp ? undefined : place}
      aria-current={current ? 'step' : undefined}
      aria-label={rowLabel(span)}
      title={span.call.inferred}
      onClick={() => onSelect(span)}
    >
      <span className="rw-wf-name">
        <span className="rw-wf-num">{span.lost ? '' : span.number}</span>
        <WorkerGlyph lane={lane} />
        <CallName span={span} links={links} />
      </span>
      <span className="rw-wf-track">
        <span className="rw-wf-ghost" style={bar(span.start, span.end)} />
        {state === 'ahead' ? null : (
          <span
            className="rw-wf-bar"
            data-tone={lane.tone}
            data-error={(state === 'done' && span.error && !span.lost) || undefined}
            style={bar(span.start, Math.min(t, solidUntil))}
          />
        )}
        {dashed !== null ? <span className="rw-wf-after" data-lost={span.lost || undefined} style={bar(dashedFrom, dashed)} /> : null}
        {innerMarks(span).map((mark) => (
          <span key={mark.key} className="rw-wf-inner" style={{ left: pct(mark.at) }} title={mark.title} />
        ))}
        {span.gaveUp && state === 'done' ? (
          <>
            <span className="rw-wf-timeout" style={{ left: pct(span.end) }} />
            <span className="rw-wf-timeout-label" style={timeoutLabel}>
              Caller timeout
            </span>
          </>
        ) : null}
        {!span.gaveUp && state === 'done' ? (
          <span className="rw-wf-answer" data-error={span.error || undefined} style={labelStyle(place, share(span.start), share(span.end))}>
            {span.summary}
          </span>
        ) : null}
      </span>
      <span className="rw-wf-ms">{elapsed(state, t, span)}</span>
    </button>
  )
}

export function Waterfall(props: WaterfallProps) {
  const { line, timeline, clock, p, t, entry, entryLane, laneFor, current, onSelect, scrubber, divergeLabel, links } = props
  const total = Math.max(1, timeline.duration)
  const share = (ms: number) => Math.min(1, Math.max(0, ms / total))
  const pct = (ms: number) => `${share(ms) * 100}%`
  const bar = (from: number, to: number): CSSProperties => ({ left: pct(from), width: `max(2px, ${(share(to) - share(from)) * 100}%)` })
  const axis: Axis = { share, pct, bar }
  const breakOf = (span: Span) =>
    timeline.shifts.find((s) => s.worker === span.call.worker && s.event === 'disconnected' && s.at >= span.start && s.at < span.end)?.at

  const ended = t >= timeline.ends
  const endingTone = caseOf(line.outcome, 'state', ENDING_TONE)
  const style = { ['--rw-ph' as string]: share(t), ['--rw-fork' as string]: timeline.divergeAt === null ? 0 : share(timeline.divergeAt) }

  return (
    <div className="rw-wf" style={style}>
      <div className="rw-wf-axis">
        <span className="rw-wf-axis-start">{formatMs(0)}</span>
        {scrubber}
        <span className="rw-wf-axis-end">{formatMs(total)}</span>
      </div>
      <ol className="rw-wf-rows" aria-label={`Calls in ${line.label}, in time`}>
        <li className="rw-wf-item">
          <div className="rw-wf-row" data-kind="run" data-state={ended ? 'done' : 'running'}>
            <span className="rw-wf-name">
              <span className="rw-wf-num" />
              <WorkerGlyph lane={entryLane} />
              <FnLink name={entry} target={links.targetAt('end')} links={links} className="rw-wf-fn rw-fn" />
            </span>
            <span className="rw-wf-track">
              <span className="rw-wf-bar" data-kind="run" data-tone={ended ? endingTone : undefined} style={bar(0, Math.min(t, timeline.ends))}>
                {ended ? <span className="rw-wf-ending">{outcomeLook(line.outcome).short}</span> : null}
              </span>
            </span>
            <span className="rw-wf-ms">{formatMs(Math.min(t, timeline.ends))}</span>
          </div>
        </li>
        {timeline.spans.map((span) => {
          const state = stateOf(p, playSpan(clock, span))
          return (
            <li key={span.seq} className="rw-wf-item">
              <CallRow
                span={span}
                lane={laneFor(span.call.function_id, span.call.worker)}
                state={state}
                current={current?.seq === span.seq && state !== 'ahead'}
                t={t}
                axis={axis}
                breakAt={breakOf(span)}
                onSelect={onSelect}
                links={links}
              />
            </li>
          )
        })}
        {timeline.pause ? (
          <li className="rw-wf-item">
            <div className="rw-wf-row" data-kind="paused" data-state={t >= timeline.pause.at ? 'done' : 'ahead'}>
              <span className="rw-wf-name">
                <span className="rw-wf-num">{timeline.pause.number}</span>
                <WorkerGlyph lane={laneFor(timeline.pause.functionId)} />
                <FnLink
                  name={callName(timeline.pause.functionId)}
                  title={callUrl(timeline.pause.functionId)}
                  target={links.targetAt(timeline.pause.seq)}
                  links={links}
                  className="rw-wf-fn rw-fn"
                />
              </span>
              <span className="rw-wf-track">
                {t >= timeline.pause.at ? (
                  <>
                    <span className="rw-wf-pause" style={{ left: pct(timeline.pause.at) }}>
                      <Diamond aria-hidden />
                    </span>
                    <span className="rw-wf-answer" data-tone="warn" style={labelStyle('before', share(timeline.pause.at) - 0.01, 1)}>
                      Paused
                    </span>
                  </>
                ) : null}
              </span>
              <span className="rw-wf-ms" />
            </div>
          </li>
        ) : null}
      </ol>
      {timeline.divergeAt !== null ? <span className="rw-wf-fork" title={divergeLabel} aria-hidden /> : null}
      <span className="rw-wf-playhead" aria-hidden />
    </div>
  )
}

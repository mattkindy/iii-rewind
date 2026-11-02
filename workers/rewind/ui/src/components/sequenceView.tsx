/**
 * The calls of one line, top to bottom, and how it ended. By default each row
 * is a call with its worker's glyph and name and a one line answer. "Show
 * workers" draws the same rows on lanes, one per worker. The selected row
 * opens in place; a paused fork ends in a row whose decision opens under it.
 * Lanes are placed in percent of the track, so every row lines up.
 *
 * Clicking the gutter, where the call number is, toggles a stop on the call's
 * function, the way an editor's gutter toggles a breakpoint. A button can't
 * contain another button, so the gutter is its own button laid over the row's
 * first column, and Show in Traces is another at the row's far end. The
 * function's name in a row is a link to its span in Traces.
 */
import { Chip, Tooltip } from '@iii-dev/console-ui'
import type { LucideIcon } from 'lucide-react'
import { CircleAlert, CircleCheck, CircleX, Diamond, Unplug } from 'lucide-react'
import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react'
import type { Call } from '../client/types'
import { isError, isRepeatedCall, summarizeAnswer } from '../model/answers'
import { outputReply, returnedFailed } from '../model/appOutput'
import { type Cases, caseOf } from '../model/cases'
import { duration, errorDetail, truncate } from '../model/format'
import type { Lane } from '../model/lanes'
import { type Cursor, type Line, type LineOutcome, ordinal, positions } from '../model/lines'
import { LOST_CALL, type LostKind } from '../model/lost'
import { outcomeLook } from '../model/outcomes'
import { callName, callUrl } from '../model/requests'
import { callIssue, type Formats, issueText } from '../model/schema'
import { SourceChip, WorkerGlyph } from './bits'
import { FnLink, type TraceLinks, TraceButton } from './traceLink'

type RowKind = 'call' | 'paused' | 'end'

type Row = {
  key: string
  cursor: Cursor
  kind: RowKind
  number: string
  functionId: string
  lane: Lane
  summary: string
  call?: Call
  error?: boolean
}

export type SequenceProps = {
  line: Line
  lanes: Lane[]
  laneFor: (functionId: string, worker?: string) => Lane
  entry: string
  cursor: Cursor
  cause: Cursor | null
  onSelect: (cursor: Cursor) => void
  showLanes: boolean
  expanded?: ReactNode
  decision?: ReactNode
  /** Functions with a stop on them. */
  stops: string[]
  /** Missing while a stop can't change, such as while the fork reruns. */
  onToggleStop?: (functionId: string) => void
  links: TraceLinks
  /** The functions' schemas, which a recorded call's input and output are checked against. */
  formats: Formats
}

type EndLook = { icon: LucideIcon; tone: 'alert' | 'ok' | 'warn' | 'ink' }

const END_LOOK: Cases<LineOutcome, EndLook> = {
  done: ({ output }) => (returnedFailed(output) ? { icon: CircleAlert, tone: 'warn' } : { icon: CircleCheck, tone: 'ok' }),
  crashed: () => ({ icon: CircleX, tone: 'alert' }),
  stopped: () => ({ icon: Unplug, tone: 'ink' }),
  paused: () => ({ icon: Diamond, tone: 'warn' }),
}

function endLook(line: Line): EndLook {
  return caseOf(line.outcome, 'state', END_LOOK)
}

/** The ending row's second line: what the agent replied, or why the run ended without a reply. */
function endDetail(line: Line): string {
  const quoted = (reply: string) => `“${truncate(reply, 90)}”`
  const details: Cases<LineOutcome, string> = {
    done: ({ output }) => {
      const reply = outputReply(output)
      return reply === undefined ? '' : quoted(reply)
    },
    crashed: ({ error }) => errorDetail(error.message),
    stopped: ({ error, output }) => {
      const reply = outputReply(output)
      if (reply !== undefined) {
        return `Returned anyway · ${quoted(reply)}`
      }

      return error ? errorDetail(error.message) : LOST_CALL[line.lost?.kind ?? 'mid-call'].headline
    },
    paused: () => '',
  }
  return caseOf(line.outcome, 'state', details)
}

function buildRows(line: Line, entry: string, entryLane: Lane, laneFor: SequenceProps['laneFor']): Row[] {
  const rows: Row[] = line.calls.map((call) => ({
    key: `call-${call.seq}`,
    cursor: call.seq,
    kind: 'call',
    number: String(ordinal(line, call.seq)),
    functionId: call.function_id,
    lane: laneFor(call.function_id, call.worker),
    summary: summarizeAnswer(call.answer),
    call,
    error: isError(call.answer),
  }))

  if (line.outcome.state === 'paused') {
    const need = line.outcome.need
    rows.push({
      key: `paused-${need.seq}`,
      cursor: need.seq,
      kind: 'paused',
      number: String(ordinal(line, need.seq)),
      functionId: need.function_id,
      lane: laneFor(need.function_id),
      summary: 'Paused',
    })
    return rows
  }

  rows.push({ key: 'end', cursor: 'end', kind: 'end', number: '', functionId: entry, lane: entryLane, summary: endDetail(line) })
  return rows
}

function summaryTone(row: Row): 'warn' | 'alert' | undefined {
  if (row.kind === 'paused') {
    return 'warn'
  }

  return row.error ? 'alert' : undefined
}

function pct(lanes: Lane[], lane: Lane): number {
  const index = Math.max(0, lanes.findIndex((l) => l.worker === lane.worker))
  return ((index + 0.5) / Math.max(1, lanes.length)) * 100
}

/** A call a fork made once it left its parent's path, where every answer's source is worth a mark, recorded ones too. */
function onNewPath(line: Line, call: Call): boolean {
  return line.kind !== 'original' && line.branchAt !== null && call.seq >= line.branchAt
}

// One chip at most, so the column never overflows. The likely cause is shown
// by the open row and its callout, not by a chip too.
function rowChip(row: Row, line: Line, formats: Formats): ReactNode {
  const call = row.call
  if (!call) {
    return null
  }

  if (call.source !== 'recorded') {
    return <SourceChip source={call.source} />
  }

  if (isRepeatedCall(call)) {
    return (
      <Chip tone="warning" className="rw-chip">
        Caller timeout
      </Chip>
    )
  }

  const issue = callIssue(call, formats)
  if (issue) {
    return (
      <Tooltip label={issueText(issue)}>
        <Chip tone="warning" className="rw-chip" data-schema="">
          Schema
        </Chip>
      </Tooltip>
    )
  }

  return onNewPath(line, call) ? <SourceChip source="recorded" /> : null
}

function Marks({ row, line, formats }: { row: Row; line: Line; formats: Formats }) {
  return (
    <span className="rw-seq-marks">
      {rowChip(row, line, formats)}
      {row.call?.duration_ms ? <span className="rw-seq-duration">{duration(row.call.duration_ms)}</span> : null}
    </span>
  )
}

function StopGutter({ functionId, on, onToggle }: { functionId: string; on: boolean; onToggle?: (functionId: string) => void }) {
  const name = callName(functionId)
  return (
    <button
      type="button"
      className="rw-seq-gutter"
      data-on={on || undefined}
      aria-pressed={on}
      aria-label={`Stop at ${name}`}
      title={on ? `Remove stop · ${name}` : `Stop at ${name}`}
      tabIndex={-1}
      disabled={!onToggle}
      onClick={() => onToggle?.(functionId)}
    >
      <span className="rw-stop-dot" />
    </button>
  )
}

/** Where a call died with its worker: nothing was recorded for it, and the calls after it saw the error. */
function LostMarker({ kind }: { kind: LostKind }) {
  const copy = LOST_CALL[kind]
  return (
    <li className="rw-seq-lost" aria-label={copy.markerLabel}>
      <span className="rw-seq-num" />
      <span className="rw-seq-lost-body">
        <Unplug aria-hidden />
        {copy.marker}
      </span>
    </li>
  )
}

type ContentProps = { row: Row; line: Line; links: TraceLinks }

function RowName({ row, links, className }: { row: Row; links: TraceLinks; className: string }) {
  return <FnLink name={callName(row.functionId)} title={callUrl(row.functionId)} target={links.targetAt(row.cursor)} links={links} className={className} />
}

function LaneContent({ row, line, links, lanes, entryLane }: ContentProps & { lanes: Lane[]; entryLane: Lane }) {
  const from = pct(lanes, entryLane)
  const to = pct(lanes, row.lane)
  const span = { left: `${from}%`, width: `${Math.max(to - from, 3)}%` }
  const text = { left: `calc(${from}% + 10px)` }

  if (row.kind === 'end') {
    const look = endLook(line)
    const Icon = look.icon
    return (
      <>
        <span className="rw-end-mark" data-tone={look.tone} style={{ left: `${from}%` }}>
          <Icon aria-hidden />
        </span>
        <span className="rw-end-label" data-tone={look.tone} style={{ left: `calc(${from}% + 18px)` }}>
          {outcomeLook(line.outcome).short}
        </span>
        <span className="rw-answer-label" style={{ left: `calc(${from}% + 18px)` }}>
          {row.summary}
        </span>
      </>
    )
  }

  return (
    <>
      <span className="rw-call-label" style={text}>
        <RowName row={row} links={links} className="rw-fn" />
      </span>
      <span className="rw-arrow" data-kind={row.kind} style={span} />
      {row.kind === 'paused' ? (
        <span className="rw-pause-mark" style={{ left: `${to}%` }}>
          <Diamond aria-hidden />
        </span>
      ) : (
        <>
          <span className="rw-dot" data-tone={row.lane.tone} style={{ left: `${to}%` }} />
          <span className="rw-return" data-error={row.error || undefined} style={span} />
        </>
      )}
      <span className="rw-answer-label" data-tone={summaryTone(row)} style={text}>
        {row.summary}
      </span>
    </>
  )
}

function ListContent({ row, line, links }: ContentProps) {
  const end = row.kind === 'end' ? endLook(line) : null
  const EndIcon = end?.icon
  return (
    <>
      {EndIcon ? (
        <span className="rw-end-mark" data-tone={end.tone} data-inline="">
          <EndIcon aria-hidden />
        </span>
      ) : (
        <WorkerGlyph lane={row.lane} />
      )}
      <span className="rw-seq-text">
        <span className="rw-seq-fn">
          {row.kind === 'end' ? (
            <span className="rw-seq-ending" data-tone={end?.tone}>
              {outcomeLook(line.outcome).short}
            </span>
          ) : (
            <>
              <RowName row={row} links={links} className="rw-seq-name rw-fn" />
              <span className="rw-seq-worker">{row.lane.outside ? 'outside iii' : row.lane.worker}</span>
            </>
          )}
        </span>
        <span className="rw-seq-summary" data-tone={summaryTone(row)}>
          {row.summary}
        </span>
      </span>
    </>
  )
}

function rowLabel(row: Row, line: Line): string {
  const labels: Record<RowKind, () => string> = {
    call: () => `Call ${row.number} to ${callName(row.functionId)}. ${row.summary}.`,
    paused: () => `Call ${row.number} to ${callName(row.functionId)} is waiting for your answer.`,
    end: () => `How the run ended. ${outcomeLook(line.outcome).short}.`,
  }
  return labels[row.kind]()
}

function traceLabel(row: Row): string {
  return row.kind === 'end' ? 'Show the run in Traces' : `Show call ${row.number} in Traces`
}

export function SequenceView(props: SequenceProps) {
  const { line, lanes, laneFor, entry, cursor, onSelect, showLanes, expanded, decision, stops, onToggleStop, links, formats } = props
  const entryLane = laneFor(entry)
  const rows = buildRows(line, entry, entryLane, laneFor)
  const order = positions(line)
  const cursorIndex = order.indexOf(cursor)
  const listRef = useRef<HTMLOListElement>(null)

  // Arrow keys move the cursor; keep focus on the selected row so the next
  // key press continues from it.
  useEffect(() => {
    const list = listRef.current
    if (!list?.contains(document.activeElement)) {
      return
    }

    list.querySelector<HTMLButtonElement>('[aria-current="step"]')?.focus({ preventScroll: true })
  }, [cursor])

  // Bring the selected row into view with whatever opened under it, so a new
  // pause shows its decision and not only its row.
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="step"]')?.closest('li')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, line.id])

  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    const moves: Record<string, () => Cursor> = {
      ArrowDown: () => order[Math.min(order.length - 1, cursorIndex + 1)],
      ArrowUp: () => order[Math.max(0, cursorIndex - 1)],
      Home: () => order[0],
      End: () => order[order.length - 1],
    }
    const move = moves[event.key]
    if (!move || event.altKey || event.metaKey || event.ctrlKey) {
      return
    }

    if ((event.target as HTMLElement).closest('.rw-seq-expand')) {
      return
    }

    event.preventDefault()
    onSelect(move())
  }

  return (
    <div className="rw-seq" data-compact={showLanes ? undefined : ''} style={{ ['--rw-lanes' as string]: lanes.length }}>
      {showLanes ? (
        <div className="rw-seq-head" aria-hidden>
          <span className="rw-seq-num" />
          <span className="rw-seq-track">
            {lanes.map((lane) => (
              <span key={lane.worker} className="rw-lane-head" style={{ left: `${pct(lanes, lane)}%` }}>
                <WorkerGlyph lane={lane} />
                <span className="rw-lane-name">{lane.worker}</span>
              </span>
            ))}
          </span>
          <span className="rw-seq-marks" />
        </div>
      ) : null}
      <ol className="rw-seq-list" ref={listRef} aria-label={`Calls in ${line.label}`} onKeyDown={onKeyDown}>
        {rows.map((row) => {
          const selected = row.cursor === cursor
          const body = row.kind === 'paused' ? decision : selected ? expanded : undefined
          const lost = line.lost
          const lostHere = lost !== null && (row.cursor === lost.at || (row.kind === 'end' && lost.at > (line.calls.at(-1)?.seq ?? -1)))
          return (
            <Fragment key={row.key}>
              {lostHere ? <LostMarker kind={lost.kind} /> : null}
              <li className="rw-seq-item" data-open={body ? '' : undefined}>
                <button
                  type="button"
                  className="rw-seq-row"
                  data-kind={row.kind}
                  aria-current={selected ? 'step' : undefined}
                  aria-expanded={row.kind === 'paused' ? true : selected}
                  aria-label={rowLabel(row, line)}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onSelect(row.cursor)}
                >
                  <span className="rw-seq-num">{row.number}</span>
                  {showLanes ? (
                    <span className="rw-seq-track">
                      {lanes.map((lane) => (
                        <span key={lane.worker} className="rw-lane-line" style={{ left: `${pct(lanes, lane)}%` }} />
                      ))}
                      <LaneContent row={row} line={line} links={links} lanes={lanes} entryLane={entryLane} />
                    </span>
                  ) : (
                    <ListContent row={row} line={line} links={links} />
                  )}
                  <Marks row={row} line={line} formats={formats} />
                </button>
                <TraceButton target={links.targetAt(row.cursor)} links={links} label={traceLabel(row)} focusable={selected} />
                {row.kind === 'end' ? null : <StopGutter functionId={row.functionId} on={stops.includes(row.functionId)} onToggle={onToggleStop} />}
                {body ? <div className="rw-seq-expand">{body}</div> : null}
              </li>
            </Fragment>
          )
        })}
      </ol>
    </div>
  )
}

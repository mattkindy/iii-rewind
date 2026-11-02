/**
 * The original and its forks as a small graph: one row per line, one node per
 * call, a fork branching off its parent at the call it changed. Clicking a node
 * moves the cursor there, so the graph doubles as a scrubber.
 */
import type { LucideIcon } from 'lucide-react'
import { CircleAlert, CircleCheck, CircleDot, CircleX, Diamond, GitFork, LifeBuoy, Play, Unplug } from 'lucide-react'
import type { CSSProperties } from 'react'
import { isError } from '../model/answers'
import { returnedFailed } from '../model/appOutput'
import { type Cases, caseOf } from '../model/cases'
import { type Cursor, type Line, type LineKind, type LineOutcome, ordinal } from '../model/lines'
import { outcomeLook } from '../model/outcomes'
import { SOURCES } from '../model/sources'

const COL = 22
const PAD = 12
const ROW = 32

const LINE_ICON: Record<LineKind, LucideIcon> = { original: CircleDot, replay: Play, fork: GitFork, recovery: LifeBuoy }

/** `cursor` is where clicking the line's end mark moves the cursor. */
type EndMark = { icon: LucideIcon; tone: string; cursor: Cursor }

const END_MARKS: Cases<LineOutcome, EndMark> = {
  done: ({ output }) => (returnedFailed(output) ? { icon: CircleAlert, tone: 'warn', cursor: 'end' } : { icon: CircleCheck, tone: 'ok', cursor: 'end' }),
  crashed: () => ({ icon: CircleX, tone: 'alert', cursor: 'end' }),
  stopped: () => ({ icon: Unplug, tone: 'ink', cursor: 'end' }),
  paused: ({ need }) => ({ icon: Diamond, tone: 'warn', cursor: need.seq }),
}

function lastSeq(line: Line, base: number): number {
  const fromCalls = line.calls.at(-1)?.seq ?? base - 1
  return line.outcome.state === 'paused' ? Math.max(fromCalls, line.outcome.need.seq - 1) : fromCalls
}

function lowestSeq(lines: Line[]): number {
  const seqs = lines.flatMap((l) => [...l.calls.map((c) => c.seq), ...(l.outcome.state === 'paused' ? [l.outcome.need.seq] : [])])
  return seqs.length > 0 ? Math.min(...seqs) : 0
}

export function ForkLines({
  lines,
  currentId,
  cursor,
  onPick,
}: {
  lines: Line[]
  currentId: string
  cursor: Cursor
  onPick: (lineId: string, cursor: Cursor | null) => void
}) {
  const base = lowestSeq(lines)
  const x = (seq: number) => PAD + (seq - base) * COL
  const widest = Math.max(...lines.map((l) => lastSeq(l, base))) + 1
  const trackWidth = x(widest) + PAD

  return (
    <div className="rw-lines" role="group" aria-label="The original and its forks" style={{ '--rw-track': `${trackWidth}px` } as CSSProperties}>
      {lines.map((line, index) => {
        const current = line.id === currentId
        const first = line.branchAt ?? base
        const end = lastSeq(line, base) + 1
        const mark = caseOf(line.outcome, 'state', END_MARKS)
        const EndIcon = mark.icon
        const LineIcon = LINE_ICON[line.kind]
        const parentIndex = lines.findIndex((l) => l.id === line.parent)
        const rowsUp = parentIndex >= 0 ? index - parentIndex : 0
        const endCursor = mark.cursor
        return (
          <div key={line.id} className="rw-line" data-current={current || undefined}>
            <button type="button" className="rw-line-label" aria-pressed={current} onClick={() => onPick(line.id, null)}>
              <LineIcon aria-hidden />
              <span className="rw-line-name">{line.label}</span>
              {line.branchAt !== null ? <span className="rw-line-meta">from call {ordinal(line, line.branchAt)}</span> : null}
            </button>
            <div className="rw-line-track">
              <span className="rw-line-rail" style={{ left: x(first), width: x(end) - x(first) }} />
              {rowsUp > 0 ? (
                <span className="rw-line-branch" style={{ left: Math.max(2, x(first - 1)), width: x(first) - Math.max(2, x(first - 1)), height: rowsUp * ROW }} />
              ) : null}
              {line.calls
                .filter((call) => call.seq >= first)
                .map((call) => (
                  <button
                    key={call.seq}
                    type="button"
                    className="rw-node"
                    data-source={call.source}
                    data-error={isError(call.answer) || undefined}
                    aria-current={current && cursor === call.seq ? 'step' : undefined}
                    aria-label={`${line.label}, call ${ordinal(line, call.seq)}, ${call.function_id}, ${SOURCES[call.source].label}`}
                    title={`${call.function_id} (${SOURCES[call.source].label.toLowerCase()})`}
                    style={{ left: x(call.seq) }}
                    onClick={() => onPick(line.id, call.seq)}
                  />
                ))}
              <button
                type="button"
                className="rw-node-end"
                data-tone={mark.tone}
                aria-current={current && cursor === endCursor ? 'step' : undefined}
                aria-label={`${line.label}: ${outcomeLook(line.outcome).short}`}
                title={outcomeLook(line.outcome).short}
                style={{ left: x(end) }}
                onClick={() => onPick(line.id, endCursor)}
              >
                <EndIcon aria-hidden />
              </button>
            </div>
            <span className="rw-line-outcome" data-tone={mark.tone}>
              {outcomeLook(line.outcome).short}
            </span>
          </div>
        )
      })}
    </div>
  )
}

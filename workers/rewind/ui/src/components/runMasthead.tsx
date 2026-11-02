/**
 * The top of a run: the request in the person's words, its short id, when it
 * ran, how long it took and how many calls it made. How it ended is the
 * ending row of the calls, so the masthead shows it only when asked to, as a
 * chip, and a view can put its own chips beside it, as the recovery view does
 * with where the recovery got to.
 */
import type { ReactNode } from 'react'
import type { RunRow } from '../client/types'
import { dayAndTime, duration, plural, requestText, shortId } from '../model/format'
import type { Line } from '../model/lines'
import { OutcomeChip } from './bits'

function callCount(run: RunRow): number {
  return Array.isArray(run.calls) ? run.calls.length : run.calls
}

/**
 * `line` adds its outcome as a chip. With `viewing`, the counts are that
 * line's: a fork shows its own number of calls, and no duration, since nothing
 * timed the fork as a whole.
 */
export function RunMasthead({ run, line, viewing, children }: { run: RunRow; line?: Line; viewing?: Line; children?: ReactNode }) {
  const request = requestText(run.input)
  const forked = viewing !== undefined && viewing.kind !== 'original'
  return (
    <header className="rw-mast">
      <div className="rw-mast-copy">
        <h2 className="rw-mast-title" title={request}>
          {request}
        </h2>
        <p className="rw-mast-meta">
          <span className="rw-mono" title={run.run_id}>
            {shortId(run.run_id)}
          </span>
          <span>{dayAndTime(run.started_at_ms)}</span>
          {forked ? null : <span>{duration(run.duration_ms)}</span>}
          <span>{plural(forked ? viewing.calls.length : callCount(run), 'call')}</span>
        </p>
      </div>
      <div className="rw-mast-end">
        {line ? <OutcomeChip outcome={line.outcome} /> : null}
        {children}
      </div>
    </header>
  )
}

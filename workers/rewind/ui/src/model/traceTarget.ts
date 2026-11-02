/**
 * Where a spot in a line is in the ADE's Traces: a trace and, when Rewind
 * knows it, the span. The recording's calls are in the run's own trace, and a
 * fork's calls are in the trace of its latest rerun, since each rerun is a
 * trace of its own. A call with no span id has no target, because opening its
 * trace alone would not say which call it was.
 */
import type { Call, RunRow } from '../client/types'
import { type Cursor, callAt, type Line, pausedNeed } from './lines'

export type TraceTarget = { traceId: string; spanId?: string }

/** The trace of the line itself: the recording's, or the fork's latest rerun. */
function lineTrace(line: Line, run: RunRow): TraceTarget | null {
  const traceId = line.kind === 'original' ? run.trace_id : line.fork?.trace_id
  const spanId = (line.kind === 'original' ? run.span_id : line.fork?.span_id) ?? undefined
  return traceId ? { traceId, spanId } : null
}

function callTrace(call: Call, line: Line, run: RunRow): TraceTarget | null {
  const traceId = call.trace_id ?? lineTrace(line, run)?.traceId
  return traceId && call.span_id ? { traceId, spanId: call.span_id } : null
}

/** What Traces should show for the cursor: the run's entry span at the ending, else the call's span. */
export function traceTargetAt(line: Line, run: RunRow, cursor: Cursor): TraceTarget | null {
  if (cursor === 'end') {
    return lineTrace(line, run)
  }

  const call = callAt(line, cursor)
  if (call) {
    return callTrace(call, line, run)
  }

  const need = pausedNeed(line)
  const traceId = need?.trace_id ?? lineTrace(line, run)?.traceId
  return need && need.seq === cursor && traceId ? { traceId, spanId: need.span_id } : null
}

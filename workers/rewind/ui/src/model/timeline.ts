/**
 * A line's calls laid out in time for the player, in ms from the run's start.
 * The original plays as recorded. A fork plays as its latest rerun ran, from
 * each call's `rerun_at_ms` and `rerun_ms`. A core that doesn't time reruns
 * leaves those out, and then the page places a fork's new calls itself: each
 * right after the call before it, live calls at their measured duration and
 * the rest at zero, with recorded calls keeping their recorded spacing. A call
 * the caller gave up on ends, for the caller, when the caller sent it again;
 * the callee's own finish is kept as well, even past the end of the run. A
 * call a dead worker took with it has no record, so it is placed in the gap
 * where the run lost it. A call that was not found because its worker was
 * already gone failed at once, so it takes no time there.
 */
import type { Call, WorkerChange } from '../client/types'
import { isError, isRepeatedCall, summarizeAnswer } from './answers'
import { type Line, ordinal } from './lines'
import type { LostKind } from './lost'
import { participantOf } from './requests'

export type Span = {
  seq: number
  /** The call's place in its line, counting from 1. */
  number: number
  call: Call
  start: number
  /** When the caller had its answer. */
  end: number
  /** When the callee finished, which is after `end` for a call the caller gave up on. */
  calleeEnd: number
  /** The caller saw an error. */
  error: boolean
  gaveUp: boolean
  summary: string
  /** The page placed this call itself, because nothing measured it. */
  placed: boolean
  /** How a call the recording never saw was lost, or null for a recorded call. */
  lost: LostKind | null
  /** Who the call went to: its worker, or for a request around iii the host. */
  who: string
}

export type PauseMark = { seq: number; number: number; functionId: string; at: number }

/** A worker connecting or going away, in ms from the run's start. */
export type WorkerShift = { at: number; worker: string; event: WorkerChange['event'] }

export type Timeline = {
  spans: Span[]
  pause: PauseMark | null
  /** When the run returned. */
  ends: number
  /** The whole axis: the run, and any worker change after it. */
  duration: number
  /** Where this line stops following the line it came from. */
  divergeAt: number | null
  /** Some calls were placed by the page instead of measured. */
  placed: boolean
  shifts: WorkerShift[]
}

/** The call a dead worker took with it. The function is known when the run's output mentions it. */
export type LostCall = { functionId?: string; worker: string }

// The agent's own work between two calls, for calls the page places itself.
const PLACED_GAP_MS = 2
// A run returns a moment after its last answer; the recording says how long.
const MAX_TAIL_MS = 40

export type Offsets = { start: number; duration: number; placed: boolean }

function hasRecordedTiming(call: Call): call is Call & { started_at_ms: number; duration_ms: number } {
  return call.source === 'recorded' && call.started_at_ms !== undefined && call.duration_ms !== undefined
}

/** A live call keeps its measured duration; an answer a person gave, or an injected error, comes back at once. */
function placedDuration(call: Call): number {
  return call.source === 'live' ? (call.duration_ms ?? 0) : 0
}

// The same call sent again before the first one finished is the caller's retry.
function retryAfter(call: Call, calls: Call[], starts: Map<number, number>): number | undefined {
  const input = JSON.stringify(call.input)
  const start = starts.get(call.seq) ?? 0
  const retry = calls.find((c) => c.seq > call.seq && c.function_id === call.function_id && JSON.stringify(c.input) === input)
  const retryStart = retry ? starts.get(retry.seq) : undefined
  return retryStart !== undefined && retryStart > start ? retryStart - start : undefined
}

function timeoutFromMessage(call: Call): number | undefined {
  const message = isError(call.answer) ? call.answer.error.message : ''
  const ms = /after about (\d+)\s*ms/.exec(message)?.[1]
  return ms === undefined ? undefined : Number(ms)
}

/** A fork's calls as its latest rerun ran them, or undefined when the core didn't time every call. */
function rerunOffsets(line: Line): Map<number, Offsets> | undefined {
  const timed = line.kind !== 'original' && line.fork?.rerun && line.calls.every((c) => c.rerun_at_ms !== undefined && c.rerun_ms !== undefined)
  if (!timed) {
    return undefined
  }

  return new Map(line.calls.map((c) => [c.seq, { start: c.rerun_at_ms ?? 0, duration: c.rerun_ms ?? 0, placed: false }]))
}

/** Each call's start and duration by seq, recorded calls at their recorded times and the rest placed after the call before. */
export function offsetsFor(calls: Call[], runStart: number): Map<number, Offsets> {
  const out = new Map<number, Offsets>()
  // Maps the recording's clock onto this line's. It is reset after a call the
  // page placed, so the next recorded call lines up after that one.
  let shift: number | null = 0
  let cursor = 0
  for (const call of calls) {
    if (hasRecordedTiming(call)) {
      const recorded = call.started_at_ms - runStart
      shift ??= cursor + PLACED_GAP_MS - recorded
      const start = recorded + shift
      out.set(call.seq, { start, duration: call.duration_ms, placed: false })
      cursor = Math.max(cursor, start + call.duration_ms)
      continue
    }

    const start = cursor + PLACED_GAP_MS
    const duration = placedDuration(call)
    out.set(call.seq, { start, duration, placed: true })
    shift = null
    cursor = Math.max(cursor, start + duration)
  }

  return out
}

function spanFor(line: Line, call: Call, offsets: Offsets, starts: Map<number, number>): Span {
  const gaveUp = isRepeatedCall(call)
  const calleeEnd = offsets.start + offsets.duration
  const waited = gaveUp ? (retryAfter(call, line.calls, starts) ?? timeoutFromMessage(call)) : undefined
  const end = waited === undefined ? calleeEnd : Math.min(calleeEnd, offsets.start + waited)
  return {
    seq: call.seq,
    number: ordinal(line, call.seq),
    call,
    start: offsets.start,
    end,
    calleeEnd,
    error: isError(call.answer),
    gaveUp,
    summary: summarizeAnswer(call.answer),
    placed: offsets.placed,
    lost: null,
    who: participantOf(call.function_id, call.worker).name,
  }
}

/**
 * A call cut off mid-call ran until its worker died, so it fills the gap up to
 * the call that got its error. A call that was not found failed at once.
 */
const LOST_SPAN: Record<LostKind, { code: string; summary: (worker: string) => string; fillsGap: boolean }> = {
  'mid-call': { code: 'invocation_stopped', summary: (worker) => `Interrupted · ${worker} stopped`, fillsGap: true },
  'not-found': { code: 'function_not_found', summary: (worker) => `Not found · ${worker} was down`, fillsGap: false },
}

function lostSpan(line: Line, spans: Span[], lost: LostCall, runEnd: number): Span | undefined {
  if (!line.lost) {
    return undefined
  }

  const { at, kind } = line.lost
  const look = LOST_SPAN[kind]
  const before = spans.filter((s) => s.seq < at).at(-1)
  const after = spans.find((s) => s.seq >= at)
  const start = (before?.end ?? 0) + PLACED_GAP_MS
  const end = look.fillsGap ? Math.max(start, (after?.start ?? runEnd) - PLACED_GAP_MS) : start
  const message = look.summary(lost.worker)
  const call: Call = {
    seq: at - 0.5,
    function_id: lost.functionId ?? lost.worker,
    worker: lost.worker,
    effects: [],
    input: null,
    answer: { error: { code: look.code, message } },
    source: 'recorded',
  }
  return { seq: call.seq, number: 0, call, start, end, calleeEnd: end, error: true, gaveUp: false, summary: message, placed: true, lost: kind, who: lost.worker }
}

function shiftsOf(changes: WorkerChange[] | undefined, runStart: number): WorkerShift[] {
  return (changes ?? []).map((c) => ({ at: c.at_ms - runStart, worker: c.worker, event: c.event })).sort((a, b) => a.at - b.at)
}

/** Whether a worker was gone at `t`: it went away, and no connection with its name came back yet. */
export function isDown(timeline: Timeline, worker: string, t: number): boolean {
  return timeline.shifts.filter((s) => s.worker === worker && s.at <= t).at(-1)?.event === 'disconnected'
}

function lastEnd(spans: Span[]): number {
  return spans.reduce((latest, span) => Math.max(latest, span.end), 0)
}

/** How long the original took to return after its last answer, which a fork's ending borrows. */
function recordedTail(original: Line, runStart: number, runDuration: number): number {
  const offsets = offsetsFor(original.calls, runStart)
  const ends = [...offsets.values()].map((o) => o.start + o.duration)
  const tail = runDuration - Math.max(0, ...ends)
  return Math.min(MAX_TAIL_MS, Math.max(1, tail))
}

export type RunTiming = { started_at_ms: number; duration_ms: number }

function endOf(line: Line, spans: Span[], pause: PauseMark | null, run: RunTiming, original: Line): number {
  const ended = Math.max(lastEnd(spans), ...spans.map((s) => s.calleeEnd))
  if (pause) {
    return pause.at + 1
  }

  if (line.kind === 'original') {
    return Math.max(run.duration_ms, ended)
  }

  // A call the stub was still holding when the rerun returned runs on past this.
  const rerun = rerunOffsets(line) ? line.fork?.rerun : undefined
  if (rerun) {
    return Math.max(rerun.duration_ms, lastEnd(spans))
  }

  return ended + recordedTail(original, run.started_at_ms, run.duration_ms)
}

// The axis runs on a little past the last worker change, so it can be seen.
const SHIFT_TAIL_MS = 200

export type TimelineExtras = { lost?: LostCall | null; workerChanges?: WorkerChange[] }

/**
 * `line`'s calls on one time axis, in ms from the run's start. `original` is
 * the recording, whose spacing a fork's recorded calls keep and whose tail a
 * fork's ending borrows. `extras.lost` adds the call a dead worker took with
 * it, and `extras.workerChanges` the moments workers came and went.
 */
export function buildTimeline(line: Line, original: Line, run: RunTiming, extras: TimelineExtras = {}): Timeline {
  const offsets = rerunOffsets(line) ?? offsetsFor(line.calls, run.started_at_ms)
  const starts = new Map([...offsets].map(([seq, o]) => [seq, o.start]))
  const recorded = line.calls.map((call) => spanFor(line, call, offsets.get(call.seq)!, starts))
  const lost = extras.lost ? lostSpan(line, recorded, extras.lost, run.duration_ms) : undefined
  const spans = lost ? [...recorded, lost].sort((a, b) => a.seq - b.seq) : recorded

  const need = line.outcome.state === 'paused' ? line.outcome.need : null
  const pause: PauseMark | null = need
    ? { seq: need.seq, number: ordinal(line, need.seq), functionId: need.function_id, at: lastEnd(spans) + PLACED_GAP_MS }
    : null

  const ends = endOf(line, spans, pause, run, original)
  const shifts = shiftsOf(extras.workerChanges, run.started_at_ms).filter((s) => s.at >= 0)
  const lastShift = shifts.at(-1)?.at ?? 0
  const calleesDone = Math.max(0, ...spans.map((s) => s.calleeEnd))
  const duration = Math.max(ends, calleesDone, lastShift > ends ? lastShift + SHIFT_TAIL_MS : 0)

  const branch = line.branchAt
  const branchSpan = branch === null ? undefined : spans.find((s) => s.seq === branch)
  const divergeAt = branch === null ? null : (branchSpan?.start ?? (pause?.seq === branch ? pause.at : null))
  return { spans, pause, ends, duration, divergeAt, placed: spans.some((s) => s.placed && !s.lost), shifts }
}

// ── reading a timeline at one moment ────────────────────────────────────

/** The calls running at `t`, as the caller saw them. */
export function activeSpans(timeline: Timeline, t: number): Span[] {
  return timeline.spans.filter((s) => s.start <= t && t < s.end)
}

/** The call the playhead is on: the one running, else the last one that started, else the first. */
export function spanAt(timeline: Timeline, t: number): Span | undefined {
  const running = activeSpans(timeline, t).at(-1)
  if (running) {
    return running
  }

  return timeline.spans.filter((s) => s.start <= t).at(-1) ?? timeline.spans[0]
}

/** Where the call list should open when the player closes at `t`. */
export function cursorAt(timeline: Timeline, t: number): number | 'end' {
  if (timeline.pause && t >= timeline.pause.at) {
    return timeline.pause.seq
  }

  if (t >= timeline.ends) {
    return 'end'
  }

  // The call list has no row for a lost call, so it opens the call that got its error.
  const span = spanAt(timeline, t)
  return span ? Math.ceil(span.seq) : 'end'
}

// A press right after a call's start goes back to the call before it, as a
// media player's previous track does.
const RESTART_GRACE_MS = 1

/** Every place the playhead can jump to, in order: each call's start, the pause, worker changes, then the end. */
export function callStops(timeline: Timeline): number[] {
  const stops = [
    ...timeline.spans.map((s) => s.start),
    ...(timeline.pause ? [timeline.pause.at] : []),
    ...timeline.shifts.map((s) => s.at),
    timeline.ends,
    timeline.duration,
  ]
  return [...new Set(stops)].sort((a, b) => a - b)
}

export function nextStop(timeline: Timeline, t: number): number {
  return callStops(timeline).find((stop) => stop > t + 0.01) ?? timeline.duration
}

export function previousStop(timeline: Timeline, t: number): number {
  return callStops(timeline).filter((stop) => stop < t - RESTART_GRACE_MS).at(-1) ?? 0
}

/** How many calls to each worker had started by `t`, so a busy edge can draw thicker. */
export function callsSoFar(timeline: Timeline, t: number): Map<string, number> {
  const counts = new Map<string, number>()
  for (const span of timeline.spans) {
    if (span.start <= t) {
      counts.set(span.who, (counts.get(span.who) ?? 0) + 1)
    }
  }

  return counts
}

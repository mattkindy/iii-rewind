/**
 * How the player's clock maps onto a run's clock. Long stretches play at real
 * time, so a 600 ms model call takes 600 ms at 1x and the person sees where the
 * time went. A clock read that takes 2 ms would be gone in a frame, so every
 * stretch between two moments that matter (a call starting, an answer
 * arriving) plays for at least MIN_STRETCH_MS. An answer that took no time,
 * such as a typed one, still gets a stretch of its own, during which the run's
 * clock stands still. The player keeps its playhead on its own clock for that
 * reason, and reads the run's time from it.
 */
import type { Span, Timeline } from './timeline'

export const MIN_STRETCH_MS = 240
/** How long a pulse takes to cross the graph, in the player's ms at 1x. */
export const TRAVEL_MS = 200

/** Matching marks on both clocks. `run` may repeat a time; `play` always rises. */
export type PlayClock = { run: number[]; play: number[] }

// Moments closer than this are drawn as one.
const SAME_MOMENT_MS = 0.5

function moments(timeline: Timeline): number[] {
  const all = [
    0,
    timeline.ends,
    timeline.duration,
    ...timeline.spans.flatMap((s) => [s.start, s.end]),
    ...(timeline.pause ? [timeline.pause.at] : []),
    ...timeline.shifts.map((s) => s.at),
  ]
  const sorted = all.filter((t) => t >= 0 && t <= timeline.duration).sort((a, b) => a - b)
  const distinct = sorted.filter((t, i) => i === 0 || t - sorted[i - 1] > SAME_MOMENT_MS)
  const instant = timeline.spans.filter((s) => s.end - s.start <= SAME_MOMENT_MS).map((s) => s.start)
  return [...distinct, ...instant].sort((a, b) => a - b)
}

export function playClock(timeline: Timeline): PlayClock {
  const run = moments(timeline)
  const play = [0]
  for (let i = 1; i < run.length; i++) {
    play.push(play[i - 1] + Math.max(run[i] - run[i - 1], MIN_STRETCH_MS))
  }

  return { run, play }
}

/**
 * The player's time for a run time. Where the run's clock stands still, the
 * start of that stretch, or its end when `late` is set.
 */
export function toPlay(clock: PlayClock, t: number, late = false): number {
  const { run, play } = clock
  const last = run.length - 1
  if (t >= run[last]) {
    return play[last]
  }

  // Before the first mark there is no stretch to be late in, so `late` changes nothing there.
  if (t < run[0]) {
    return play[0]
  }

  const exact = late ? run.lastIndexOf(t) : run.indexOf(t)
  if (exact >= 0) {
    return play[exact]
  }

  const i = run.findIndex((mark) => mark > t)
  const share = (t - run[i - 1]) / (run[i] - run[i - 1])
  return play[i - 1] + share * (play[i] - play[i - 1])
}

export function toRun(clock: PlayClock, p: number): number {
  const { run, play } = clock
  const last = play.length - 1
  if (p <= play[0]) {
    return run[0]
  }

  if (p >= play[last]) {
    return run[last]
  }

  const i = play.findIndex((mark) => mark > p)
  const share = (p - play[i - 1]) / (play[i] - play[i - 1])
  return run[i - 1] + share * (run[i] - run[i - 1])
}

export function playLength(clock: PlayClock): number {
  return clock.play.at(-1) ?? 0
}

/** When a call starts and ends on the player's clock. */
export function playSpan(clock: PlayClock, span: Span): { from: number; to: number } {
  return { from: toPlay(clock, span.start), to: toPlay(clock, span.end, true) }
}

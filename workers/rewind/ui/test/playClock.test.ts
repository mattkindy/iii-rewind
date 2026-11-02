import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MIN_STRETCH_MS, playClock, playLength, toPlay, toRun } from '../src/model/playClock'
import type { Span, Timeline } from '../src/model/timeline'

function timeline(spans: { start: number; end: number }[], ends: number): Timeline {
  return { spans: spans as Span[], pause: null, ends, duration: ends, divergeAt: null, placed: false, shifts: [] }
}

// A 10 ms clock read, a typed answer that took no time, and a 600 ms model call.
const clock = playClock(
  timeline(
    [
      { start: 0, end: 10 },
      { start: 10, end: 10 },
      { start: 600, end: 1_200 },
    ],
    1_200,
  ),
)

test('plays a short stretch for at least the minimum and a long one at its own length', () => {
  assert.equal(toPlay(clock, 10), MIN_STRETCH_MS)
  assert.equal(playLength(clock) - toPlay(clock, 600), 600)
})

test('gives an answer that took no time a stretch of its own, while the run’s clock stands still', () => {
  assert.equal(toPlay(clock, 10, true) - toPlay(clock, 10), MIN_STRETCH_MS)
})

test('maps a run time to the player and back to the same time', () => {
  for (const t of [0, 5, 10, 300, 600, 900, 1_200]) {
    assert.equal(toRun(clock, toPlay(clock, t)), t)
    assert.equal(toRun(clock, toPlay(clock, t, true)), t)
  }
})

test('pins a time before the run or after it to the player’s ends, late or not', () => {
  assert.equal(toPlay(clock, -5), 0)
  assert.equal(toPlay(clock, -5, true), 0)
  assert.equal(toPlay(clock, 5_000), playLength(clock))
})

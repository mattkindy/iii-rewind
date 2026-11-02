import assert from 'node:assert/strict'
import { test } from 'node:test'
import { offsetsFor } from '../src/model/timeline'
import { call } from './fixtures'

const RUN_START = 1_000

test('keeps recorded calls at their recorded times, from the run’s start', () => {
  const calls = [call(0, 'clock::now', undefined, { started_at_ms: 1_000, duration_ms: 10 }), call(1, 'model::complete', undefined, { started_at_ms: 1_050, duration_ms: 20 })]
  assert.deepEqual(Object.fromEntries(offsetsFor(calls, RUN_START)), {
    0: { start: 0, duration: 10, placed: false },
    1: { start: 50, duration: 20, placed: false },
  })
})

test('places an unmeasured call after the one before it, live calls at their duration and the rest at zero', () => {
  const calls = [
    call(0, 'clock::now', undefined, { started_at_ms: 1_000, duration_ms: 10 }),
    call(1, 'model::complete', undefined, { source: 'live', duration_ms: 30 }),
    call(2, 'email::send', undefined, { source: 'typed' }),
  ]
  const offsets = offsetsFor(calls, RUN_START)
  assert.deepEqual(offsets.get(1), { start: 12, duration: 30, placed: true })
  assert.deepEqual(offsets.get(2), { start: 44, duration: 0, placed: true })
})

test('lines a recorded call up after a placed one, keeping the recorded spacing from there', () => {
  const calls = [
    call(0, 'clock::now', undefined, { started_at_ms: 1_000, duration_ms: 10 }),
    call(1, 'model::complete', undefined, { source: 'typed' }),
    call(2, 'calendar::find-slot', undefined, { started_at_ms: 1_500, duration_ms: 5 }),
    call(3, 'email::send', undefined, { started_at_ms: 1_600, duration_ms: 5 }),
  ]
  const offsets = offsetsFor(calls, RUN_START)
  assert.equal(offsets.get(2)?.start, 14)
  assert.equal(offsets.get(3)?.start, 114)
})

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { FunctionRow } from '../src/client/types'
import { lostIncidents, stoppedFunction } from '../src/model/lost'
import { lostRun } from './fixtures'

describe('stoppedFunction', () => {
  test('reads the function from a reply that passes the stop on', () => {
    assert.equal(stoppedFunction({ output: { status: 'failed', reply: 'calendar::find-slot failed: invocation_stopped' } }), 'calendar::find-slot')
  })

  test('reads it from the engine’s message when the call was not found', () => {
    assert.equal(stoppedFunction({ error: { code: 'function_not_found', message: 'function_not_found: Function email::send not found' } }), 'email::send')
  })

  test('is undefined when neither the output nor the error mentions one', () => {
    assert.equal(stoppedFunction({ output: { status: 'booked' } }), undefined)
  })
})

const functions: FunctionRow[] = [
  { function_id: 'calendar::find-slot', worker: 'tools', effects: ['read-only'], recording: true },
  { function_id: 'model::complete', worker: 'model', effects: ['external'], recording: true },
]

const cutOffIn = (fn: string) => ({ output: { status: 'failed', reply: `${fn} failed: invocation_stopped` } })

describe('lostIncidents', () => {
  test('groups runs one worker cut off within seconds of each other, newest incident first', () => {
    const runs = [
      lostRun('a', { started_at_ms: 0, duration_ms: 1_000, ...cutOffIn('calendar::find-slot') }),
      lostRun('b', { started_at_ms: 2_000, duration_ms: 1_000, ...cutOffIn('calendar::find-slot') }),
      lostRun('c', { started_at_ms: 19_000, duration_ms: 1_000, ...cutOffIn('calendar::find-slot') }),
    ]
    const incidents = lostIncidents(runs, functions)
    assert.deepEqual(
      incidents.map((i) => ({ key: i.key, worker: i.worker, runs: i.runs.map((r) => r.run_id), at: i.at })),
      [
        { key: 'c', worker: 'tools', runs: ['c'], at: 20_000 },
        { key: 'a', worker: 'tools', runs: ['b', 'a'], at: 3_000 },
      ],
    )
  })

  test('keeps runs that lost calls to different workers apart, and an unknown worker as its own', () => {
    const runs = [
      lostRun('a', { started_at_ms: 0, ...cutOffIn('calendar::find-slot') }),
      lostRun('b', { started_at_ms: 10, ...cutOffIn('model::complete') }),
      lostRun('c', { started_at_ms: 20, output: { status: 'failed' } }),
    ]
    const workers = lostIncidents(runs, functions).map((i) => i.worker ?? 'unknown')
    assert.deepEqual([...workers].sort(), ['model', 'tools', 'unknown'])
  })
})

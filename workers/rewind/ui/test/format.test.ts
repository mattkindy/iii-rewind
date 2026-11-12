import assert from 'node:assert/strict'
import { test } from 'node:test'
import { droppedCalls } from '../src/model/format'

test('the recording menu says nothing about drops until Rewind has dropped a call, or when the core is older', () => {
  assert.equal(droppedCalls(undefined), null)
  assert.equal(droppedCalls({ waiting: 12, limit: 20_000, dropped: 0 }), null)
})

test('the recording menu says how many calls Rewind dropped and how many were waiting', () => {
  assert.equal(
    droppedCalls({ waiting: 20_000, limit: 20_000, dropped: 12_345 }),
    'Rewind dropped 12,345 calls since it started, because 20,000 were already waiting to be stored.',
  )
  assert.equal(droppedCalls({ waiting: 0, limit: 20_000, dropped: 1 }), 'Rewind dropped 1 call since it started, because 20,000 were already waiting to be stored.')
})

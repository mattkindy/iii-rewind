import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ForkOutcome, ForkSummary, LostRun, PauseReason } from '../src/client/types'
import { waitingGroups } from '../src/model/waiting'
import { lostRun } from './fixtures'

function recovery(outcome: ForkOutcome): ForkSummary {
  return { fork_id: 'f', run_id: 'r', parent: null, edit_at: null, namespace: 'rewind-f', mode: 'recover', auto_read: false, outcome, created_at_ms: 0 }
}

function pausedAt(run_id: string, seq: number, function_id: string, reason?: PauseReason, lost_at = 4): LostRun {
  const need = { seq, function_id, input: {}, effects: ['irreversible'], choices: ['live', 'typed', 'inject', 'stop'], reason }
  return lostRun(run_id, { lost_at, recovery: { ...recovery({ state: 'paused', need }), fork_id: `fork-${run_id}` } })
}

test('splits paused recoveries into calls lost mid-call and calls never sent, lost ones first', () => {
  const runs = [
    pausedAt('a', 6, 'email::send', 'no_answer'),
    pausedAt('b', 4, 'email::send', 'lost'),
    pausedAt('c', 4, 'email::send', 'lost'),
    lostRun('d', { recovery: recovery({ state: 'done', output: { status: 'booked' } }) }),
    lostRun('e'),
  ]
  const groups = waitingGroups(runs)
  assert.deepEqual(
    groups.map((g) => ({ key: g.key, runs: g.runs.map((w) => w.run.run_id), forks: g.runs.map((w) => w.forkId) })),
    [
      { key: 'lost:email::send', runs: ['b', 'c'], forks: ['fork-b', 'fork-c'] },
      { key: 'unsent:email::send', runs: ['a'], forks: ['fork-a'] },
    ],
  )
})

test('reads a pause with no reason, from an older core, as lost when it is at the lost call', () => {
  const groups = waitingGroups([pausedAt('a', 4, 'email::send'), pausedAt('b', 6, 'email::send')])
  assert.deepEqual(
    groups.map((g) => [g.kind, g.runs.map((w) => w.run.run_id)]),
    [
      ['lost', ['a']],
      ['unsent', ['b']],
    ],
  )
})

test('keeps a group per function', () => {
  const groups = waitingGroups([pausedAt('a', 4, 'email::send', 'lost'), pausedAt('b', 4, 'calendar::find-slot', 'lost')])
  assert.deepEqual(
    groups.map((g) => g.functionId),
    ['email::send', 'calendar::find-slot'],
  )
})

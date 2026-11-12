import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Pending, WaitingRun } from '../src/client/journalClient'
import { aboutCall, afterLine, answersFor, fromNow, groupDetail, roughDuration, runLine, waitGroups } from '../src/model/pending'

const MINUTE = 60_000

function waiting(id: string, pending: Partial<Pending> & Pick<Pending, 'kind'>): WaitingRun {
  return {
    workflow_id: id,
    function_id: 'agent::run',
    input: { request: `Book ${id}` },
    status: 'waiting',
    created_at_ms: 0,
    pending: { step: 4, function_id: 'durable::wait', since_ms: 0, ...pending },
  }
}

const APPROVAL = { kind: 'wait' as const, name: 'approval', choices: [{ label: 'Approve', value: { approved: true } }, { label: 'Decline', value: { approved: false } }] }

describe('waitGroups', () => {
  test('groups waits by name, cut-off calls by function and sleeps together, cut-off calls first and oldest run first', () => {
    const groups = waitGroups([
      waiting('a', { ...APPROVAL, since_ms: 3 * MINUTE }),
      waiting('b', { kind: 'sleep', function_id: 'durable::sleep', since_ms: 0 }),
      waiting('c', { ...APPROVAL, since_ms: MINUTE }),
      waiting('d', { kind: 'lost', function_id: 'billing::charge', since_ms: 5 * MINUTE }),
      waiting('e', { kind: 'wait', name: 'sign-off', since_ms: 2 * MINUTE }),
    ])
    assert.deepEqual(
      groups.map((group) => [group.key, group.title, group.runs.map((run) => run.workflow_id)]),
      [
        ['lost:billing::charge', 'Cut off mid-call · billing::charge', ['d']],
        ['wait:approval', 'Waiting for approval', ['c', 'a']],
        ['wait:sign-off', 'Waiting for sign-off', ['e']],
        ['sleep', 'Sleeping', ['b']],
      ],
    )
  })
})

describe('the lines a person reads', () => {
  test('say how long a group has waited and when the first of it times out or wakes', () => {
    const [approval, sleeping] = waitGroups([
      waiting('a', { ...APPROVAL, since_ms: 0, timeout_at_ms: 30 * MINUTE }),
      waiting('b', { ...APPROVAL, since_ms: MINUTE, timeout_at_ms: 31 * MINUTE }),
      waiting('c', { kind: 'sleep', since_ms: 0, wake_at_ms: 4 * MINUTE + 40_000 }),
    ])
    assert.equal(groupDetail(approval, 4 * MINUTE), '2 runs · oldest 4m ago · first times out in 26m')
    assert.equal(groupDetail(sleeping, 4 * MINUTE), '1 run · next wakes in 40s')
    assert.equal(runLine(approval.runs[1], 4 * MINUTE), 'Since 3m ago · times out in 27m')
    assert.equal(runLine(waiting('d', { kind: 'wait', name: 'x' }), MINUTE), 'Since 1m ago · no timeout')
  })

  test('round a duration to what a deadline needs', () => {
    assert.deepEqual([roughDuration(400), roughDuration(42_000), roughDuration(26 * MINUTE), roughDuration(185 * MINUTE)], ['0s', '42s', '26m', '3h 05m'])
    assert.deepEqual([fromNow(10_000, 0), fromNow(0, 10_000)], ['in 10s', '10s ago'])
  })

  test('read a wait’s detail as the call it is about when it has one', () => {
    assert.deepEqual(aboutCall({ function_id: 'email::send', input: { to: 'dana@example.com' } }), { functionId: 'email::send', input: { to: 'dana@example.com' } })
    assert.equal(aboutCall({ to: 'dana' }), undefined)
    assert.equal(aboutCall('approve the invite'), undefined)
  })

  test('say how the run went on after it was resolved', () => {
    assert.equal(afterLine(null), 'Resumed')
    assert.equal(afterLine({ workflow_id: 'a', status: 'done', output: { status: 'booked', reply: 'Booked Dana for Tuesday' } }), 'Run booked · Booked Dana for Tuesday')
    assert.equal(afterLine({ workflow_id: 'a', status: 'waiting', pending: { step: 6, function_id: 'durable::wait', kind: 'wait', name: 'approval', since_ms: 0 } }), 'Waiting again · approval')
    assert.equal(afterLine({ workflow_id: 'a', status: 'failed', error: { message: 'DIVERGED: step 3' } }), 'Run failed · DIVERGED: step 3')
  })
})

describe('answersFor', () => {
  test('offers a wait’s choices with the first one primary, or a typed value when it has none', () => {
    assert.deepEqual(answersFor(waiting('a', APPROVAL).pending).map((answer) => [answer.label, answer.request, answer.primary, answer.typed]), [
      ['Approve', { value: { approved: true } }, true, false],
      ['Decline', { value: { approved: false } }, false, false],
    ])
    assert.deepEqual(answersFor(waiting('a', { kind: 'wait', name: 'x' }).pending).map((answer) => [answer.label, answer.typed]), [['Resolve', true]])
  })

  test('wakes a sleep, and sends a cut-off call again or takes its result, with neither preselected', () => {
    assert.deepEqual(answersFor(waiting('a', { kind: 'sleep' }).pending).map((answer) => answer.label), ['Wake now'])
    assert.deepEqual(answersFor(waiting('a', { kind: 'lost' }).pending).map((answer) => [answer.label, answer.request, answer.primary]), [
      ['Send again', { action: 'execute' }, false],
      ['Enter its result', {}, false],
    ])
  })
})

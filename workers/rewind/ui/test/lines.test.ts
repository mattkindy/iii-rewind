import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { PausedNeed } from '../src/client/types'
import { branchOf, likelyCause, ordinal } from '../src/model/lines'
import { call, fork, line } from './fixtures'

const toolError = { error: { code: 'invocation_failed', message: 'unsupported type for timedelta minutes component: str' } }
const need: PausedNeed = { seq: 3, function_id: 'email::send', input: {}, effects: ['irreversible'], choices: ['typed'] }

describe('likelyCause', () => {
  test('is the answer right before the call that failed', () => {
    const calls = [call(0, 'clock::now'), call(1, 'model::complete'), call(2, 'calendar::find-slot', toolError)]
    assert.equal(likelyCause(line(calls)), 1)
  })

  test('passes over a request around iii, which does not decide the next call', () => {
    const calls = [call(0, 'model::complete'), call(1, 'fetch GET http://127.0.0.1:49335/holidays'), call(2, 'calendar::find-slot', toolError)]
    assert.equal(likelyCause(line(calls)), 0)
  })

  test('is a call the caller sent twice, before any failure after it', () => {
    const repeated = call(1, 'email::send', { error: { code: 'TIMEOUT', message: 'invocation timed out after about 1500ms' } }, { inferred: 'the caller retried' })
    const calls = [call(0, 'model::complete'), repeated, call(2, 'email::send'), call(3, 'calendar::find-slot', toolError)]
    assert.equal(likelyCause(line(calls)), 1)
  })

  test('is the last call when the run threw without any call failing', () => {
    const calls = [call(0, 'clock::now'), call(1, 'model::complete')]
    assert.equal(likelyCause(line(calls, { state: 'crashed', error: { message: 'SyntaxError: Unexpected end of JSON input' } })), 1)
  })

  test('is the last call when the first call failed', () => {
    const calls = [call(0, 'clock::now', toolError), call(1, 'model::complete')]
    assert.equal(likelyCause(line(calls)), 1)
  })

  test('is the ending for a run that succeeded, a stopped run and any fork', () => {
    const calls = [call(0, 'clock::now'), call(1, 'model::complete')]
    assert.equal(likelyCause(line(calls)), 'end')
    assert.equal(likelyCause(line(calls, { state: 'stopped' })), 'end')
    assert.equal(likelyCause(line([...calls, call(2, 'calendar::find-slot', toolError)], { state: 'done', output: {} }, { kind: 'fork' })), 'end')
  })

  test('is the paused call on a paused line', () => {
    assert.equal(likelyCause(line([call(0, 'clock::now')], { state: 'paused', need }, { kind: 'fork' })), 3)
  })
})

describe('branchOf', () => {
  test('is the edited seq for a fork with an edit', () => {
    assert.equal(branchOf(fork([call(0, 'clock::now')], { state: 'done', output: {} }, { edit_at: 1 })), 1)
  })

  test('is the first answer that did not come from the recording for a replay', () => {
    const calls = [call(0, 'clock::now'), call(1, 'model::complete'), call(2, 'model::complete', { value: {} }, { source: 'live' })]
    assert.equal(branchOf(fork(calls, { state: 'done', output: {} })), 2)
  })

  test('is the paused call when every answer so far was recorded', () => {
    assert.equal(branchOf(fork([call(0, 'clock::now')], { state: 'paused', need })), 3)
  })

  test('is null for a replay that went the recording’s way to its end', () => {
    assert.equal(branchOf(fork([call(0, 'clock::now'), call(1, 'model::complete')], { state: 'done', output: {} })), null)
  })
})

describe('ordinal', () => {
  test('counts from 1 when seqs start at 0', () => {
    const calls = [call(0, 'clock::now'), call(1, 'model::complete'), call(2, 'calendar::find-slot')]
    assert.deepEqual(
      calls.map((c) => ordinal(line(calls), c.seq)),
      [1, 2, 3],
    )
  })

  test('places a seq the line has no call for after the calls before it', () => {
    const calls = [call(0, 'clock::now'), call(1, 'model::complete'), call(2, 'calendar::find-slot')]
    assert.equal(ordinal(line(calls), 3), 4)
    assert.equal(ordinal(line([call(0, 'clock::now'), call(5, 'email::send')]), 3), 2)
  })
})

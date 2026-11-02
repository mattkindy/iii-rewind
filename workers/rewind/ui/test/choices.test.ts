import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PausedNeed } from '../src/client/types'
import { BODY_CUT, blockedReason, defaultChoice } from '../src/model/choices'

function need(effects: string[], extra: Partial<PausedNeed> = {}): PausedNeed {
  return { seq: 4, function_id: 'email::send', input: {}, effects, choices: ['live', 'typed', 'inject', 'stop'], ...extra }
}

test('a recovery starts on Skip run at any call the core would not run by itself', () => {
  for (const effects of [['irreversible'], ['writes'], [], ['external', 'irreversible'], ['frobnicates']]) {
    assert.equal(defaultChoice(need(effects), 'recover'), 'stop', JSON.stringify(effects))
  }

  assert.equal(defaultChoice(need(['read-only']), 'recover'), 'live')
})

test('a debug fork starts on live when it may run live, and on a typed answer when not', () => {
  assert.equal(defaultChoice(need(['read-only'])), 'live')
  assert.equal(defaultChoice(need(['irreversible'], { choices: ['typed', 'inject', 'stop'] })), 'typed')
})

test('a request whose body was cut says that is why it cannot run live', () => {
  const input = { method: 'POST', url: 'http://127.0.0.1:49335/email', body: '{"to":', body_truncated: { bytes: 70_000, sha256: 'aa' } }
  const cut = need(['external'], { function_id: 'http_out POST http://127.0.0.1:49335/email', input, choices: ['typed', 'inject', 'stop'] })
  assert.equal(blockedReason('live', cut), BODY_CUT)
  assert.equal(blockedReason('live', need(['irreversible'], { choices: ['typed', 'inject', 'stop'] })), 'Irreversible')
})

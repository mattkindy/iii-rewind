import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestDiverged } from '../src/client/types'
import { divergence, fieldLabel } from '../src/model/savedTests'

const FIRST_TURN = {
  turn: 1,
  today: '2026-10-27',
  tools: ['calendar::find-slot', 'email::send'],
  messages: [{ role: 'user', content: 'Book 30 minutes with Dana next Tuesday afternoon' }],
}

function sentAnotherInput(sent: Record<string, unknown>, differences: TestDiverged['differences']): TestDiverged {
  return { seq: 1, function_id: 'model::complete', input: sent, saved: { function_id: 'model::complete', input: FIRST_TURN }, differences }
}

test('a call that sent another input says which call, and each field with what the test saved and what the code sent', () => {
  const found = divergence(sentAnotherInput({ ...FIRST_TURN, today: 'Tuesday 2026-10-27' }, [{ field: '/today', saved: '2026-10-27', sent: 'Tuesday 2026-10-27' }]))
  assert.equal(found.kind, 'input')
  assert.equal(found.headline, 'Diverged at call 2 · model::complete')
  assert.equal(found.detail, 'Sent another input · 1 field changed')
  assert.deepEqual(
    found.fields.map((f) => [f.field, f.saved?.short, f.sent?.short]),
    [['today', '"2026-10-27"', '"Tuesday 2026-10-27"']],
  )
})

test('a number sent as text keeps its quotes, so "45" and 45 read as different', () => {
  const diverged: TestDiverged = {
    seq: 2,
    function_id: 'calendar::find-slot',
    input: { attendee: 'omar@example.com', day: '2026-11-04', duration: 45 },
    saved: { function_id: 'calendar::find-slot', input: { attendee: 'omar@example.com', day: '2026-11-04', duration: '45' } },
    differences: [{ field: '/duration', saved: '45', sent: 45 }],
  }
  const [field] = divergence(diverged).fields
  assert.deepEqual([field.field, field.saved?.short, field.sent?.short], ['duration', '"45"', '45'])
})

test('a field only one side has shows as missing on the other', () => {
  const found = divergence(
    sentAnotherInput({ ...FIRST_TURN, user: 'matt', today: undefined }, [
      { field: '/today', saved: '2026-10-27' },
      { field: '/user', sent: 'matt' },
    ]),
  )
  assert.equal(found.detail, 'Sent another input · 2 fields changed')
  assert.deepEqual(
    found.fields.map((f) => [f.field, f.saved?.short ?? null, f.sent?.short ?? null]),
    [
      ['today', '"2026-10-27"', null],
      ['user', null, '"matt"'],
    ],
  )
})

test('a long value is cut to one line, and the whole of it is kept for its tooltip', () => {
  const result = { attendee: 'dana@example.com', start: '2026-11-03T14:00:00-06:00', end: '2026-11-03T14:30:00-06:00' }
  const [field] = divergence(sentAnotherInput(FIRST_TURN, [{ field: '/messages/1/result', saved: result, sent: { error: 'invocation_stopped' } }])).fields
  assert.ok(field.saved?.short.endsWith('…'))
  assert.ok(field.saved && field.saved.short.length <= 56)
  assert.deepEqual(JSON.parse(field.saved?.full ?? ''), result)
})

test('a field is named the way schema problems name one, with list indexes in brackets', () => {
  const sent = { messages: [{ role: 'user' }, { role: 'tool', result: { start: 'x' } }], 'a/b': 1, '0': { tilde: 2 } }
  assert.equal(fieldLabel('/messages/1/result/start', sent, undefined), 'messages[1].result.start')
  assert.equal(fieldLabel('/messages/0', sent, undefined), 'messages[0]')
  assert.equal(fieldLabel('/a~1b', sent, undefined), 'a/b')
  assert.equal(fieldLabel('/0/tilde', sent, undefined), '0.tilde')
  assert.equal(fieldLabel('', sent, undefined), '')
})

test('a field the code no longer sends is named from what the test saved', () => {
  const saved = { messages: [{ role: 'user' }, { role: 'tool', result: 'ok' }] }
  assert.equal(fieldLabel('/messages/1/result', { messages: 'gone' }, saved), 'messages[1].result')
})

test('a whole input that differs, such as a string in place of an object, has no field name', () => {
  const [field] = divergence(sentAnotherInput({}, [{ field: '', saved: FIRST_TURN, sent: 'hello' }])).fields
  assert.equal(field.field, '')
})

test('a call the test has no answer for is a new call, with no fields', () => {
  const found = divergence({ seq: 6, function_id: 'model::complete', input: { turn: 4, messages: [] }, differences: [] })
  assert.deepEqual([found.kind, found.headline, found.detail, found.fields], ['new-call', 'Diverged at call 7 · model::complete', 'New call · the test has none here', []])
})

test('another function where the test has a call says which function the test has there', () => {
  const found = divergence({
    seq: 3,
    function_id: 'email::send',
    input: { to: 'dana@example.com' },
    saved: { function_id: 'calendar::find-slot', input: { attendee: 'dana@example.com' } },
    differences: [],
  })
  assert.deepEqual([found.kind, found.detail, found.fields], ['other-call', 'The test has calendar::find-slot here', []])
})

test('another input with no fields listed still says the call sent another input', () => {
  const found = divergence(sentAnotherInput(FIRST_TURN, []))
  assert.deepEqual([found.kind, found.detail, found.fields], ['input', 'Sent another input', []])
})

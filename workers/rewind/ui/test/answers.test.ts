import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { applyFixesFor, closeCutJson, findings } from '../src/model/answers'
import type { AnswerCheck, JsonSchema } from '../src/model/schema'

describe('closeCutJson', () => {
  test('closes at the last complete field and says what the cut took', () => {
    assert.deepEqual(closeCutJson('{"attendee":"Dana","day":"Tues'), { value: { attendee: 'Dana' }, dropped: '"day":"Tues' })
  })

  test('closes every open bracket, nested ones too', () => {
    assert.deepEqual(closeCutJson('{"slots":[1,2,{"start":"14:'), { value: { slots: [1, 2, {}] }, dropped: '"start":"14:' })
  })

  test('drops a field whose value never started', () => {
    assert.deepEqual(closeCutJson('{"attendee":"Dana","day":'), { value: { attendee: 'Dana' }, dropped: '"day":' })
  })

  test('gives up on text that is not JSON at all', () => {
    assert.equal(closeCutJson('not json'), undefined)
  })
})

const findSlot: JsonSchema = {
  type: 'object',
  required: ['attendee', 'day', 'duration'],
  properties: { attendee: { type: 'string' }, day: { type: 'string' }, duration: { type: 'integer' } },
}

function checkWithArgs(args: JsonSchema): AnswerCheck {
  const schema: JsonSchema = { type: 'object', properties: { tool_call: { type: 'object', properties: { name: { type: 'string' }, args } } } }
  return { schema, tools: (name) => (name === 'calendar::find-slot' ? findSlot : undefined) }
}

const cutCall = { tool_call: { name: 'calendar::find-slot', args: '{"attendee":"Dana","day":"Tues' } }

describe('applyFixesFor', () => {
  test('parses cut-off tool arguments into an object and marks the fields the cut took', () => {
    const fixed = applyFixesFor(cutCall, findings({ value: cutCall }), checkWithArgs({ type: ['object', 'string'] }))
    assert.deepEqual(fixed.value, { tool_call: { name: 'calendar::find-slot', args: { attendee: 'Dana' } } })
    assert.deepEqual(fixed.dropped, ['"day":"Tues'])
    assert.deepEqual(fixed.lost, { 'tool_call.args': ['day', 'duration'] })
  })

  test('writes the arguments back as JSON text when the schema allows only text', () => {
    const fixed = applyFixesFor(cutCall, findings({ value: cutCall }), checkWithArgs({ type: 'string' }))
    assert.deepEqual(fixed.value, { tool_call: { name: 'calendar::find-slot', args: '{"attendee":"Dana"}' } })
  })

  test('marks no fields when the called tool declares no input schema', () => {
    const other = { tool_call: { name: 'email::send', args: '{"to":"dana@' } }
    const fixed = applyFixesFor(other, findings({ value: other }), checkWithArgs({ type: 'object' }))
    assert.deepEqual(fixed.lost, {})
    assert.deepEqual(fixed.value, { tool_call: { name: 'email::send', args: {} } })
  })
})

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { closestBranch, type JsonSchema, lostFields, skeleton, validate } from '../src/model/schema'

const findSlot: JsonSchema = {
  type: 'object',
  required: ['attendee', 'day', 'duration'],
  properties: {
    attendee: { type: 'string' },
    day: { type: 'string', format: 'date' },
    duration: { type: 'integer', minimum: 15 },
    kind: { enum: ['call', 'meeting'] },
  },
}

describe('validate', () => {
  test('says a number sent as text is the wrong type, at its path', () => {
    assert.deepEqual(validate(findSlot, { attendee: 'Dana', day: '2026-11-03', duration: '45' }), [{ path: 'duration', message: 'expected integer, got string' }])
  })

  test('lists required fields that are missing', () => {
    assert.deepEqual(validate(findSlot, { attendee: 'Dana', day: '2026-11-03' }), [{ path: 'duration', message: 'required' }])
  })

  test('checks formats, ranges and enums', () => {
    const problems = validate(findSlot, { attendee: 'Dana', day: 'Tuesday', duration: 5, kind: 'lunch' })
    assert.deepEqual(problems, [
      { path: 'day', message: 'expected date' },
      { path: 'duration', message: 'expected at least 15' },
      { path: 'kind', message: 'expected one of call, meeting' },
    ])
  })

  test('paths an item of a list by its index', () => {
    assert.deepEqual(validate({ type: 'array', items: { type: 'string' } }, ['a', 2]), [{ path: '[1]', message: 'expected string, got number' }])
  })

  test('finds nothing wrong with a value that is not there, or a schema it does not have', () => {
    assert.deepEqual(validate(findSlot, undefined), [])
    assert.deepEqual(validate(undefined, { anything: true }), [])
  })
})

const reply: JsonSchema = { required: ['text'], properties: { text: { type: 'string' } } }
const toolCall: JsonSchema = { required: ['tool_call'], properties: { tool_call: { type: 'object' } } }

describe('closestBranch', () => {
  test('picks the branch that knows the value’s keys', () => {
    assert.deepEqual(closestBranch([toolCall, reply], { text: 'Booked' }), { index: 1, problems: [] })
  })

  test('picks the branch the value breaks least when no branch knows its keys', () => {
    assert.deepEqual(closestBranch([{ type: 'string' }, { type: 'object', required: ['a'] }], { a: 1 }), { index: 1, problems: [] })
    assert.deepEqual(closestBranch([{ type: 'object', required: ['a', 'b'] }, { type: 'string' }], { c: 1 }), {
      index: 1,
      problems: [{ path: '', message: 'expected string, got object' }],
    })
  })
})

describe('skeleton', () => {
  test('fills the required fields with empty values the schema accepts', () => {
    assert.deepEqual(skeleton(findSlot), { attendee: '', day: '', duration: 15 })
  })

  test('takes the first enum value, a const, a default and the first branch of a union', () => {
    assert.equal(skeleton({ enum: ['call', 'meeting'] }), 'call')
    assert.equal(skeleton({ const: 'v1' }), 'v1')
    assert.equal(skeleton({ type: 'integer', default: 30 }), 30)
    assert.deepEqual(skeleton({ oneOf: [reply, toolCall] }), { text: '' })
  })

  test('gives a tool call the empty input of the tool it names', () => {
    const call: JsonSchema = { type: 'object', required: ['name', 'args'], properties: { name: { const: 'calendar::find-slot' }, args: { type: 'object' } } }
    const tools = (name: string) => (name === 'calendar::find-slot' ? findSlot : undefined)
    assert.deepEqual(skeleton(call, tools), { name: 'calendar::find-slot', args: { attendee: '', day: '', duration: 15 } })
  })
})

describe('lostFields', () => {
  test('lists the field the cut went through first, then required fields still missing', () => {
    assert.deepEqual(lostFields(findSlot, { attendee: 'Dana' }, '"day":"2026-1'), ['day', 'duration'])
  })

  test('leaves out a field the closed text still has', () => {
    assert.deepEqual(lostFields(findSlot, { attendee: 'Dana', day: '2026-11-03', duration: 45 }, ''), [])
  })

  test('names only fields the tool declares', () => {
    assert.deepEqual(lostFields(findSlot, { attendee: 'Dana', day: '2026-11-03', duration: 45 }, '"note":"x'), [])
  })
})

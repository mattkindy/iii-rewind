/**
 * The JSON schemas model::complete registers as its request_format and
 * response_format. The engine stores them and never checks a call against
 * them, so a cut-off args string (bug 1) and a string duration (bug 2) still
 * get through.
 *
 * Tool arguments are described here only as an object or JSON text. The tool's
 * own request_format says what goes in them.
 */
import type { RegisterFunctionOptions } from 'iii-sdk'

type Format = NonNullable<RegisterFunctionOptions['request_format']>

export const TOOL_IDS = ['calendar::find-slot', 'email::send']

const toolId = {
  type: 'string',
  enum: TOOL_IDS,
  description: 'The function id of a tool the agent can call',
}

const userMessage = {
  type: 'object',
  description: "The person's request",
  properties: {
    role: { type: 'string', enum: ['user'] },
    content: { type: 'string', description: 'The request in plain English' },
  },
  required: ['role', 'content'],
}

const toolMessage = {
  type: 'object',
  description: 'What a tool call returned',
  properties: {
    role: { type: 'string', enum: ['tool'] },
    name: toolId,
    result: {
      description: "The tool's output, or { error } with the message the call failed with",
    },
  },
  required: ['role', 'name', 'result'],
}

export const requestFormat: Format = {
  type: 'object',
  description: 'The conversation so far. The first turn also says what day it is and which tools exist.',
  properties: {
    turn: { type: 'integer', minimum: 1, description: 'Which turn this is, starting at 1' },
    today: {
      type: 'string',
      format: 'date',
      description: "Today's date in America/Chicago. Sent on the first turn only.",
    },
    tools: {
      type: 'array',
      items: toolId,
      description: 'The tools the model may call. Sent on the first turn only.',
    },
    messages: {
      type: 'array',
      items: { oneOf: [userMessage, toolMessage] },
      description: "The person's request, then one message for each tool call so far",
    },
  },
  required: ['turn', 'messages'],
}

const toolCall = {
  type: 'object',
  title: 'Tool call',
  properties: {
    tool_call: {
      type: 'object',
      description: 'The tool the agent should call next, and what to call it with',
      properties: {
        name: toolId,
        args: {
          description:
            'The arguments for the tool, as an object or as JSON text that the agent parses. Bug 1 sends JSON text that is cut off partway.',
          oneOf: [
            { type: 'object', description: "The arguments as an object, in the shape of the tool's request_format" },
            { type: 'string', contentMediaType: 'application/json', description: 'The arguments as JSON text' },
          ],
        },
      },
      required: ['name', 'args'],
    },
  },
  required: ['tool_call'],
}

const reply = {
  type: 'object',
  title: 'Reply',
  properties: {
    text: { type: 'string', description: 'The final reply to the person' },
    status: {
      type: 'string',
      enum: ['booked', 'failed'],
      description: 'Whether the meeting was booked',
    },
  },
  required: ['text', 'status'],
}

export const responseFormat: Format = {
  type: 'object',
  description: 'Either the next tool call or the final reply',
  oneOf: [toolCall, reply],
}

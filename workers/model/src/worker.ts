/**
 * A fake language model for the scheduling agent. model::complete reads the
 * conversation so far and returns the next tool call or a final reply, after
 * a wait of 300 to 900 ms that plays the part of inference.
 *
 * Every random choice comes from one PRNG, seeded with MODEL_SEED and advanced
 * on every call. A demo session is repeatable from its seed, but asking the
 * same question twice gives a different answer, so bugs 1 and 2 in BUGS.md
 * only reproduce from a recording. Both are injected on the first turn.
 *
 * Run: III_URL=ws://127.0.0.1:49334 MODEL_SEED=412 node --import tsx src/worker.ts
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { registerWorker } from 'iii-sdk'
import { requestFormat, responseFormat } from './formats.js'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49334'
const SEED = Number(process.env.MODEL_SEED ?? 412)
const FAULT_RATE = 1 / 7

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type UserMessage = { role: 'user'; content: string }
type ToolMessage = { role: 'tool'; name: string; result: unknown }
type Message = UserMessage | ToolMessage

type CompleteInput = { turn: number; today?: string; tools?: string[]; messages: Message[] }
type ToolCall = { name: string; args: Record<string, unknown> | string }
type Answer = { tool_call: ToolCall } | { text: string; status: 'booked' | 'failed' }

type Meeting = { attendee: string; name: string; minutes: number; weekday: number }
type SlotArgs = { attendee: string; day: string; duration: number }
type Slot = { attendee: string; start: string; end: string }
type Fault = 'none' | 'truncated-args' | 'string-duration'

// mulberry32: small and fast, which is all a fake model needs.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = seededRandom(SEED)

function failed(text: string): Answer {
  return { text, status: 'failed' }
}

function userRequest(messages: Message[]): string {
  const first = messages.find((message): message is UserMessage => message.role === 'user')
  return first?.content ?? ''
}

function readRequest(text: string): Meeting | undefined {
  const name = /\bwith ([A-Za-z]+)/.exec(text)?.[1]
  const minutes = /(\d+)\s*minutes?/i.exec(text)?.[1]
  const weekday = WEEKDAYS.findIndex((day) => text.toLowerCase().includes(day.toLowerCase()))
  if (!name || !minutes || weekday < 0) {
    return undefined
  }

  return { attendee: `${name.toLowerCase()}@example.com`, name, minutes: Number(minutes), weekday }
}

/** The first date after `today` that falls on `weekday`, so "next Tuesday" asked on a Tuesday is a week out. */
function nextDate(today: string, weekday: number): string {
  const date = new Date(`${today}T00:00:00Z`)
  const daysAhead = ((weekday - date.getUTCDay() + 6) % 7) + 1
  date.setUTCDate(date.getUTCDate() + daysAhead)
  return date.toISOString().slice(0, 10)
}

// The slot start is already in Chicago time, so read the fields from the text
// rather than going through a Date in this process's time zone.
function describeStart(start: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(start)
  if (!match) {
    return start
  }

  const [, date, hours, minutes] = match
  const day = new Date(`${date}T00:00:00Z`)
  const hour = Number(hours)
  const time = `${((hour + 11) % 12) + 1}:${minutes} ${hour < 12 ? 'am' : 'pm'}`
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} at ${time}`
}

function pickFault(roll: number): Fault {
  if (roll < FAULT_RATE) {
    return 'truncated-args'
  }

  if (roll < 2 * FAULT_RATE) {
    return 'string-duration'
  }

  return 'none'
}

// Bug 1 cuts the arguments off partway through their JSON text, the way a reply
// that hit its token limit would. Bug 2 sends the duration as a string.
const applyFault: Record<Fault, (args: SlotArgs) => ToolCall['args']> = {
  none: (args) => args,
  'string-duration': (args) => ({ ...args, duration: String(args.duration) }),
  'truncated-args': (args) => {
    const text = JSON.stringify(args)
    return text.slice(0, Math.floor(text.length * (0.5 + 0.5 * random())))
  },
}

function firstTurn(input: CompleteInput): Answer {
  const meeting = readRequest(userRequest(input.messages))
  if (!meeting || !input.today) {
    return failed("I couldn't tell who to meet, for how long, or on which day.")
  }

  const args = { attendee: meeting.attendee, day: nextDate(input.today, meeting.weekday), duration: meeting.minutes }
  return { tool_call: { name: 'calendar::find-slot', args: applyFault[pickFault(random())](args) } }
}

function lastResult(messages: Message[], name: string): unknown {
  return messages.findLast((message): message is ToolMessage => message.role === 'tool' && message.name === name)?.result
}

function toolError(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || !('error' in result)) {
    return undefined
  }

  return String(result.error)
}

const afterTool: Record<string, (meeting: Meeting, messages: Message[]) => Answer> = {
  'calendar::find-slot': (meeting, messages) => {
    const slot = lastResult(messages, 'calendar::find-slot') as Slot
    const subject = `${meeting.minutes} minutes, ${WEEKDAYS[meeting.weekday]}`
    return { tool_call: { name: 'email::send', args: { to: slot.attendee, subject, start: slot.start } } }
  },
  'email::send': (meeting, messages) => {
    const slot = lastResult(messages, 'calendar::find-slot') as Slot
    return { text: `Booked ${describeStart(slot.start)} with ${meeting.name} and sent the invite.`, status: 'booked' }
  },
}

function laterTurn(input: CompleteInput): Answer {
  const last = input.messages.at(-1)
  const meeting = readRequest(userRequest(input.messages))
  if (!last || last.role !== 'tool' || !meeting) {
    return failed('I lost track of the conversation.')
  }

  const error = toolError(last.result)
  if (error !== undefined) {
    return failed(`I couldn't book it, because ${last.name} failed: ${error}`)
  }

  const step = afterTool[last.name]
  if (!step) {
    return failed(`I don't know what to do after ${last.name}.`)
  }

  return step(meeting, input.messages)
}

function answerFor(input: CompleteInput): Answer {
  if (input.turn === 1) {
    return firstTurn(input)
  }

  return laterTurn(input)
}

const worker = registerWorker(ENGINE_URL, { workerName: 'model' })

worker.registerFunction(
  'model::complete',
  async (input: CompleteInput) => {
    // Every draw for this call happens before the wait, so concurrent calls
    // take their numbers in the order they arrived.
    const delayMs = 300 + Math.floor(random() * 601)
    const answer = answerFor(input)
    await sleep(delayMs)
    return answer
  },
  {
    description: 'A fake model that picks the next tool call or writes the final reply',
    metadata: { effects: ['external'] },
    request_format: requestFormat,
    response_format: responseFormat,
  },
)

console.log(`model ready on ${ENGINE_URL} with seed ${SEED}`)

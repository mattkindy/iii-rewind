/**
 * The scheduling agent. agent::run gets the time once, then asks the model
 * what to do, checks US holidays with a plain fetch, runs the tool the model
 * picks, and passes the result back, until it replies or six turns go by.
 *
 * Rewind replays this worker in another namespace and feeds its calls from a
 * recording, so the handler never reads the clock, draws a random number, or
 * puts a namespace on a call. It acts only on what its calls return.
 *
 * Bugs 1 and 3 in BUGS.md live here: string tool arguments go through
 * JSON.parse unguarded, and email::send is retried on TIMEOUT.
 *
 * Run: III_URL=ws://127.0.0.1:49334 node --import tsx --import ../rewind/preload/node/index.mjs src/worker.ts
 */
import { registerWorker } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49334'
const HOLIDAYS_URL = process.env.HOLIDAYS_URL ?? 'http://127.0.0.1:49335'
const HOLIDAY_WEEKS = 2
const MAX_TURNS = 6
const TOOLS = ['calendar::find-slot', 'email::send']

type Message = { role: 'user'; content: string } | { role: 'tool'; name: string; result: unknown }
type ToolCall = { name: string; args: Record<string, unknown> | string }
type ModelAnswer = { tool_call: ToolCall } | { text: string; status: 'booked' | 'failed' }

type RunInput = { request: string; user?: string }
type RunOutput = { status: 'booked' | 'failed'; reply: string; turns: number }

type Holidays = { holidays: { date: string; name: string }[] }

type CallPolicy = { timeoutMs: number; retriesOnTimeout: number }

const DEFAULT_POLICY: CallPolicy = { timeoutMs: 30_000, retriesOnTimeout: 0 }

// The email provider is slow now and then, so the agent gives up early and
// tries again. Nothing tells the provider the two sends are the same invite.
const TOOL_POLICY: Record<string, CallPolicy> = {
  'email::send': { timeoutMs: 1_500, retriesOnTimeout: 1 },
}

const worker = registerWorker(ENGINE_URL, { workerName: 'agent' })

function isTimeout(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'TIMEOUT'
}

async function call<T>(functionId: string, payload: unknown, policy: CallPolicy = DEFAULT_POLICY): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await worker.call<unknown, T>({ function_id: functionId, payload, timeoutMs: policy.timeoutMs })
    } catch (error) {
      if (isTimeout(error) && attempt < policy.retriesOnTimeout) {
        continue
      }

      throw error
    }
  }
}

// A cut-off string throws SyntaxError here and takes the whole run down (bug 1).
function parseArgs(args: ToolCall['args']): Record<string, unknown> {
  if (typeof args === 'string') {
    return JSON.parse(args)
  }

  return args
}

// The holiday list comes over plain HTTP, outside iii, so only Rewind's preload sees this call.
async function holidayOn(day: string): Promise<string | undefined> {
  const response = await fetch(`${HOLIDAYS_URL}/holidays?from=${day}&weeks=${HOLIDAY_WEEKS}`)
  if (!response.ok) {
    throw new Error(`the holiday service returned ${response.status}`)
  }

  const { holidays } = (await response.json()) as Holidays
  return holidays.find((holiday) => holiday.date === day)?.name
}

/** Why a tool call can't go ahead, which the model passes on, or undefined when it can. */
async function blocked(name: string, args: Record<string, unknown>): Promise<string | undefined> {
  if (name !== 'calendar::find-slot' || typeof args.day !== 'string') {
    return undefined
  }

  const holiday = await holidayOn(args.day)
  return holiday && `${args.day} is a US holiday (${holiday})`
}

/** The tool's output, or `{ error }` with the message the SDK gave, which the model reads on its next turn. */
async function runTool(toolCall: ToolCall): Promise<unknown> {
  const args = parseArgs(toolCall.args)
  try {
    const reason = await blocked(toolCall.name, args)
    if (reason) {
      return { error: reason }
    }

    return await call(toolCall.name, args, TOOL_POLICY[toolCall.name])
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function modelInput(turn: number, today: string, messages: Message[]) {
  if (turn === 1) {
    return { turn, today, tools: TOOLS, messages: [...messages] }
  }

  return { turn, messages: [...messages] }
}

async function run(input: RunInput): Promise<RunOutput> {
  const { now } = await call<{ now: string }>('clock::now', {})
  // clock::now returns local time with its offset, so the first ten characters are today's date.
  const today = now.slice(0, 10)
  const messages: Message[] = [{ role: 'user', content: input.request }]

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const answer = await call<ModelAnswer>('model::complete', modelInput(turn, today, messages))
    if ('text' in answer) {
      return { status: answer.status, reply: answer.text, turns: turn }
    }

    const result = await runTool(answer.tool_call)
    messages.push({ role: 'tool', name: answer.tool_call.name, result })
  }

  return { status: 'failed', reply: `I gave up after ${MAX_TURNS} turns.`, turns: MAX_TURNS }
}

worker.registerFunction('agent::run', run, {
  description: 'Books a meeting from a request in plain English',
  metadata: { effects: ['writes'] },
  request_format: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description: 'What to book, in plain English, such as "Book 30 minutes with Dana next Tuesday afternoon"',
      },
      user: { type: 'string', description: 'Who is asking' },
    },
    required: ['request'],
  },
  response_format: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['booked', 'failed'], description: 'Whether the meeting was booked' },
      reply: { type: 'string', description: "The model's final reply, or why the agent gave up" },
      turns: { type: 'integer', minimum: 1, maximum: MAX_TURNS, description: 'How many times the agent asked the model' },
    },
    required: ['status', 'reply', 'turns'],
  },
})

console.log(`agent ready on ${ENGINE_URL}`)

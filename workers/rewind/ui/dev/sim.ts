/**
 * A model of the scheduling agent, its tools, and Rewind's replay rules, for
 * the mock Rewind worker. Recorded runs come out of the same agent loop that
 * forks re-run, so the page can be built without the Rust core.
 *
 * The agent loop follows workers/agent, the model and tools follow
 * docs/contract.md, and the three planted bugs from BUGS.md only happen while
 * recording. Replay follows "Replay and forks" in docs/rewind.md: each call
 * takes the next seq and gets the fork's own answer, then the recorded one
 * when function and normalized input match. Otherwise it pauses at a stop,
 * and with `auto` on it runs live when its effects allow, or gets another
 * run's newest success, and pauses only when there is none.
 */
import type { Answer, AnswerSource, Call, Choice, ErrorValue, Fork, ForkOutcome, ForkSummary, InputDifference, PauseReason, WorkerChange } from '../src/client/types'
import { contractFormats, type Formats } from './contractFormats'

export const ENTRY = 'agent::run'
const MAX_TURNS = 6
const TOOLS = ['calendar::find-slot', 'email::send']
const SEND_TIMEOUT_MS = 1500
// In a rerun, a stub answers from what it has in well under a millisecond, and the agent's own work between calls takes about one.
const STUB_MS = 0.4
const AGENT_WORK_MS = 1

export type FunctionInfo = { function_id: string; worker: string; effects: string[] } & Formats

const FORMATS = contractFormats()

export const FUNCTIONS: FunctionInfo[] = [
  { function_id: 'agent::run', worker: 'agent', effects: ['writes'], ...FORMATS['agent::run'] },
  { function_id: 'clock::now', worker: 'clock', effects: ['read-only'], ...FORMATS['clock::now'] },
  { function_id: 'model::complete', worker: 'model', effects: ['external'], ...FORMATS['model::complete'] },
  { function_id: 'calendar::find-slot', worker: 'tools', effects: ['read-only'], ...FORMATS['calendar::find-slot'] },
  { function_id: 'email::send', worker: 'tools', effects: ['irreversible'], ...FORMATS['email::send'] },
]

// Functions the mock reports with no effects, as a worker that never declared
// them would, so the page can be shot on a call whose effects nobody knows.
let undeclared = new Set<string>()

export function setUndeclared(functionIds: string[]): void {
  undeclared = new Set(functionIds)
}

export function functionInfo(functionId: string): FunctionInfo {
  const info = FUNCTIONS.find((f) => f.function_id === functionId) ?? { function_id: functionId, worker: 'unknown', effects: [] }
  return undeclared.has(functionId) ? { ...info, effects: [] } : info
}

export type RunInput = { request: string; user: string }

// ── randomness and ids ──────────────────────────────────────────────────

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hex(random: () => number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += Math.floor(random() * 16).toString(16)
  }

  return out
}

export function uuid(random: () => number): string {
  return `${hex(random, 8)}-${hex(random, 4)}-4${hex(random, 3)}-a${hex(random, 3)}-${hex(random, 12)}`
}

/** Hex made from a piece of text, the same every time, for ids that must not use the seeded generator. */
export function idFrom(text: string, length: number): string {
  let hash = 2166136261
  for (const ch of text) {
    hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0
  }

  return hex(seededRandom(hash), length)
}

/** Trace and span ids shaped like the ADE's: 32 and 16 hex characters. */
export const traceIdOf = (id: string) => idFrom(`trace:${id}`, 32)
export const spanIdOf = (id: string) => idFrom(`span:${id}`, 16)

function between(random: () => number, low: number, high: number): number {
  return Math.round(low + random() * (high - low))
}

// ── time in America/Chicago ─────────────────────────────────────────────

// Central time leaves daylight saving on 1 Nov 2026.
function chicagoOffset(day: string): string {
  return day >= '2026-11-01' ? '-06:00' : '-05:00'
}

export function chicagoIso(ms: number): string {
  const probe = new Date(ms).toISOString().slice(0, 10)
  const offsetHours = chicagoOffset(probe) === '-06:00' ? 6 : 5
  const local = new Date(ms - offsetHours * 3_600_000).toISOString().slice(0, 19)
  return `${local}${chicagoOffset(local.slice(0, 10))}`
}

// ── the fake model, as in workers/model ─────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const AFTERNOON_SLOTS = ['13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00']

type Message = { role: 'user'; content: string } | { role: 'tool'; name: string; result: unknown }
type ToolCall = { name: string; args: Record<string, unknown> | string }
type ModelAnswer = { tool_call: ToolCall } | { text: string; status: 'booked' | 'failed' }
type Meeting = { attendee: string; name: string; minutes: number; weekday: number }

export type ModelFault = 'none' | 'truncated-args' | 'string-duration'

function readRequest(text: string): Meeting | undefined {
  const name = /\bwith ([A-Za-z]+)/.exec(text)?.[1]
  const minutes = /(\d+)\s*minutes?/i.exec(text)?.[1]
  const weekday = WEEKDAYS.findIndex((day) => text.toLowerCase().includes(day.toLowerCase()))
  if (!name || !minutes || weekday < 0) {
    return undefined
  }

  return { attendee: `${name.toLowerCase()}@example.com`, name, minutes: Number(minutes), weekday }
}

// The agent code that adds the weekday sends "Tuesday 2026-10-27", so the date is the last ten characters either way.
function nextDate(today: string, weekday: number): string {
  const date = new Date(`${today.slice(-10)}T00:00:00Z`)
  const daysAhead = ((weekday - date.getUTCDay() + 6) % 7) + 1
  date.setUTCDate(date.getUTCDate() + daysAhead)
  return date.toISOString().slice(0, 10)
}

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

function userRequest(messages: Message[]): string {
  const first = messages.find((m): m is Extract<Message, { role: 'user' }> => m.role === 'user')
  return first?.content ?? ''
}

function lastResult(messages: Message[], name: string): unknown {
  return messages.findLast((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool' && m.name === name)?.result
}

function toolError(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || !('error' in result)) {
    return undefined
  }

  return String((result as { error: unknown }).error)
}

// Bug 1 cuts the arguments' JSON text off. `cutAt` is a fraction of the text,
// and 1 keeps everything but the closing brace.
function applyFault(fault: ModelFault, args: Record<string, unknown>, cutAt: number): ToolCall['args'] {
  const faults: Record<ModelFault, () => ToolCall['args']> = {
    none: () => args,
    'string-duration': () => ({ ...args, duration: String(args.duration) }),
    'truncated-args': () => {
      const text = JSON.stringify(args)
      return text.slice(0, Math.max(8, Math.floor((text.length - 1) * cutAt)))
    },
  }
  return faults[fault]()
}

type CompleteInput = { turn: number; today?: string; tools?: string[]; messages: Message[] }

const afterTool: Record<string, (meeting: Meeting, messages: Message[]) => ModelAnswer> = {
  'calendar::find-slot': (meeting, messages) => {
    const slot = lastResult(messages, 'calendar::find-slot') as { attendee: string; start: string }
    const subject = `${meeting.minutes} minutes, ${WEEKDAYS[meeting.weekday]}`
    return { tool_call: { name: 'email::send', args: { to: slot.attendee, subject, start: slot.start } } }
  },
  'email::send': (meeting, messages) => {
    const slot = lastResult(messages, 'calendar::find-slot') as { start: string }
    return { text: `Booked ${describeStart(slot.start)} with ${meeting.name} and sent the invite.`, status: 'booked' }
  },
}

export function modelAnswer(input: CompleteInput, fault: ModelFault = 'none', cutAt = 1): ModelAnswer {
  const meeting = readRequest(userRequest(input.messages))
  if (input.turn === 1) {
    if (!meeting || !input.today) {
      return { text: "I couldn't tell who to meet, for how long, or on which day.", status: 'failed' }
    }

    const args = { attendee: meeting.attendee, day: nextDate(input.today, meeting.weekday), duration: meeting.minutes }
    return { tool_call: { name: 'calendar::find-slot', args: applyFault(fault, args, cutAt) } }
  }

  const last = input.messages.at(-1)
  if (!last || last.role !== 'tool' || !meeting) {
    return { text: 'I lost track of the conversation.', status: 'failed' }
  }

  const error = toolError(last.result)
  // Arguments that did not parse get one more try, written out in full. Later
  // turns carry no date, so the retry counts from the day it runs.
  if (error?.startsWith(UNREADABLE_ARGS)) {
    const today = input.today ?? chicagoIso(Date.now()).slice(0, 10)
    const args = { attendee: meeting.attendee, day: nextDate(today, meeting.weekday), duration: meeting.minutes }
    return { tool_call: { name: last.name, args: applyFault(fault === 'truncated-args' ? 'none' : fault, args, cutAt) } }
  }

  if (error !== undefined) {
    return { text: `I couldn't book it, because ${last.name} failed: ${error}`, status: 'failed' }
  }

  const step = afterTool[last.name]
  if (!step) {
    return { text: `I don't know what to do after ${last.name}.`, status: 'failed' }
  }

  return step(meeting, input.messages)
}

// ── the tools, as in workers/tools ──────────────────────────────────────

function slotFor(attendee: string, day: string, minutes: number): { attendee: string; start: string; end: string } {
  let hash = 0
  for (const ch of `${attendee}|${day}`) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  }

  const [h, m] = AFTERNOON_SLOTS[hash % AFTERNOON_SLOTS.length].split(':').map(Number)
  const endTotal = h * 60 + m + minutes
  const pad = (n: number) => String(n).padStart(2, '0')
  const offset = chicagoOffset(day)
  return {
    attendee,
    start: `${day}T${pad(h)}:${pad(m)}:00${offset}`,
    end: `${day}T${pad(Math.floor(endTotal / 60))}:${pad(endTotal % 60)}:00${offset}`,
  }
}

export function liveAnswer(functionId: string, input: unknown, random: () => number, nowMs: number): Answer {
  const data = (input ?? {}) as Record<string, unknown>
  const live: Record<string, () => Answer> = {
    'clock::now': () => ({ value: { now: chicagoIso(nowMs) } }),
    'model::complete': () => ({ value: modelAnswer(data as unknown as CompleteInput) }),
    'calendar::find-slot': () => {
      // The Python SDK passes the message on without the exception's class.
      if (typeof data.duration !== 'number') {
        const kind = typeof data.duration === 'string' ? 'str' : 'NoneType'
        return { error: { code: 'invocation_failed', message: `unsupported type for timedelta minutes component: ${kind}` } }
      }

      return { value: slotFor(String(data.attendee), String(data.day), data.duration) }
    },
    'email::send': () => ({ value: { status: 'accepted', id: `msg_${hex(random, 12)}` } }),
  }
  const answer = live[functionId]
  if (!answer) {
    return { error: { code: 'function_not_found', message: `${functionId} has no live answer in the mock` } }
  }

  return answer()
}

// ── the agent loop, as in workers/agent ─────────────────────────────────

export type Outcome = { state: 'done'; output: unknown } | { state: 'crashed'; error: ErrorValue }

/** Returns the answer to one call the agent makes, or throws a Pause. */
export type Resolve = (functionId: string, input: unknown) => Answer

export class Pause {
  constructor(
    readonly seq: number,
    readonly functionId: string,
    readonly input: unknown,
    readonly reason: PauseReason,
  ) {}
}

class Crash {
  constructor(readonly error: ErrorValue) {}
}

function valueOrCrash(answer: Answer): unknown {
  if ('error' in answer) {
    throw new Crash({ code: answer.error.code ?? 'invocation_failed', message: answer.error.message })
  }

  return answer.value
}

function runTool(resolve: Resolve, name: string, args: unknown): unknown {
  const retries = name === 'email::send' ? 1 : 0
  for (let attempt = 0; ; attempt++) {
    const answer = resolve(name, args)
    if ('value' in answer) {
      return answer.value
    }

    if (answer.error.code === 'TIMEOUT' && attempt < retries) {
      continue
    }

    return { error: answer.error.message }
  }
}

/**
 * Which version of the agent's code runs: as recorded, with the fix for bug 1 a person makes in
 * flow C, or with that fix and the weekday added to the date the model gets on its first turn, a
 * change that makes a saved test's model call send another input.
 */
export type AgentCode = { version: string; lenientArgs: boolean; weekdayInToday?: boolean }

export const RECORDED_CODE: AgentCode = { version: 'a1f3c9e', lenientArgs: false }
export const FIXED_CODE: AgentCode = { version: 'c7d2b10', lenientArgs: true }
export const WEEKDAY_CODE: AgentCode = { version: 'e41b9d2', lenientArgs: true, weekdayInToday: true }

export const UNREADABLE_ARGS = 'the arguments were not valid JSON'

/** The date the model gets on its first turn, "2026-10-27", or "Tuesday 2026-10-27" with the weekday. */
function todayFor(code: AgentCode, today: string): string {
  if (!code.weekdayInToday) {
    return today
  }

  const weekday = new Date(`${today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
  return `${weekday} ${today}`
}

export function runAgent(input: RunInput, resolve: Resolve, code: AgentCode = RECORDED_CODE): Outcome {
  try {
    const clock = valueOrCrash(resolve('clock::now', {})) as { now?: unknown }
    const today = todayFor(code, String(clock?.now ?? '').slice(0, 10))
    const messages: Message[] = [{ role: 'user', content: input.request }]
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const modelInput = turn === 1 ? { turn, today, tools: TOOLS, messages: [...messages] } : { turn, messages: [...messages] }
      const answer = valueOrCrash(resolve('model::complete', modelInput)) as Partial<{ text: string; status: string; tool_call: ToolCall }>
      if (typeof answer?.text === 'string') {
        return { state: 'done', output: { status: answer.status, reply: answer.text, turns: turn } }
      }

      const toolCall = answer?.tool_call
      if (!toolCall || typeof toolCall.name !== 'string') {
        throw new Crash({ code: 'invocation_failed', message: "TypeError: Cannot read properties of undefined (reading 'name')" })
      }

      // The agent's JSON.parse on string arguments (bug 1). The fixed code, as
      // in the demo patch, hands the parse error to the model as the tool's
      // result, so the model's next turn is a call the recording never saw.
      let args: unknown
      try {
        args = typeof toolCall.args === 'string' ? JSON.parse(toolCall.args) : toolCall.args
      } catch (error) {
        if (!code.lenientArgs) {
          throw error
        }

        messages.push({ role: 'tool', name: toolCall.name, result: { error: `${UNREADABLE_ARGS} (${(error as Error).message})` } })
        continue
      }

      messages.push({ role: 'tool', name: toolCall.name, result: runTool(resolve, toolCall.name, args) })
    }

    return { state: 'done', output: { status: 'failed', reply: `I gave up after ${MAX_TURNS} turns.`, turns: MAX_TURNS } }
  } catch (thrown) {
    if (thrown instanceof Crash) {
      return { state: 'crashed', error: thrown.error }
    }

    // The Node SDK sends a thrown error's message and code, not its class.
    if (thrown instanceof SyntaxError) {
      return { state: 'crashed', error: { code: 'invocation_failed', message: thrown.message } }
    }

    throw thrown
  }
}

// ── recording ───────────────────────────────────────────────────────────

/** `missing-send` reaches its send after tools died, so the send fails with function_not_found. */
export type Scenario = 'ok' | 'truncated-args' | 'string-duration' | 'slow-send' | 'stopped-find-slot' | 'stopped-send' | 'missing-send'

export type RecordedCall = {
  function_id: string
  input: unknown
  answer: Answer
  inferred?: string
  invocation_id: string
  started_at_ms: number
  duration_ms: number
}

export type Recording = {
  run_id: string
  input: RunInput
  started_at_ms: number
  duration_ms: number
  calls: RecordedCall[]
  outcome: Outcome
  scenario: Scenario
  code_version: string
  worker_changes?: WorkerChange[]
  /** False for a run recorded before Rewind kept trace ids, which has none. */
  traced?: boolean
}

// The engine fails a call as soon as its worker's connection closes; the agent
// takes a moment to pass the error on. Compose has the worker back in about a second.
const NOTICED_MS = 12
const RESTART_MS = 1000

/**
 * The tools worker dying during a call and compose starting it again. The ids
 * come from their own generator, so the seeded runs stay the same.
 */
function toolsRestart(diedAt: number): WorkerChange[] {
  const ids = seededRandom(diedAt)
  const back = diedAt + RESTART_MS + (diedAt % 150)
  return [
    { at_ms: diedAt, worker: 'tools', worker_id: uuid(ids), event: 'disconnected' },
    { at_ms: back, worker: 'tools', worker_id: uuid(ids), event: 'connected' },
  ]
}

const CALL_MS: Record<string, [number, number]> = {
  'clock::now': [1, 3],
  'model::complete': [300, 900],
  'calendar::find-slot': [400, 900],
  'email::send': [150, 450],
}

export const STOPPED_MARK = 'invocation_stopped'
const STOPPED: ErrorValue = { code: STOPPED_MARK, message: 'invocation_stopped: Invocation stopped' }

const NOT_FOUND_MARK = 'function_not_found'

function notFound(functionId: string): ErrorValue {
  return { code: NOT_FOUND_MARK, message: `${NOT_FOUND_MARK}: Function ${functionId} not found in namespace default.` }
}

/** Runs the agent against live tools with the scenario's fault, the way the recorder would have seen it. */
export function recordRun(input: RunInput, startedAt: number, scenario: Scenario, random: () => number, cutAt = 1, code: AgentCode = RECORDED_CODE): Recording {
  const calls: RecordedCall[] = []
  const workerChanges: WorkerChange[] = []
  let clockMs = startedAt + between(random, 1, 3)
  let sends = 0
  let stopped = false
  const stopAt: Partial<Record<Scenario, string>> = { 'stopped-find-slot': 'calendar::find-slot', 'stopped-send': 'email::send' }

  const resolve: Resolve = (functionId, callInput) => {
    // The tools worker dies mid-call. Observers record nothing for the call,
    // and the agent gets invocation_stopped, catches it, and goes on.
    if (stopAt[scenario] === functionId && !stopped) {
      stopped = true
      clockMs += between(random, 200, 600)
      workerChanges.push(...toolsRestart(clockMs - NOTICED_MS))
      return { error: STOPPED }
    }

    // Tools died a moment before the send, so the engine has no email::send and fails it at once.
    if (scenario === 'missing-send' && functionId === 'email::send' && !stopped) {
      stopped = true
      workerChanges.push(...toolsRestart(clockMs - between(random, 150, 400)))
      clockMs += 1
      return { error: notFound(functionId) }
    }

    const [low, high] = CALL_MS[functionId] ?? [5, 20]
    const started = clockMs
    const turn = (callInput as { turn?: number }).turn
    const fault: ModelFault =
      functionId === 'model::complete' && turn === 1 && (scenario === 'truncated-args' || scenario === 'string-duration') ? scenario : 'none'
    const answer: Answer =
      functionId === 'model::complete'
        ? { value: modelAnswer(callInput as CompleteInput, fault, cutAt) }
        : liveAnswer(functionId, callInput, random, started)
    const call: RecordedCall = { function_id: functionId, input: callInput, answer, invocation_id: uuid(random), started_at_ms: started, duration_ms: between(random, low, high) }

    if (functionId === 'email::send') {
      sends += 1
    }

    // Bug 3: the provider takes 2.5 s, the agent gives up at 1.5 s and sends
    // again. The callee succeeded, so Rewind records the answer the caller saw.
    if (scenario === 'slow-send' && functionId === 'email::send' && sends === 1) {
      call.duration_ms = 2505
      const gap = SEND_TIMEOUT_MS - 1
      call.inferred = `email::send finished after ${call.duration_ms} ms, but the caller called it again with the same input after ${gap} ms, so the caller saw a timeout`
      call.answer = { error: { code: 'TIMEOUT', message: `invocation timed out after about ${gap}ms` } }
      calls.push(call)
      clockMs = started + SEND_TIMEOUT_MS + between(random, 1, 3)
      return call.answer
    }

    calls.push(call)
    clockMs = started + call.duration_ms + between(random, 1, 3)
    return answer
  }

  const outcome = runAgent(input, resolve, code)
  const recording: Recording = { run_id: uuid(random), input, started_at_ms: startedAt, duration_ms: clockMs - startedAt, calls, outcome, scenario, code_version: code.version }
  return workerChanges.length > 0 ? { ...recording, worker_changes: workerChanges } : recording
}

function mentions(value: unknown, text: string): boolean {
  return JSON.stringify(value ?? null).includes(text)
}

const MISSING = /function_not_found: Function (\S+) not found/g

// As the core: a function_not_found only means an interrupted run for a function Rewind knows.
function quotesLostCall(value: unknown): boolean {
  const text = JSON.stringify(value ?? null)
  const missing = [...text.matchAll(MISSING)].map((m) => m[1])
  return text.includes(STOPPED_MARK) || missing.some((id) => FUNCTIONS.some((f) => f.function_id === id))
}

/**
 * As the core decides it: the first call whose input quotes the lost call's
 * error, else the end when only the result does. It was lost mid-call when
 * what quotes it says invocation_stopped.
 */
export function lostCall(recording: Recording): { at: number; midCall: boolean } | null {
  const first = recording.calls.findIndex((c) => quotesLostCall(c.input))
  if (first >= 0) {
    return { at: first, midCall: mentions(recording.calls[first].input, STOPPED_MARK) }
  }

  return quotesLostCall(recording.outcome) ? { at: recording.calls.length, midCall: mentions(recording.outcome, STOPPED_MARK) } : null
}

export function lostAt(recording: Recording): number | null {
  return lostCall(recording)?.at ?? null
}

/** Where a recovery pauses as lost: only at a call its worker died while running. */
function lostMidCallAt(recording: Recording): number | null {
  const lost = lostCall(recording)
  return lost?.midCall ? lost.at : null
}

// ── replay and forks ────────────────────────────────────────────────────

/**
 * Timing as the core reports it on a fork's new calls: a live call has the
 * clock time it ran and how long it took, a typed or injected answer has only
 * the time it was given, and an edited answer has neither.
 */
export type CallTiming = { started_at_ms?: number; duration_ms?: number }

/**
 * `unasked` marks an answer Rewind chose by itself, a live call or a filled one, which fork-set may
 * drop. `input` is set only in a saved test's answers, which a call gets only when it sends that input.
 */
export type StoredAnswer = { function_id: string; answer: Answer; source: AnswerSource; timing?: CallTiming; filled_from?: string; unasked?: boolean; input?: unknown }

/** Another run's newest successful answer from a function, for a call a fork with `auto` doesn't run live. */
export type FillSource = (functionId: string) => { answer: Answer; run_id: string } | undefined

/** A live call in a fork takes about as long as the recorded ones do. */
export function liveTiming(functionId: string, random: () => number, nowMs: number): CallTiming {
  const [low, high] = CALL_MS[functionId] ?? [5, 20]
  return { started_at_ms: nowMs, duration_ms: between(random, low, high) }
}

export type StoredFork = Omit<Fork, 'calls' | 'outcome'> & {
  answers: Map<number, StoredAnswer>
  calls: Call[]
  outcome: ForkOutcome
  created_at_ms: number
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== '_caller_worker_id')
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }

  return JSON.stringify(value)
}

export function sameInput(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function collectDifferences(saved: unknown, sent: unknown, path: string, found: string[]): void {
  if (isRecord(saved) && isRecord(sent)) {
    for (const key of [...new Set([...Object.keys(saved), ...Object.keys(sent)])].sort()) {
      if (key in saved && key in sent) {
        collectDifferences(saved[key], sent[key], `${path}/${key}`, found)
        continue
      }

      found.push(`${path}/${key}`)
    }

    return
  }

  if (Array.isArray(saved) && Array.isArray(sent) && saved.length === sent.length) {
    saved.forEach((item, index) => collectDifferences(item, sent[index], `${path}/${index}`, found))
    return
  }

  if (!sameInput(saved, sent)) {
    found.push(path)
  }
}

function at(value: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>((inside, key) => (inside !== null && typeof inside === 'object' ? (inside as Record<string, unknown>)[key] : undefined), value)
}

/** Each field of the input that changed, as the core's `json::differences` reports them, with both sides' values. */
export function inputDifferences(saved: unknown, sent: unknown): InputDifference[] {
  const found: string[] = []
  collectDifferences(saved, sent, '', found)
  return found.map((field) => ({ field, saved: at(saved, field), sent: at(sent, field) }))
}

// As the core's effects.rs: a set counts only when it is not empty and every effect in it is allowed.
function only(effects: string[], allowed: string[]): boolean {
  return effects.length > 0 && effects.every((e) => allowed.includes(e))
}

/** Whether a person may run the call live: in a recovery always, since only a person can settle it. */
export function liveAllowed(effects: string[], mode: Fork['mode']): boolean {
  return mode === 'recover' || only(effects, ['pure', 'read-only', 'external'])
}

/** Whether the stub runs the call live without asking, with `auto` off. */
function runsLiveUnasked(fork: Pick<StoredFork, 'mode' | 'auto_read'>, effects: string[]): boolean {
  // As the core: in a recovery, a write, an effect nobody declared or an unknown one waits for a person.
  if (fork.mode === 'recover') {
    return only(effects, ['pure', 'read-only', 'external'])
  }

  return fork.auto_read && only(effects, ['pure', 'read-only'])
}

/** With `auto` on, the stub also runs whatever a person could run live in a debug fork. */
function autoRunsLive(fork: Pick<StoredFork, 'mode'>, effects: string[]): boolean {
  return liveAllowed(effects, 'debug') || runsLiveUnasked({ mode: fork.mode, auto_read: false }, effects)
}

export function choicesFor(effects: string[], mode: Fork['mode']): Choice[] {
  return liveAllowed(effects, mode) ? ['live', 'typed', 'inject', 'stop'] : ['typed', 'inject', 'stop']
}

const EMAIL_PROVIDER = 'http://127.0.0.1:49335/email'

/**
 * The requests a copied worker made while it ran a call, placed under it. The
 * copy's preload returns the recorded response to the email POST, so a copy
 * of tools sends nothing.
 */
function requestsInCopy(call: Call, trace: string): Call[] {
  if (call.function_id !== 'email::send' || 'error' in call.answer) {
    return []
  }

  const functionId = `http_out POST ${EMAIL_PROVIDER}`
  return [
    {
      seq: call.seq,
      path: [call.seq, 0],
      function_id: functionId,
      worker: call.worker,
      effects: ['external'],
      input: { method: 'POST', url: EMAIL_PROVIDER, body: JSON.stringify(call.input) },
      answer: { value: { status: 202, status_text: 'Accepted', body: JSON.stringify(call.answer.value) } },
      source: 'recorded',
      kind: 'http_out',
      outside_iii: true,
      method: 'POST',
      url: EMAIL_PROVIDER,
      started_at_ms: call.started_at_ms,
      duration_ms: Math.min(call.duration_ms ?? 0, 40),
      trace_id: trace,
      span_id: spanIdOf(`${trace}:${call.seq}.0`),
    },
  ]
}

// Every call in a rerun goes through a stub, so each has a span in the rerun's own trace.
function forkCall(trace: string, seq: number, functionId: string, input: unknown, stored: StoredAnswer, recorded?: RecordedCall): Call {
  const info = functionInfo(functionId)
  const call: Call = {
    seq,
    function_id: functionId,
    worker: info.worker,
    effects: info.effects,
    input,
    answer: stored.answer,
    source: stored.source,
    trace_id: trace,
    span_id: spanIdOf(`${trace}:${seq}`),
  }
  if (stored.filled_from) {
    call.filled_from = stored.filled_from
  }

  if (!recorded) {
    return { ...call, ...stored.timing }
  }

  call.invocation_id = recorded.invocation_id
  call.started_at_ms = recorded.started_at_ms
  call.duration_ms = recorded.duration_ms
  if (recorded.inferred) {
    call.inferred = recorded.inferred
  }

  return call
}

/** A fork's own answer goes to a call of the same function. A saved test's also needs the input it was saved with, as in the core. */
function fits(given: StoredAnswer, functionId: string, input: unknown): boolean {
  return given.function_id === functionId && (given.input === undefined || sameInput(given.input, input))
}

export type ReplayOptions = {
  code?: AgentCode
  /** For a check: an answer for a call the fork would otherwise pause at. */
  onMissing?: (seq: number, functionId: string, input: unknown) => StoredAnswer | undefined
  fill?: FillSource
}

/**
 * Re-runs the agent for a fork from the start, as step 4 of the spec does on
 * every answer. Seq starts at 0, as in the core. A recovery only reuses the
 * recorded calls before the lost one, because the ones after it saw the error.
 */
export function replayFork(fork: StoredFork, recording: Recording, random: () => number, nowMs: number, options: ReplayOptions = {}): StoredFork {
  const { code = RECORDED_CODE, onMissing, fill } = options
  let seq = -1
  const calls: Call[] = []
  // Each rerun is a new run of the agent, with a trace of its own.
  const trace = traceIdOf(`${fork.fork_id}:${nowMs}`)
  fork.trace_id = trace
  fork.span_id = spanIdOf(`${trace}:entry`)
  // The rerun's own clock, as the core times it: a stub answers at once, holds a
  // call the caller gave up on for as long as the recording did, and waits for
  // a call it runs live in this rerun.
  let clock = 0
  const keep = (functionId: string, input: unknown, stored: StoredAnswer, from?: RecordedCall, ranLive = false) => {
    const held = from?.inferred ? from.duration_ms : undefined
    const stubMs = held ?? (ranLive ? (stored.timing?.duration_ms ?? STUB_MS) : STUB_MS)
    calls.push({ ...forkCall(trace, seq, functionId, input, stored, from), rerun_at_ms: clock, rerun_ms: stubMs })
    clock += (held === undefined ? stubMs : SEND_TIMEOUT_MS) + AGENT_WORK_MS
  }
  const runsInCopy = (worker: string, given: StoredAnswer | undefined) => Boolean(fork.copy?.slice(1).includes(worker)) && (!given || given.unasked)
  const reusable = fork.mode === 'recover' ? (lostAt(recording) ?? recording.calls.length) : recording.calls.length
  const lostSeq = fork.mode === 'recover' ? lostMidCallAt(recording) : null

  // A call with no answer of its own and none from the recording, decided in the order the core decides it.
  // A call cut off mid-call waits for a person unless it only reads, because nobody knows whether it reached its provider.
  const decide = (functionId: string, input: unknown, effects: string[]): StoredAnswer | PauseReason => {
    if (fork.stops?.includes(functionId)) {
      return 'stop'
    }

    if (seq === lostSeq && !only(effects, ['pure', 'read-only'])) {
      return 'lost'
    }

    if (fork.auto ? autoRunsLive(fork, effects) : runsLiveUnasked(fork, effects)) {
      const timing = liveTiming(functionId, random, nowMs)
      return { function_id: functionId, answer: liveAnswer(functionId, input, random, nowMs), source: 'live', timing, unasked: true }
    }

    if (fork.auto) {
      const found = fill?.(functionId)
      return found ? { function_id: functionId, answer: found.answer, source: 'filled', filled_from: found.run_id, unasked: true } : 'no_answer'
    }

    return onMissing?.(seq, functionId, input) ?? 'no_answer'
  }

  const resolve: Resolve = (functionId, input) => {
    seq += 1
    const info = functionInfo(functionId)
    const given = fork.answers.get(seq)
    const recorded = seq < reusable ? recording.calls[seq] : undefined
    const matches = recorded && recorded.function_id === functionId && sameInput(recorded.input, input) ? recorded : undefined
    // As in the core, a copied worker's call runs in its copy unless a person gave its answer.
    if (runsInCopy(info.worker, given?.function_id === functionId ? given : undefined)) {
      const answer = matches?.answer ?? liveAnswer(functionId, input, random, nowMs)
      keep(functionId, input, { function_id: functionId, answer, source: 'copy', timing: liveTiming(functionId, random, nowMs) }, matches, true)
      const call = calls[calls.length - 1]
      call.inner = requestsInCopy(call, trace)
      return answer
    }

    if (given && fits(given, functionId, input)) {
      keep(functionId, input, given, given.source === 'recorded' ? recording.calls[seq] : undefined)
      return given.answer
    }

    if (matches) {
      keep(functionId, input, { function_id: functionId, answer: matches.answer, source: 'recorded' }, matches)
      return matches.answer
    }

    const decided = decide(functionId, input, info.effects)
    if (typeof decided === 'string') {
      throw new Pause(seq, functionId, input, decided)
    }

    fork.answers.set(seq, decided)
    keep(functionId, input, decided, undefined, decided.source === 'live')
    return decided.answer
  }

  try {
    const outcome = runAgent(recording.input, resolve, code)
    // The copy's error reaches Rewind through the SDK, which puts the code in front.
    fork.outcome =
      outcome.state === 'crashed'
        ? { state: 'crashed', error: { code: outcome.error.code, message: `${outcome.error.code ?? 'invocation_failed'}: ${outcome.error.message}` } }
        : outcome
  } catch (thrown) {
    if (!(thrown instanceof Pause)) {
      throw thrown
    }

    const info = functionInfo(thrown.functionId)
    fork.outcome = {
      state: 'paused',
      need: {
        seq: thrown.seq,
        function_id: thrown.functionId,
        input: thrown.input,
        effects: info.effects,
        choices: choicesFor(info.effects, fork.mode),
        reason: thrown.reason,
        trace_id: trace,
        span_id: spanIdOf(`${trace}:${thrown.seq}`),
        ...(info.response_format ? { response_format: info.response_format } : {}),
      },
    }
  }

  fork.calls = calls
  fork.rerun = { started_at_ms: nowMs, duration_ms: clock + AGENT_WORK_MS }
  return fork
}

/**
 * What `rewind::fork-set` keeps: every answer a person or the recording gave,
 * and of the answers Rewind chose by itself, the ones the fork's new settings
 * would choose again.
 */
export function chosenAgain(fork: StoredFork, seq: number, stored: StoredAnswer, recording: Recording): boolean {
  if (!stored.unasked) {
    return true
  }

  if (fork.stops?.includes(stored.function_id)) {
    return false
  }

  const effects = functionInfo(stored.function_id).effects
  if (stored.source === 'live') {
    return fork.auto ? autoRunsLive(fork, effects) : runsLiveUnasked(fork, effects)
  }

  return Boolean(fork.auto) && !(fork.mode === 'recover' && seq === lostMidCallAt(recording))
}

export function publicFork(fork: StoredFork): Fork {
  const { answers: _answers, created_at_ms: _created, ...rest } = fork
  return structuredClone(rest)
}

export function forkSummary(fork: StoredFork): ForkSummary {
  const { answers: _answers, calls: _calls, ...rest } = fork
  return structuredClone(rest)
}

// ── seed data ───────────────────────────────────────────────────────────

const ATTENDEES = ['Dana', 'Priya', 'Marcus', 'Lena', 'Omar', 'Sofia']
const DURATIONS = [15, 30, 45, 60]
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

export function trafficRequest(index: number): RunInput {
  const minutes = DURATIONS[index % DURATIONS.length]
  const attendee = ATTENDEES[index % ATTENDEES.length]
  const weekday = DAYS[index % DAYS.length]
  return { request: `Book ${minutes} minutes with ${attendee} next ${weekday} afternoon`, user: 'matt' }
}

/**
 * `alongside` are runs that started `offsetMs` before this one and were still
 * going when it ran, so a worker that dies under this run cuts them off too.
 */
type Planned = { scenario: Scenario; request?: string; cutAt?: number; alongside?: Alongside[] }

type Alongside = { scenario: Scenario; request: string; offsetMs: number }

// Oldest first. The newest SyntaxError run is the concept's r-0412 request, cut
// right before its closing brace, so the quick fix restores it exactly.
const PLAN: Planned[] = [
  { scenario: 'ok' },
  { scenario: 'ok' },
  { scenario: 'truncated-args', request: 'Book 45 minutes with Omar next Thursday afternoon', cutAt: 0.62 },
  { scenario: 'ok' },
  { scenario: 'string-duration', request: 'Book 60 minutes with Lena next Friday afternoon' },
  { scenario: 'ok' },
  { scenario: 'slow-send', request: 'Book 30 minutes with Priya next Wednesday afternoon' },
  { scenario: 'ok' },
  { scenario: 'ok' },
  { scenario: 'stopped-send', request: 'Book 15 minutes with Sofia next Monday afternoon' },
  { scenario: 'truncated-args', request: 'Book 15 minutes with Marcus next Monday afternoon', cutAt: 0.8 },
  { scenario: 'ok' },
  { scenario: 'string-duration', request: 'Book 30 minutes with Omar next Tuesday afternoon' },
  { scenario: 'ok' },
  { scenario: 'ok' },
  // Tools dies under five runs at once, and a sixth reaches its send before
  // tools is back. A send comes later in a run than a calendar lookup, so the
  // runs that lose their send started a moment earlier.
  {
    scenario: 'stopped-find-slot',
    request: 'Book 45 minutes with Lee next Wednesday afternoon',
    alongside: [
      { scenario: 'missing-send', request: 'Book 30 minutes with Sofia next Thursday afternoon', offsetMs: 1_300 },
      { scenario: 'stopped-find-slot', request: 'Book 30 minutes with Dana next Friday afternoon', offsetMs: 250 },
      { scenario: 'stopped-send', request: 'Book 60 minutes with Marcus next Tuesday afternoon', offsetMs: 1_600 },
      { scenario: 'stopped-send', request: 'Book 15 minutes with Priya next Thursday afternoon', offsetMs: 1_750 },
      { scenario: 'stopped-send', request: 'Book 45 minutes with Omar next Monday afternoon', offsetMs: 1_900 },
    ],
  },
  { scenario: 'ok' },
  { scenario: 'string-duration', request: 'Book 45 minutes with Priya next Thursday afternoon' },
  { scenario: 'ok' },
  { scenario: 'ok' },
  { scenario: 'truncated-args', request: 'Book 30 minutes with Dana next Tuesday afternoon', cutAt: 1 },
  { scenario: 'ok' },
  { scenario: 'ok' },
]

// The oldest seeded runs were recorded before Rewind kept trace ids.
const UNTRACED_RUNS = 2

/**
 * Runs going on beside a planned one. Each has its own generator, so adding
 * one leaves every other seeded run as it was.
 */
function alongsideRuns(planned: Planned, startedAt: number): Recording[] {
  return (planned.alongside ?? []).map((run) => {
    const at = startedAt - run.offsetMs
    return recordRun({ request: run.request, user: 'matt' }, at, run.scenario, seededRandom(at))
  })
}

/** 27 runs over the 50 minutes before 15:12 CDT on 30 Oct 2026. */
export function seedRecordings(seed: number): Recording[] {
  const random = seededRandom(seed)
  const end = Date.parse('2026-10-30T15:12:00-05:00')
  const step = Math.floor((50 * 60_000) / PLAN.length)
  return PLAN.flatMap((planned, index) => {
    const startedAt = end - (PLAN.length - index) * step + between(random, 0, 40_000)
    const input = planned.request ? { request: planned.request, user: 'matt' } : trafficRequest(index)
    const recording = recordRun(input, startedAt, planned.scenario, random, planned.cutAt ?? 0.7)
    return [index < UNTRACED_RUNS ? { ...recording, traced: false } : recording, ...alongsideRuns(planned, startedAt)]
  })
}

/** What a burst from traffic::burst records: mostly bookings, with the bugs at roughly their documented rates. */
export function burstScenario(random: () => number): Scenario {
  const roll = random()
  if (roll < 1 / 7) {
    return 'truncated-args'
  }

  if (roll < 2 / 7) {
    return 'string-duration'
  }

  return roll < 2 / 7 + 0.07 ? 'slow-send' : 'ok'
}

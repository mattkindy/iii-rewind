/**
 * End-to-end check of Rewind against a running stack. It records runs until it
 * has one of each planted bug, checks the formats Rewind passes on and that each
 * run has a trace of its own, replays them, replays a booked run with the tools
 * worker copied, replays a calendar::find-slot call made with `iii call` as a
 * run of its own, finds a run by a call's id, forks
 * and tests the SyntaxError run, forks it again with auto on and with a stop,
 * checks every SyntaxError run against the code
 * in docs/demo-fix.patch with and without live calls, kills the tools worker
 * to recover a lost run, and approves and declines runs that wait for approval.
 *
 * Run from the repo root, after `npm --prefix scripts install`:
 *   npx tsx scripts/e2e.ts
 * III_URL is the engine (default ws://127.0.0.1:49334). III_COMPOSE_DIR is the
 * folder with data/outbox.jsonl (default the repo root). Rewind has to run the
 * agent from this repo's workers/agent, with no uncommitted changes, because the
 * patch is applied there and reverted. Compose has to restart the tools worker.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { registerWorker } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49334'
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_DIR = process.env.III_COMPOSE_DIR ?? REPO_DIR
const OUTBOX = path.join(PROJECT_DIR, 'data', 'outbox.jsonl')
const AGENT_DIR = 'workers/agent'
const DEMO_PATCH = path.join(REPO_DIR, 'docs', 'demo-fix.patch')
const CALL_TIMEOUT_MS = 180_000
// A live check makes a few model and calendar calls per run, each up to a second, one run after another.
const LIVE_CHECK_MS_PER_RUN = 10_000
const MAX_BURSTS = 6
// A slow send keeps running after the agent gives up on it, so its call is recorded, and the outbox
// written, a little after its run ends.
const SLOW_SEND_SETTLE_MS = 3_500

type ErrorAnswer = { code?: string; message: string }
type Answer = { value: unknown } | { error: ErrorAnswer }
type Call = {
  seq: number
  path?: number[]
  function_id: string
  worker: string
  effects: string[]
  input: unknown
  answer: Answer
  source: 'recorded' | 'edited' | 'injected' | 'live' | 'typed' | 'filled' | 'copy'
  filled_from?: string
  inferred?: string
  invocation_id?: string
  kind: 'iii' | 'fetch' | 'http_out' | 'function' | 'http_in'
  outside_iii: boolean
  method?: string
  url?: string
  inner?: Call[]
  trace_id?: string
  span_id?: string
  rerun_at_ms?: number
  rerun_ms?: number
}
type Schema = { type?: string; properties?: Record<string, Schema>; [key: string]: unknown }
type Need = {
  seq: number
  function_id: string
  input: unknown
  effects: string[]
  choices: string[]
  reason: 'stop' | 'no_answer' | 'lost'
  response_format?: Schema
  trace_id?: string
  span_id?: string
}
type Outcome =
  | { state: 'done'; output: unknown }
  | { state: 'crashed'; error: ErrorAnswer }
  | { state: 'paused'; need: Need }
type CodeVersion = { version: string; changed_at_ms: number }
type Fork = {
  fork_id: string
  run_id: string
  namespace: string
  mode: string
  auto: boolean
  stops: string[]
  copy: string[]
  code: CodeVersion | null
  calls: Call[]
  outcome: Outcome
  trace_id: string | null
  span_id: string | null
  rerun: { started_at_ms: number; duration_ms: number } | null
}
type AgentOutput = { status?: string; reply?: string; turns?: number }
type RunSummary = {
  run_id: string
  function_id: string
  status: string
  error?: ErrorAnswer
  input: { request?: string }
  output?: AgentOutput
  calls: number
  started_at_ms: number
  code_version: string | null
  trace_id: string | null
  span_id: string | null
}
type WorkerChange = { at_ms: number; worker: string; worker_id: string; event: 'connected' | 'disconnected' }
type RunDetail = { run: RunSummary; calls: Call[]; forks: unknown[]; worker_changes: WorkerChange[] }
type LostRun = RunSummary & { lost_at: number; mid_call: boolean; recovery: unknown }
type Status = { recording: string[]; runs: number; forks: number; target_code: CodeVersion | null }
type FunctionRow = { function_id: string; effects: string[]; request_format?: Schema; response_format?: Schema }
type FunctionInfo = { function_id: string; request_schema?: Schema; response_schema?: Schema }
type Filled = { seq: number; function_id: string; from_run_id: string }
type CheckResult = {
  run_id: string
  result: 'same' | 'different' | 'stopped'
  recorded: Outcome
  outcome: Outcome
  stopped_at?: { seq: number; function_id: string }
  code: CodeVersion
  live_calls: number
  live: { seq: number; function_id: string }[]
  filled: Filled[]
}

const worker = registerWorker(ENGINE_URL, { workerName: 'rewind-e2e' })
const results: { name: string; ok: boolean }[] = []

type Changed = { kind: string; id: string; check?: CheckResult; trace_id?: string | null }
const changes: Changed[] = []

/** Observes rewind::changed the way a console page does. The iii:: prefix keeps the handler out of traces. */
function listenForChanges(): void {
  worker.registerFunction('iii::rewind-e2e::changed', async (observed: { input: Changed }) => {
    changes.push(observed.input)
    return null
  })
  worker.observe({ function_id: 'rewind::changed', capture: ['input'] }, 'iii::rewind-e2e::changed')
}

async function call<T>(functionId: string, payload: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  return worker.call<Record<string, unknown>, T>({ function_id: functionId, payload, timeoutMs })
}

function check(name: string, ok: boolean, detail = ''): boolean {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
  return ok
}

function outboxLines(): number {
  if (!existsSync(OUTBOX)) {
    return 0
  }

  return readFileSync(OUTBOX, 'utf8').split('\n').filter((line) => line.trim() !== '').length
}

function valueOf(answer: Answer): unknown {
  return 'value' in answer ? answer.value : undefined
}

const DESCRIBE: { [S in Outcome['state']]: (outcome: Extract<Outcome, { state: S }>) => string } = {
  done: (o) => `done ${JSON.stringify(o.output)}`,
  crashed: (o) => `crashed ${o.error.code}: ${o.error.message}`,
  paused: (o) => `paused at seq ${o.need.seq} ${o.need.function_id} (choices ${o.need.choices.join(', ')})`,
}

function describeOutcome(outcome: Outcome): string {
  return (DESCRIBE[outcome.state] as (o: Outcome) => string)(outcome)
}

function sources(fork: Fork): string {
  return fork.calls.map((c) => `${c.seq}:${c.function_id}=${c.source}`).join(' ')
}

type Kind = 'booked' | 'SyntaxError' | 'TypeError' | 'sent twice'
const KINDS: Kind[] = ['booked', 'SyntaxError', 'TypeError', 'sent twice']

function sends(detail: RunDetail): number {
  return detail.calls.filter((c) => c.function_id === 'email::send').length
}

function isSyntaxError(run: RunSummary): boolean {
  return run.status === 'error' && /JSON/.test(run.error?.message ?? '')
}

const IS_KIND: Record<Kind, (detail: RunDetail) => boolean> = {
  booked: (d) => d.run.status === 'success' && d.run.output?.status === 'booked' && sends(d) === 1,
  SyntaxError: (d) => isSyntaxError(d.run),
  TypeError: (d) => d.run.status === 'success' && /timedelta/.test(d.run.output?.reply ?? ''),
  'sent twice': (d) => d.run.status === 'success' && d.run.output?.status === 'booked' && sends(d) === 2,
}

async function recordedRuns(): Promise<number> {
  return (await call<{ runs: number }>('rewind::status')).runs
}

/** The latest burst's runs, once Rewind has recorded all of them and their slow sends. */
async function burstRuns(before: number, sent: number): Promise<RunSummary[]> {
  for (let attempt = 0; attempt < 80 && (await recordedRuns()) < before + sent; attempt++) {
    await sleep(250)
  }

  // Otherwise a run that sent twice can look booked once, because its first send isn't recorded yet.
  await sleep(SLOW_SEND_SETTLE_MS)
  return call<RunSummary[]>('rewind::runs', { limit: sent })
}

type Collected = { found: Map<Kind, RunDetail>; firstBurst: RunSummary[] }

async function collectKinds(): Promise<Collected> {
  const found = new Map<Kind, RunDetail>()
  let firstBurst: RunSummary[] = []
  for (let burst = 1; burst <= MAX_BURSTS && found.size < KINDS.length; burst++) {
    const before = await recordedRuns()
    const tally = await call<{ sent: number }>('traffic::burst', { count: 30, interval_ms: 150 })
    const runs = await burstRuns(before, tally.sent)
    console.log(`  burst ${burst}: ${JSON.stringify(tally)}, ${(await recordedRuns()) - before} runs recorded`)
    if (burst === 1) {
      firstBurst = runs
    }

    for (const run of runs) {
      const detail = await call<RunDetail>('rewind::run', { run_id: run.run_id })
      const kind = KINDS.find((k) => !found.has(k) && IS_KIND[k](detail))
      if (kind) {
        found.set(kind, detail)
      }
    }
  }

  return { found, firstBurst }
}

const FORMATTED_TOOLS = ['calendar::find-slot', 'email::send']

/** Rewind passes on each function's formats as engine::functions::info reports them. */
async function checkFormats(): Promise<FunctionRow[]> {
  const rows = await call<FunctionRow[]>('rewind::functions')
  const info = await call<{ functions: FunctionInfo[] }>('engine::functions::info', { function_ids: FORMATTED_TOOLS })
  const passedOn = FORMATTED_TOOLS.filter((id) => {
    const row = rows.find((r) => r.function_id === id)
    const reported = info.functions.find((f) => f.function_id === id)
    return (
      row?.request_format !== undefined &&
      row.response_format !== undefined &&
      isDeepStrictEqual(row.request_format, reported?.request_schema) &&
      isDeepStrictEqual(row.response_format, reported?.response_schema)
    )
  })
  check(
    'rewind::functions returns the request and response formats of calendar::find-slot and email::send as the engine reports them',
    passedOn.length === FORMATTED_TOOLS.length,
    `${passedOn.join(', ') || 'neither'} matched`,
  )
  return rows
}

/** Each run in a burst is the root of a trace of its own, so opening one run in Traces shows only that run. */
async function checkRunTraces(runs: RunSummary[]): Promise<void> {
  const name = "two runs from one burst have different trace_ids, and a run's execute agent::run span is the root of its trace"
  if (runs.length < 2) {
    check(name, false, `the burst recorded ${runs.length} runs`)
    return
  }

  // The run's span is looked up in the trace store, which gets it once the agent sends its spans.
  let detail = await call<RunDetail>('rewind::run', { run_id: runs[0].run_id })
  for (let attempt = 0; attempt < 20 && !detail.run.span_id; attempt++) {
    await sleep(250)
    detail = await call<RunDetail>('rewind::run', { run_id: runs[0].run_id })
  }

  const traces = new Set(runs.map((run) => run.trace_id))
  const { span: root } = await storedSpan(detail.run.trace_id, detail.run.span_id)
  console.log(`    ${runs.length} runs in ${traces.size} traces, run ${detail.run.run_id} at ${root?.name ?? 'no span'}, parent ${root?.parent_span_id ?? 'none'}`)
  check(name, !traces.has(null) && traces.size === runs.length && root?.name === 'execute agent::run' && !root.parent_span_id)
}

/** Bug 2: the model sends a string where calendar::find-slot declares an integer, and nothing checks it. */
function checkStringDuration(found: Map<Kind, RunDetail>, rows: FunctionRow[]): void {
  const slot = found.get('TypeError')?.calls.find((c) => c.function_id === 'calendar::find-slot')
  const duration = (slot?.input as { duration?: unknown } | undefined)?.duration
  const declared = rows.find((r) => r.function_id === 'calendar::find-slot')?.request_format?.properties?.duration?.type
  check(
    'bug 2: a recorded TypeError run has duration as a string in its calendar::find-slot input, where the request format says integer',
    typeof duration === 'string' && declared === 'integer',
    `duration ${JSON.stringify(duration)}, declared ${declared}`,
  )
}

function sameEnding(recorded: RunSummary, outcome: Outcome): boolean {
  if (recorded.status === 'error') {
    return outcome.state === 'crashed' && outcome.error.message === recorded.error?.message
  }

  return outcome.state === 'done' && isDeepStrictEqual(outcome.output, recorded.output)
}

async function replayEach(found: Map<Kind, RunDetail>): Promise<void> {
  for (const kind of KINDS) {
    const detail = found.get(kind)
    if (!check(`a ${kind} run was recorded`, detail !== undefined)) {
      continue
    }

    const fork = await call<Fork>('rewind::replay', { run_id: detail!.run.run_id })
    console.log(`    run ${detail!.run.run_id} replayed as ${fork.fork_id}: ${describeOutcome(fork.outcome)}`)
    console.log(`    calls ${sources(fork)}`)
    check(`${kind}: the replay ends the way the recording did`, sameEnding(detail!.run, fork.outcome))
    const sameCalls =
      fork.calls.length === detail!.calls.length &&
      fork.calls.every((c, i) => c.source === 'recorded' && c.function_id === detail!.calls[i].function_id)
    check(`${kind}: every call came from the recording`, sameCalls, `${fork.calls.length} of ${detail!.calls.length}`)
    if (kind === 'sent twice') {
      console.log(`    inferred: ${detail!.calls.find((c) => c.inferred)?.inferred}`)
      check('sent twice: the replay made both sends', fork.calls.filter((c) => c.function_id === 'email::send').length === 2)
      checkRerunTiming(fork)
    }
  }
}

/** Every fork call is timed within the rerun, and the held first send, which outlasts the rerun, takes its whole hold. */
function checkRerunTiming(fork: Fork): void {
  const timed = fork.calls.every((c) => typeof c.rerun_at_ms === 'number' && typeof c.rerun_ms === 'number')
  const inOrder = fork.calls.every((c, i) => i === 0 || c.rerun_at_ms! >= fork.calls[i - 1].rerun_at_ms!)
  const inside = fork.calls.every((c) => c.rerun_at_ms! <= (fork.rerun?.duration_ms ?? 0) + 5)
  const held = fork.calls.find((c) => c.function_id === 'email::send')
  console.log(`    rerun ${fork.rerun?.duration_ms.toFixed(0)} ms: ${fork.calls.map((c) => `${c.seq}@${c.rerun_at_ms?.toFixed(0)}+${c.rerun_ms?.toFixed(0)}`).join(' ')}`)
  check(
    'every fork call has rerun_at_ms and rerun_ms inside its rerun, and the held send takes the caller timeout',
    fork.rerun !== null && timed && inOrder && inside && (held?.rerun_ms ?? 0) >= 1_500,
  )
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The arguments the model meant to send before they were cut off, worked out from the request and the recorded date. */
function repairedArgs(request: string, today: string) {
  const name = /\bwith ([A-Za-z]+)/.exec(request)?.[1] ?? ''
  const minutes = Number(/(\d+)\s*minutes?/i.exec(request)?.[1])
  const weekday = WEEKDAYS.findIndex((day) => request.toLowerCase().includes(day.toLowerCase()))
  const date = new Date(`${today}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + ((weekday - date.getUTCDay() + 6) % 7) + 1)
  return { attendee: `${name.toLowerCase()}@example.com`, day: date.toISOString().slice(0, 10), duration: minutes }
}

const TYPED_SEND = { status: 'accepted', id: 'msg_rewind_e2e' }

/** Live for anything that allows it, typed for an irreversible call. */
async function answerPauses(fork: Fork): Promise<Fork> {
  for (let pause = 0; pause < 10 && fork.outcome.state === 'paused'; pause++) {
    const need = fork.outcome.need
    const choice = need.choices.includes('live') && !need.effects.includes('irreversible') ? 'live' : 'typed'
    console.log(`    paused at seq ${need.seq} ${need.function_id}, answering ${choice}`)
    const value = choice === 'typed' ? { value: TYPED_SEND } : {}
    fork = await call<Fork>('rewind::answer', { fork_id: fork.fork_id, choice, ...value })
  }

  return fork
}

type RepairedEdit = { run_id: string; at_seq: number; answer: Answer; source: 'edited' }

/** The rewind::fork input that gives the SyntaxError run's model the arguments it cut off. */
function repairedEdit(detail: RunDetail): RepairedEdit {
  const now = (valueOf(detail.calls[0].answer) as { now: string }).now
  const model = detail.calls.find((c) => c.function_id === 'model::complete')!
  const args = repairedArgs(detail.run.input.request ?? '', now.slice(0, 10))
  return {
    run_id: detail.run.run_id,
    at_seq: model.seq,
    answer: { value: { tool_call: { name: 'calendar::find-slot', args } } },
    source: 'edited',
  }
}

async function forkSyntaxError(detail: RunDetail): Promise<Fork> {
  const edit = repairedEdit(detail)
  const model = detail.calls.find((c) => c.seq === edit.at_seq)!
  console.log(`    model answer at seq ${model.seq} was ${JSON.stringify(valueOf(model.answer))}`)
  console.log(`    repaired args ${JSON.stringify((valueOf(edit.answer) as ToolCallAnswer).tool_call.args)}`)
  const fork = await call<Fork>('rewind::fork', edit)
  const finished = await answerPauses(fork)
  console.log(`    ${finished.fork_id}: ${describeOutcome(finished.outcome)}`)
  console.log(`    calls ${sources(finished)}`)
  const output = finished.outcome.state === 'done' ? (finished.outcome.output as AgentOutput) : undefined
  check('the repaired fork ends done with status booked', output?.status === 'booked', output?.reply)
  return finished
}

async function saveAndTest(fork: Fork): Promise<void> {
  const saved = await call<{ path: string }>('rewind::save-test', { fork_id: fork.fork_id, name: 'e2e-syntax-repair' })
  console.log(`    saved ${saved.path}`)
  const tested = await call<{ pass: boolean; expected: unknown; outcome: Outcome }>('rewind::test', { path: saved.path })
  check('the saved test passes', tested.pass, `expected ${JSON.stringify(tested.expected)}, got ${describeOutcome(tested.outcome)}`)
}

/** The fork's email::send, when it got another run's answer instead of being sent. */
function filledSend(fork: Fork): Call | undefined {
  const send = fork.calls.find((c) => c.function_id === 'email::send')
  const fromAnotherRun = send?.source === 'filled' && send.filled_from !== undefined && send.filled_from !== fork.run_id
  return fromAnotherRun ? send : undefined
}

function pausedAtStop(fork: Fork, functionId: string): boolean {
  return fork.outcome.state === 'paused' && fork.outcome.need.function_id === functionId && fork.outcome.need.reason === 'stop'
}

function reachedReply(fork: Fork): boolean {
  return fork.outcome.state === 'done' && typeof (fork.outcome.output as AgentOutput).reply === 'string'
}

/** With auto on, the repaired fork runs to a reply on safe defaults, and pauses only at a stop someone set. */
async function autoForkSyntaxError(detail: RunDetail, sendFormat: Schema | undefined): Promise<void> {
  const outboxBefore = outboxLines()
  const edit = repairedEdit(detail)
  const auto = await call<Fork>('rewind::fork', { ...edit, auto: true })
  console.log(`    ${auto.fork_id}: ${describeOutcome(auto.outcome)}`)
  console.log(`    calls ${sources(auto)}`)
  const send = filledSend(auto)
  check(
    'an auto fork of the SyntaxError run, with the cut-off answer fixed, reaches a reply without pausing, with email::send filled from another run and the outbox unchanged',
    auto.auto && reachedReply(auto) && send !== undefined && outboxLines() === outboxBefore,
    send ? `filled from ${send.filled_from}` : 'email::send was not filled',
  )

  const stopped = await call<Fork>('rewind::fork', { ...edit, auto: true, stops: ['email::send'] })
  const stoppedLater = await call<Fork>('rewind::fork-set', { fork_id: auto.fork_id, stops: ['email::send'] })
  console.log(`    ${stopped.fork_id} with the stop: ${describeOutcome(stopped.outcome)}`)
  console.log(`    ${stoppedLater.fork_id} after fork-set adds it: ${describeOutcome(stoppedLater.outcome)}`)
  check(
    'with stops: ["email::send"], the auto fork pauses at email::send with reason stop, whether the stop came first or from fork-set',
    pausedAtStop(stopped, 'email::send') && isDeepStrictEqual(stopped.stops, ['email::send']) && pausedAtStop(stoppedLater, 'email::send'),
  )
  const need = stopped.outcome.state === 'paused' ? stopped.outcome.need : undefined
  check(
    "the fork paused at email::send gives email::send's response format in its need, the same as rewind::functions",
    sendFormat !== undefined && isDeepStrictEqual(need?.response_format, sendFormat),
  )

  // Finishing both also stops their copies before the patch below changes the agent's code.
  const finished = await call<Fork>('rewind::fork-set', { fork_id: stopped.fork_id, stops: [] })
  const finishedLater = await call<Fork>('rewind::fork-set', { fork_id: auto.fork_id, stops: [] })
  console.log(`    ${finished.fork_id} without the stop: ${describeOutcome(finished.outcome)}`)
  console.log(`    calls ${sources(finished)}`)
  const keptEdit = (fork: Fork) => fork.calls.find((c) => c.seq === edit.at_seq)?.source === 'edited'
  check(
    'fork-set that removes the stop finishes the fork, keeping the repaired answer and filling the send again',
    [finished, finishedLater].every((f) => reachedReply(f) && f.auto && f.stops.length === 0 && keptEdit(f) && filledSend(f) !== undefined),
  )
  check('the auto forks sent nothing, so the outbox is unchanged', outboxLines() === outboxBefore, `${outboxBefore} lines before and after`)
}

async function findByCallId(detail: RunDetail): Promise<void> {
  const callId = detail.calls.at(-1)?.invocation_id ?? ''
  const prefix = callId.slice(0, 8)
  const found = await call<RunSummary[]>('rewind::runs', { q: prefix })
  console.log(`    run ${detail.run.run_id}, call ${callId} (${detail.calls.at(-1)?.function_id})`)
  check(
    "rewind::runs finds a run by a prefix of one of its calls' invocation ids",
    prefix !== '' && !detail.run.run_id.startsWith(prefix) && found.some((run) => run.run_id === detail.run.run_id),
    `q ${prefix} matched ${found.length} run(s)`,
  )
}

function holidayFetch(calls: Call[]): Call | undefined {
  return calls.find((c) => c.kind === 'fetch' && c.function_id.startsWith('fetch GET ') && c.url?.includes('/holidays?'))
}

function checkFetchRecorded(detail: RunDetail): Call | undefined {
  const fetched = holidayFetch(detail.calls)
  console.log(`    run ${detail.run.run_id}: ${fetched ? `seq ${fetched.seq} ${fetched.function_id}` : 'no holiday fetch'}`)
  const status = (valueOf(fetched?.answer ?? { value: null }) as { status?: number } | null)?.status
  check(
    'a recorded run shows its holiday fetch as a read-only call outside iii',
    fetched !== undefined && fetched.outside_iii && fetched.method === 'GET' && isDeepStrictEqual(fetched.effects, ['read-only']) && status === 200,
    fetched ? `${fetched.worker}, effects ${fetched.effects.join(', ')}, status ${status}` : '',
  )
  return fetched
}

/** The tools worker POSTs each invite to the email provider in Python, which only its preload sees. */
function checkEmailPost(detail: RunDetail): void {
  const send = detail.calls.find((c) => c.function_id === 'email::send')
  const post = send?.inner?.find((c) => c.kind === 'http_out')
  console.log(`    ${send?.function_id} at seq ${send?.seq}: ${post ? post.function_id : 'nothing inside'}`)
  const status = (valueOf(post?.answer ?? { value: null }) as { status?: number } | null)?.status
  check(
    'the Python POST to the email provider is recorded under email::send as an irreversible call outside iii',
    post !== undefined &&
      post.outside_iii &&
      post.method === 'POST' &&
      (post.url ?? '').endsWith('/email') &&
      post.worker === 'tools' &&
      isDeepStrictEqual(post.effects, ['external', 'irreversible']) &&
      status === 200,
    post ? `seq ${post.seq}, status ${status}` : '',
  )
  check('the POST is not one of the run calls, since replays answer email::send itself', !detail.calls.some((c) => c.kind === 'http_out'))
}

async function serverAnswers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) })
    return true
  } catch {
    return false
  }
}

/** The holiday server lives in the clock worker, so pausing that process takes the server down. */
async function replayWithServerStopped(detail: RunDetail, fetched: Call): Promise<void> {
  const pid = await workerPid('clock')
  if (!check('found the clock worker, which serves the holidays', pid !== undefined)) {
    return
  }

  process.kill(pid!, 'SIGSTOP')
  try {
    const down = !(await serverAnswers(fetched.url!))
    console.log(`    paused clock (pid ${pid}), holiday server answering: ${!down}`)
    const fork = await call<Fork>('rewind::replay', { run_id: detail.run.run_id })
    console.log(`    ${fork.fork_id}: ${describeOutcome(fork.outcome)}`)
    const replayed = holidayFetch(fork.calls)
    check(
      'a replay returns the recorded holiday response while the holiday server is stopped',
      down && sameEnding(detail.run, fork.outcome) && replayed?.source === 'recorded' && isDeepStrictEqual(replayed.answer, fetched.answer),
    )
  } finally {
    process.kill(pid!, 'SIGCONT')
  }

  check('the holiday server is back after the replay', await serverAnswers(fetched.url!))
}

type ToolCallAnswer = { tool_call: { name: string; args: Record<string, unknown> } }

/** A fork whose model picks a holiday asks for a fetch the recording lacks, then runs it live. */
async function forkOntoHoliday(detail: RunDetail, fetched: Call): Promise<void> {
  const model = detail.calls.find((c) => c.function_id === 'model::complete')!
  const picked = valueOf(model.answer) as ToolCallAnswer
  const today = (valueOf(detail.calls[0].answer) as { now: string }).now.slice(0, 10)
  const listing = await fetch(`${new URL(fetched.url!).origin}/holidays?from=${today}&weeks=12`)
  const holiday = ((await listing.json()) as { holidays: { date: string; name: string }[] }).holidays[0]
  if (!check('the holiday server lists a holiday in the next 12 weeks', holiday !== undefined)) {
    return
  }

  const args = { ...picked.tool_call.args, day: holiday.date }
  console.log(`    moving the meeting to ${holiday.date} (${holiday.name})`)
  const fork = await call<Fork>('rewind::fork', {
    run_id: detail.run.run_id,
    at_seq: model.seq,
    answer: { value: { tool_call: { ...picked.tool_call, args } } },
    source: 'edited',
  })
  console.log(`    ${fork.fork_id}: ${describeOutcome(fork.outcome)}`)
  const need = fork.outcome.state === 'paused' ? fork.outcome.need : undefined
  check(
    'a fork onto another day pauses on the new holiday fetch as a read-only GET',
    need !== undefined && need.function_id.startsWith('fetch GET ') && need.function_id.includes(holiday.date) && isDeepStrictEqual(need.effects, ['read-only']) && need.choices.includes('live'),
  )
  check('a pause on a request around iii has no response format in its need', need !== undefined && !('response_format' in need))
  const { span: paused } = await storedSpan(need?.trace_id, need?.span_id)
  check("the pause's need points at the span of the stub call that paused", paused?.name === 'execute rewind::outside', paused?.name)
  const finished = await answerPauses(fork)
  console.log(`    ${finished.fork_id}: ${describeOutcome(finished.outcome)}`)
  console.log(`    calls ${sources(finished)}`)
  const output = finished.outcome.state === 'done' ? (finished.outcome.output as AgentOutput) : undefined
  check(
    'running the fetch live finds the holiday, and the run fails with a reply that says so',
    holidayFetch(finished.calls)?.source === 'live' && output?.status === 'failed' && (output.reply ?? '').includes(`${holiday.date} is a US holiday`),
    output?.reply,
  )
}

/**
 * A replay that copies the tools worker runs find-slot's Python in that copy, and the email
 * POST inside the copied email::send gets the recorded response, so nothing is sent.
 */
async function replayWithToolsCopied(detail: RunDetail): Promise<void> {
  const outboxBefore = outboxLines()
  const fork = await call<Fork>('rewind::replay', { run_id: detail.run.run_id, copy: ['tools'] })
  console.log(`    ${fork.fork_id} copying ${fork.copy.join(', ')}: ${describeOutcome(fork.outcome)}`)
  console.log(`    calls ${sources(fork)}`)
  const recordedSlot = detail.calls.find((c) => c.function_id === 'calendar::find-slot')
  const slot = fork.calls.find((c) => c.function_id === 'calendar::find-slot')
  const send = fork.calls.find((c) => c.function_id === 'email::send')
  const post = send?.inner?.find((c) => c.kind === 'http_out')
  console.log(`    find-slot ${slot?.source} ${JSON.stringify(slot && valueOf(slot.answer))}, POST ${post?.source} at ${post?.path?.join('.')}`)
  check(
    'a replay with tools copied ends the way the recording did, with every call to the tools answered by the copy and the others from the recording',
    isDeepStrictEqual(fork.copy, ['agent', 'tools']) &&
      sameEnding(detail.run, fork.outcome) &&
      fork.calls.length === detail.calls.length &&
      fork.calls.every((c, i) => c.function_id === detail.calls[i].function_id && c.source === (c.worker === 'tools' ? 'copy' : 'recorded')),
  )
  check(
    "find-slot's Python ran in the copy and gave the recorded slot",
    slot?.source === 'copy' && recordedSlot !== undefined && isDeepStrictEqual(slot.answer, recordedSlot.answer),
  )
  check(
    'the email POST inside the copied email::send is matched under it and answered from the recording, so the outbox is unchanged',
    post?.source === 'recorded' && isDeepStrictEqual(post.path, [send!.seq, 0]) && outboxLines() === outboxBefore,
    `${outboxBefore} lines before, ${outboxLines()} after`,
  )
}

const DIRECT_SLOT = { attendee: 'Rooted', day: '2026-12-08', duration: 30 }

/** A function called from outside, with nothing recorded calling it, is a run of its own and replays in a copy of its worker. */
async function replayOtherRoot(): Promise<void> {
  const answer = execFileSync('iii', ['call', '--engine', ENGINE_URL, 'calendar::find-slot', '--json', JSON.stringify(DIRECT_SLOT), '--timeout-ms', '30000'], { encoding: 'utf8' })
  console.log(`    iii call calendar::find-slot: ${answer.replace(/\s+/g, ' ').trim()}`)
  let run: RunSummary | undefined
  for (let attempt = 0; attempt < 20 && !run; attempt++) {
    await sleep(250)
    const listed = await call<RunSummary[]>('rewind::runs', { function_id: 'calendar::find-slot', q: DIRECT_SLOT.attendee, limit: 5 })
    run = listed[0]
  }

  const anyRoot = await call<RunSummary[]>('rewind::runs', { root: 'any', q: DIRECT_SLOT.attendee, limit: 5 })
  const agentRuns = await call<RunSummary[]>('rewind::runs', { q: DIRECT_SLOT.attendee, limit: 5 })
  check(
    'a calendar::find-slot call made with iii call is listed as a run of its own, under root any and its function, and not with the agent runs',
    run?.function_id === 'calendar::find-slot' && anyRoot.some((r) => r.run_id === run?.run_id) && agentRuns.length === 0,
    run ? `run ${run.run_id}` : 'not listed',
  )
  if (!run) {
    return
  }

  const fork = await call<Fork>('rewind::replay', { run_id: run.run_id })
  console.log(`    ${fork.fork_id} copying ${fork.copy.join(', ')}: ${describeOutcome(fork.outcome)}`)
  check(
    'replaying it starts a copy of the tools worker, which returns the recorded slot',
    isDeepStrictEqual(fork.copy, ['tools']) && sameEnding(run, fork.outcome),
  )
}

type Span = {
  name: string
  invocation_id: string
  trace_id: string | null
  span_id: string | null
  input: { args: unknown[] }
  error?: { code: string; message: string }
}
type StoredSpan = { span_id: string; parent_span_id?: string | null; name: string }

/** Every span of a trace in the engine's trace store, a page at a time, since a trace can have thousands. */
async function traceSpans(traceId: string | null | undefined): Promise<StoredSpan[]> {
  const spans: StoredSpan[] = []
  for (let offset = 0; traceId && offset < 10_000; offset += 500) {
    const page = await call<{ spans: StoredSpan[] }>('engine::traces::spans', { trace_id: traceId, search_all_spans: true, offset, limit: 500 })
    spans.push(...page.spans)
    if (page.spans.length < 500) {
      break
    }
  }

  return spans
}

/** A span from the engine's trace store, waiting a little for the worker to send it. */
async function storedSpan(traceId: string | null | undefined, spanId: string | null | undefined): Promise<{ span?: StoredSpan; all: StoredSpan[] }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const all = await traceSpans(traceId)
    const span = all.find((s) => s.span_id === spanId)
    if (span) {
      return { span, all }
    }

    await sleep(250)
  }

  return { all: [] }
}

/** The OpenTelemetry parent of a span, as the engine's trace store has it, so a span nests under the iii call. */
async function otelParent(span: Span): Promise<string | undefined> {
  const { span: stored, all } = await storedSpan(span.trace_id, span.span_id)
  return all.find((s) => s.span_id === stored?.parent_span_id)?.name
}

/** Each recorded call points at its own execute span, and each rerun at its root, which a copy now sends before it stops. */
async function checkTraceIds(booked: RunDetail): Promise<void> {
  // A worker's spans can reach the trace store after the run is recorded, and each read looks again.
  let detail = await call<RunDetail>('rewind::run', { run_id: booked.run.run_id })
  for (let attempt = 0; attempt < 20 && detail.calls.some((c) => c.kind === 'iii' && !c.span_id); attempt++) {
    await sleep(250)
    detail = await call<RunDetail>('rewind::run', { run_id: booked.run.run_id })
  }

  const iiiCalls = detail.calls.filter((c) => c.kind === 'iii')
  const spans = await traceSpans(iiiCalls[0]?.trace_id)
  const named = iiiCalls.filter((c) => spans.find((s) => s.span_id === c.span_id)?.name === `execute ${c.function_id}`)
  const runSpan = spans.find((s) => s.span_id === detail.run.span_id)?.name
  console.log(`    ${named.length} of ${iiiCalls.length} calls point at their execute span, run span ${runSpan}`)
  check(
    "a recorded call's trace_id and span_id point at a span named execute <function_id>, and the run's at execute agent::run",
    iiiCalls.length > 0 && named.length === iiiCalls.length && runSpan === 'execute agent::run',
  )

  const fork = await call<Fork>('rewind::replay', { run_id: booked.run.run_id })
  let got = fork
  for (let attempt = 0; attempt < 20 && !got.span_id; attempt++) {
    await sleep(250)
    got = await call<Fork>('rewind::fork-get', { fork_id: fork.fork_id })
  }

  const { span: root } = await storedSpan(got.trace_id, got.span_id)
  const sameTrace = got.calls.every((c) => c.trace_id === got.trace_id && c.span_id)
  const event = changes.find((c) => c.kind === 'fork' && c.id === fork.fork_id && c.trace_id === got.trace_id)
  console.log(`    ${got.fork_id}: trace ${got.trace_id}, root ${root?.name ?? 'missing'}`)
  check(
    "a fork's rerun trace has its root span, every fork call has the stub's span in that trace, and rewind::changed says which trace",
    root?.name === 'execute agent::run' && sameTrace && event !== undefined,
  )
}

async function failedSpan(invocationId: string, name: string): Promise<Span | undefined> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const spans = await call<Span[]>('rewind::spans', { invocation_id: invocationId })
    const found = spans.find((s) => s.name === name && s.error)
    if (found) {
      return found
    }

    await sleep(250)
  }

  return undefined
}

/** Bug 1 throws in the agent's parseArgs and bug 2 in the tools worker's find_slot, and both are traced. */
async function checkFunctionSpans(found: Map<Kind, RunDetail>): Promise<void> {
  const syntax = found.get('SyntaxError')
  if (syntax) {
    const span = await failedSpan(syntax.run.run_id, 'function src/worker.ts:parseArgs')
    const text = span?.input.args[0]
    console.log(`    parseArgs threw ${span?.error?.code}: ${span?.error?.message} on ${JSON.stringify(text)}`)
    const parent = span && (await otelParent(span))
    check(
      'bug 1: the run shows parseArgs throwing SyntaxError on the cut-off text, under the run in Traces',
      span?.error?.code === 'SyntaxError' && typeof text === 'string' && !isJson(text) && parent === 'execute agent::run',
      `parent span ${parent}`,
    )
  }

  const typeError = found.get('TypeError')
  const slot = typeError?.calls.find((c) => c.function_id === 'calendar::find-slot')
  if (slot?.invocation_id) {
    const span = await failedSpan(slot.invocation_id, 'function src/main.py:find_slot')
    const args = span?.input.args[0] as { duration?: unknown } | undefined
    console.log(`    find_slot raised ${span?.error?.code}: ${span?.error?.message} with ${JSON.stringify(args)}`)
    const parent = span && (await otelParent(span))
    check(
      'bug 2: calendar::find-slot shows find_slot raising TypeError on a duration sent as a string, under the call in Traces',
      span?.error?.code === 'TypeError' && typeof args?.duration === 'string' && parent === 'execute calendar::find-slot',
      `parent span ${parent}`,
    )
  }
}

type HttpExchange = { method?: string; url?: string; status?: number; body?: string | null }

/** A request this script sends to the holiday server is recorded by the clock worker's preload as a run of its own. */
async function checkInbound(fetched: Call): Promise<void> {
  const url = `${new URL(fetched.url!).origin}/holidays?from=2026-12-21&weeks=3`
  const live = await fetch(url)
  const liveBody = await live.text()
  let run: RunSummary | undefined
  for (let attempt = 0; attempt < 20 && !run; attempt++) {
    await sleep(250)
    run = (await call<RunSummary[]>('rewind::runs', { root: 'http_in', q: 'from=2026-12-21&weeks=3', limit: 5 }))[0]
  }

  const recorded = run?.output as HttpExchange | undefined
  console.log(`    ${run ? `run ${run.run_id}: ${(run.input as HttpExchange).method} ${(run.input as HttpExchange).url} -> ${recorded?.status}` : 'not recorded'}`)
  check('an inbound holiday request is recorded as the root of a run', run !== undefined && recorded?.status === 200 && recorded.body === liveBody)
  if (!run) {
    return
  }

  const replay = await call<Fork>('rewind::replay', { run_id: run.run_id })
  const answered = replay.outcome.state === 'done' ? (replay.outcome.output as HttpExchange) : undefined
  console.log(`    ${replay.fork_id} in ${replay.namespace}: ${describeOutcome(replay.outcome).slice(0, 160)}`)
  check(
    'replaying it sends the recorded request to a copy of the clock worker, which returns the same response',
    answered?.status === 200 && answered.body === recorded?.body,
  )

  const posted = (await call<RunSummary[]>('rewind::runs', { root: 'http_in', q: 'POST', limit: 50 })).find(
    (r) => (r.input as HttpExchange).method === 'POST',
  )
  let refused = ''
  try {
    await call<Fork>('rewind::replay', { run_id: posted?.run_id ?? 'none' })
  } catch (error) {
    refused = (error as { code?: string }).code ?? ''
  }

  check('an inbound POST to the email provider is never replayed', posted !== undefined && refused === 'REWIND_NOT_REPLAYABLE', refused)
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function git(...args: string[]): string {
  return execFileSync('git', ['-C', REPO_DIR, ...args], { encoding: 'utf8' })
}

function agentIsUnchanged(): boolean {
  return git('status', '--porcelain', '--', AGENT_DIR).trim() === ''
}

function patchIsApplied(): boolean {
  try {
    git('apply', '--check', '--reverse', DEMO_PATCH)
    return true
  } catch {
    return false
  }
}

// Only a patch this script applied is reverted, never one a person applied by hand.
let appliedPatch = false

function applyPatch(): void {
  git('apply', DEMO_PATCH)
  appliedPatch = true
}

function revertPatch(): void {
  if (appliedPatch && patchIsApplied()) {
    git('apply', '--reverse', DEMO_PATCH)
  }

  appliedPatch = false
}

/** Reverts the patch if the run is stopped with Ctrl-C, which skips `finally`. Returns a function to stop listening. */
function revertOnSignal(): () => void {
  const onSignal = (signal: NodeJS.Signals) => {
    revertPatch()
    console.error(`e2e: reverted ${DEMO_PATCH} after ${signal}`)
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return () => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

async function status(): Promise<Status> {
  return call<Status>('rewind::status')
}

function describeCheck(result: CheckResult): string {
  const at = result.stopped_at ? ` at seq ${result.stopped_at.seq} ${result.stopped_at.function_id}` : ''
  return `${result.run_id} ${result.result}${at}, code ${result.code.version}: ${describeOutcome(result.outcome)}`
}

function counted(labels: string[]): string {
  const counts = new Map<string, number>()
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  return [...counts].map(([label, count]) => `${count} ${label}`).join(', ') || 'no runs'
}

function tally(results: CheckResult[]): string {
  return counted(results.map((result) => result.result))
}

async function checkNamespacesLeft(): Promise<string[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const listed = await call<{ functions: { namespace?: string }[] }>('engine::functions::list')
    const left = [...new Set(listed.functions.map((f) => f.namespace ?? 'default'))].filter((ns) => ns.startsWith('rewind-c'))
    if (left.length === 0) {
      return left
    }

    await sleep(250)
  }

  return ['still there after 5 s']
}

/** Whether a pause is the patched agent asking the model again, with the input of the call that gave it bad arguments. */
function isRetry(need: Need, detail: RunDetail): boolean {
  const bad = detail.calls.findLast((c) => c.function_id === 'model::complete')
  if (!bad) {
    return false
  }

  return need.function_id === 'model::complete' && need.seq === bad.seq + 1 && isDeepStrictEqual(need.input, bad.input)
}

/** The patched agent asks the model again, so the replay pauses there until the person lets the run go on. */
async function replayWithFix(syntax: RunDetail, code: CodeVersion): Promise<void> {
  const replay = await call<Fork>('rewind::replay', { run_id: syntax.run.run_id })
  console.log(`    replayed ${syntax.run.run_id} as ${replay.fork_id} on code ${replay.code?.version}: ${describeOutcome(replay.outcome)}`)
  console.log(`    calls ${sources(replay)}`)
  const differs = !sameEnding(syntax.run, replay.outcome) || replay.calls.length !== syntax.calls.length
  check('a replay after the patch runs the new code', differs && replay.code?.version === code.version)
  if (replay.outcome.state !== 'paused') {
    return
  }

  check('the patched agent asks the model again with the same input', isRetry(replay.outcome.need, syntax))
  const finished = await answerPauses(replay)
  console.log(`    ${finished.fork_id}: ${describeOutcome(finished.outcome)}`)
  console.log(`    calls ${sources(finished)}`)
  const output = finished.outcome.state === 'done' ? (finished.outcome.output as AgentOutput) : undefined
  check('with the fix, the replayed run ends with a reply instead of crashing', output?.status !== undefined, output?.reply)
}

/** How a live-checked run ended, with the planted bug behind it when there is one. */
function ending(outcome: Outcome): string {
  if (outcome.state !== 'done') {
    return outcome.state
  }

  const { status, reply = '' } = outcome.output as AgentOutput
  if (status === 'booked') {
    return 'booked'
  }

  if (/timedelta/.test(reply)) {
    return 'failed on bug 2 (a string duration reaching Python)'
  }

  if (/not valid JSON twice/.test(reply)) {
    return 'failed because the model cut its arguments off twice'
  }

  return `failed: ${reply}`
}

function describeFilled(filled: Filled[]): string {
  return filled.map((f) => `seq ${f.seq} ${f.function_id} from ${f.from_run_id}`).join(', ') || 'nothing'
}

/** Whether every run a check filled from made the call it was filled with. */
async function fillsCameFromRuns(results: CheckResult[]): Promise<boolean> {
  for (const filled of results.flatMap((r) => r.filled)) {
    const donor = await call<RunDetail>('rewind::run', { run_id: filled.from_run_id })
    if (!donor.calls.some((c) => c.function_id === filled.function_id)) {
      return false
    }
  }

  return true
}

/** The calls the recording lacks run live, apart from email::send, which gets another run's answer. */
async function checkLive(runIds: string[], patched: CodeVersion): Promise<void> {
  const outboxBefore = outboxLines()
  const timeoutMs = CALL_TIMEOUT_MS + runIds.length * LIVE_CHECK_MS_PER_RUN
  const results = await call<CheckResult[]>('rewind::check', { run_ids: runIds, live: true }, timeoutMs)
  for (const result of results) {
    console.log(`    ${describeCheck(result)}`)
    console.log(`      live calls ${result.live_calls}, filled ${describeFilled(result.filled)}`)
  }

  check(
    'with live calls, every SyntaxError run runs through to a reply on the patched code',
    results.every((r) => r.result === 'different' && r.outcome.state === 'done' && r.live_calls > 0 && r.code.version === patched.version),
    tally(results),
  )
  const endings = results.map((r) => ending(r.outcome))
  console.log(`    endings: ${counted(endings)}`)
  const bug2 = endings.filter((e) => e.includes('bug 2')).length
  if (bug2 > 0) {
    console.log(`    the check found bug 2 in ${bug2} run(s): the model's retry got past the parse, and calendar::find-slot crashed on "duration" as a string`)
  }

  const sendsFilled = results.every((r, index) => {
    const sends = endings[index] === 'booked' ? 1 : 0
    return r.filled.length === sends && r.filled.every((f) => f.function_id === 'email::send' && f.from_run_id !== r.run_id)
  })
  check(
    'filled lists the one email::send of each run that booked, answered from another run that sent one',
    sendsFilled && (await fillsCameFromRuns(results)),
    `${results.flatMap((r) => r.filled).length} filled`,
  )
  check('a live check sends nothing, so the outbox is unchanged', outboxLines() === outboxBefore, `${outboxBefore} lines before and after`)

  // The patched agent's retried model answer leads to a holiday fetch the recording never had.
  const isFetch = (c: { function_id: string }) => c.function_id.startsWith('fetch GET ')
  const fetchedLive = results.filter((r) => r.live.some(isFetch)).length
  const askedForSlot = results.filter((r) => r.live.some((c) => c.function_id === 'calendar::find-slot'))
  check(
    'a live check runs the new holiday fetch live, before every slot lookup it makes',
    fetchedLive > 0 && askedForSlot.every((r) => r.live.some(isFetch)) && results.every((r) => !r.stopped_at || !isFetch(r.stopped_at)),
    `${fetchedLive} of ${results.length} runs fetched live`,
  )
}

async function checkFix(syntax: RunDetail): Promise<void> {
  const runIds = (await call<RunSummary[]>('rewind::runs', { filter: 'failed', limit: 500 }))
    .filter(isSyntaxError)
    .map((run) => run.run_id)
  const details = new Map<string, RunDetail>()
  for (const runId of runIds) {
    details.set(runId, await call<RunDetail>('rewind::run', { run_id: runId }))
  }

  const before = await status()
  const original = before.target_code!
  console.log(`    ${runIds.length} SyntaxError runs recorded, code on disk ${original.version}`)
  check('a run is recorded with the code version on disk', syntax.run.code_version === original.version, `${syntax.run.code_version}`)

  const baseline = await call<CheckResult[]>('rewind::check', { run_ids: runIds })
  check('before the patch, every SyntaxError run checks the same as recorded', baseline.every((r) => r.result === 'same'), tally(baseline))
  check('checks are not stored as forks', (await status()).forks === before.forks)
  const left = await checkNamespacesLeft()
  check('a check deletes its namespace and copy', left.length === 0, left.join(', '))

  applyPatch()
  const stopListening = revertOnSignal()
  let pausedFork: Fork | undefined
  try {
    const patched = (await status()).target_code
    console.log(`    applied ${path.relative(REPO_DIR, DEMO_PATCH)}, code on disk ${patched?.version}`)
    check('rewind::status reports a new code version after the patch', patched !== null && patched.version !== original.version)
    await replayWithFix(syntax, patched!)

    pausedFork = await call<Fork>('rewind::replay', { run_id: syntax.run.run_id })
    const results = await call<CheckResult[]>('rewind::check', { run_ids: runIds })
    for (const result of results) {
      console.log(`    ${describeCheck(result)}`)
    }

    check('after the patch, no SyntaxError run checks the same as recorded', results.every((r) => r.result !== 'same'), tally(results))
    check(
      'without live calls, each check stops at the retried model::complete, on the patched code',
      results.every(
        (r) => r.outcome.state === 'paused' && isRetry(r.outcome.need, details.get(r.run_id)!) && r.code.version === patched?.version,
      ),
    )
    check('a check without live calls runs nothing live and fills nothing', results.every((r) => r.live_calls === 0 && r.filled.length === 0))
    const isCheckEvent = (c: Changed) => c.kind === 'check' && c.check?.code.version === patched?.version
    // The last few events can arrive a few milliseconds after rewind::check returns.
    for (let attempt = 0; attempt < 20 && changes.filter(isCheckEvent).length < runIds.length; attempt++) {
      await sleep(100)
    }

    const checkEvents = changes.filter(isCheckEvent)
    const codeEvent = changes.some((c) => c.kind === 'code' && c.id === patched?.version)
    check(
      'rewind::changed sent the new code version and one check event per run',
      codeEvent && checkEvents.length === runIds.length,
      `code event ${codeEvent}, ${checkEvents.length} check events`,
    )

    console.log('9. Check every SyntaxError run against the fix again, with live calls')
    await checkLive(runIds, patched!)
  } finally {
    stopListening()
    revertPatch()
  }

  const reverted = (await status()).target_code
  check('reverting the patch brings back the original code version', reverted?.version === original.version && agentIsUnchanged())
  if (pausedFork?.outcome.state !== 'paused') {
    return
  }

  // This fork paused on the patched code and kept its copy, so answering it now has to restart the copy.
  const rerun = await call<Fork>('rewind::answer', {
    fork_id: pausedFork.fork_id,
    choice: 'typed',
    value: { text: 'typed by e2e', status: 'failed' },
  })
  console.log(`    ${rerun.fork_id} paused on code ${pausedFork.code?.version}, answered on ${rerun.code?.version}: ${describeOutcome(rerun.outcome)}`)
  check(
    'a paused fork restarts its copy when the code changes, and crashes like the recording again',
    rerun.code?.version === original.version && sameEnding(syntax.run, rerun.outcome),
  )
}

async function workerPid(name: string): Promise<number | undefined> {
  const listed = await call<{ workers?: { name?: string; namespace?: string; pid?: number }[] }>('engine::workers::list')
  const fromEngine = listed.workers?.find((w) => w.name === name && (w.namespace ?? 'default') === 'default')?.pid
  if (fromEngine) {
    return fromEngine
  }

  const state = path.join(PROJECT_DIR, '.iii', 'compose', 'default', 'state.json')
  if (!existsSync(state)) {
    return undefined
  }

  return JSON.parse(readFileSync(state, 'utf8')).containers?.[name]?.pid
}

async function waitForTools(): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const listed = await call<{ functions: { function_id: string; namespace?: string }[] }>('engine::functions::list')
    if (listed.functions.some((f) => f.function_id === 'calendar::find-slot' && (f.namespace ?? 'default') === 'default')) {
      return true
    }

    await sleep(250)
  }

  return false
}

/**
 * A run that lost its slot lookup, whose model asked for a well-formed slot, so
 * its recovery has live calls to make and only one way to go. Any lost run otherwise.
 */
function onlyReads(effects: string[]): boolean {
  return effects.length > 0 && effects.every((effect) => effect === 'pure' || effect === 'read-only')
}

async function pickLostRun(lost: LostRun[]): Promise<LostRun | undefined> {
  const ordered = [...lost].sort((a, b) => a.lost_at - b.lost_at)
  for (const run of ordered) {
    const detail = await call<RunDetail>('rewind::run', { run_id: run.run_id })
    const answer = detail.calls[1]?.answer ?? { value: null }
    const args = (valueOf(answer) as { tool_call?: { args?: { duration?: unknown } } } | null)?.tool_call?.args
    if (typeof args === 'object' && typeof args?.duration === 'number') {
      return run
    }
  }

  return ordered[0]
}

function describeChanges(changes: WorkerChange[]): string {
  return changes.map((c) => `${c.event} ${c.worker_id.slice(0, 8)}`).join(', ') || 'no changes'
}

function showsRestart(changes: WorkerChange[]): boolean {
  const left = changes.findIndex((c) => c.event === 'disconnected')
  const back = changes.slice(left + 1).find((c) => c.event === 'connected')
  return left >= 0 && back !== undefined && back.worker_id !== changes[left].worker_id
}

/** The first lost run whose tools changes show the restart, or the earliest one when none does. */
async function findToolsRestart(lost: LostRun[]): Promise<{ run_id: string; changes: WorkerChange[]; seen: boolean }> {
  const ordered = [...lost].sort((a, b) => a.started_at_ms - b.started_at_ms)
  let earliest: { run_id: string; changes: WorkerChange[]; seen: boolean } | undefined
  for (const run of ordered) {
    const changes = (await call<RunDetail>('rewind::run', { run_id: run.run_id })).worker_changes.filter((c) => c.worker === 'tools')
    const found = { run_id: run.run_id, changes, seen: showsRestart(changes) }
    if (found.seen) {
      return found
    }

    earliest ??= found
  }

  return earliest!
}

async function killAndRecover(): Promise<void> {
  const lostBefore = new Set((await call<LostRun[]>('rewind::lost')).map((run) => run.run_id))
  const burst = call<Record<string, number>>('traffic::burst', { count: 24, interval_ms: 120 })
  await sleep(2_000)
  const pid = await workerPid('tools')
  if (!check('found the tools worker to kill', pid !== undefined)) {
    await burst
    return
  }

  process.kill(pid!, 'SIGKILL')
  console.log(`    killed tools (pid ${pid}) mid-burst`)
  console.log(`    burst ${JSON.stringify(await burst)}`)
  check('the tools worker came back', await waitForTools())

  let lost: LostRun[] = []
  for (let attempt = 0; attempt < 40 && lost.length === 0; attempt++) {
    lost = (await call<LostRun[]>('rewind::lost')).filter((run) => !lostBefore.has(run.run_id))
    await sleep(250)
  }

  if (!check('rewind::lost lists the stopped runs', lost.length > 0, `${lost.length} new`)) {
    return
  }

  for (const run of lost.slice(0, 5)) {
    console.log(`    lost ${run.run_id} at seq ${run.lost_at}: ${run.output?.reply ?? run.error?.message}`)
  }

  const target = (await pickLostRun(lost))!
  await sleep(SLOW_SEND_SETTLE_MS)
  // A run that reached the slot lookup after tools was gone started too late to see it leave.
  const restart = await findToolsRestart(lost)
  console.log(`    tools during lost run ${restart.run_id.slice(0, 8)}: ${describeChanges(restart.changes)}`)
  check('a lost run shows tools disconnecting and a new tools worker connecting again', restart.seen)
  const outboxBefore = outboxLines()
  const recovery = await call<Fork>('rewind::recover', { run_id: target.run_id })
  console.log(`    recovering ${target.run_id} as ${recovery.fork_id} (${recovery.mode}): ${describeOutcome(recovery.outcome)}`)
  console.log(`    calls ${sources(recovery)}`)
  const need = recovery.outcome.state === 'paused' ? recovery.outcome.need : undefined
  // A call cut off mid-call runs again on its own only when it only reads. Any other stops the
  // recovery there with reason lost, before the send.
  const lostCall = recovery.calls.find((c) => c.seq === target.lost_at)
  const lostCallReads = lostCall !== undefined && onlyReads(lostCall.effects)
  const stoppedWhereExpected =
    target.mid_call && !lostCallReads
      ? need?.seq === target.lost_at && need.reason === 'lost'
      : need?.effects.includes('irreversible') === true
  const recordedThenLive = recovery.calls.every((c) => c.source === (c.seq < target.lost_at ? 'recorded' : 'live'))
  check(
    'the recovery replays the finished calls, runs the rest live, and stops at the call cut off mid-call or the irreversible one',
    stoppedWhereExpected && recordedThenLive,
    `lost at seq ${target.lost_at}, mid-call ${target.mid_call}, paused at ${need?.seq} (${need?.reason})`,
  )
  const finished = await answerPauses(recovery)
  console.log(`    ${finished.fork_id}: ${describeOutcome(finished.outcome)}`)
  const output = finished.outcome.state === 'done' ? (finished.outcome.output as AgentOutput) : undefined
  check('the recovered run books once the send is answered', output?.status === 'booked', output?.reply)
  check('recovering wrote nothing to the outbox', outboxLines() === outboxBefore)
}

type Pending = { step: number; kind: string; name?: string; detail?: { function_id?: string } }
type Parked = { pending?: true; workflow_id?: string; waiting_for?: Pending }
type JournalRun = { status: string; output?: AgentOutput; pending?: Pending; executions?: unknown[]; steps?: { function_id: string }[] }
type Resolution = { resolved: boolean; resumed: boolean; reason?: string }

const APPROVAL_PEOPLE = ['Dana next Tuesday', 'Priya next Wednesday', 'Marcus next Thursday', 'Lena next Monday', 'Omar next Friday', 'Sofia next Tuesday']

/** An agent::run with approval that parked at its wait, trying other requests when the fake model fails one first (bug 1). */
async function parkedForApproval(label: string): Promise<{ workflowId: string; parked: Parked } | undefined> {
  for (const [index, who] of APPROVAL_PEOPLE.entries()) {
    const workflowId = `e2e-${label}-${Date.now()}-${index}`
    const payload = { request: `Book 30 minutes with ${who} afternoon`, approval: true, _workflow_id: workflowId }
    const parked = await call<Parked>('agent::run', payload).catch(() => ({}) as Parked)
    if (parked.pending) {
      return { workflowId, parked }
    }
  }

  return undefined
}

async function settledInJournal(workflowId: string): Promise<JournalRun | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const found = await call<JournalRun | null>('journal::wait', { workflow_id: workflowId, timeout_ms: 10_000 }, 15_000)
    if (found && found.status !== 'running') {
      return found
    }
  }

  return null
}

/** A run that waits for approval parks without sending, goes on once approved, and sends its invite then. */
async function approvedRun(): Promise<void> {
  const outside = await call('durable::wait', { name: 'approval' }).then(
    () => 'it returned',
    (error: { message?: string }) => error.message ?? '',
  )
  check('durable::wait called outside a durable run fails at once and says so', /only works inside a durable run/.test(outside), outside)

  const approved = await parkedForApproval('approve')
  if (!check('agent::run with approval returns pending at a wait named approval, about email::send', approved?.parked.waiting_for?.name === 'approval' && approved.parked.waiting_for.detail?.function_id === 'email::send')) {
    return
  }

  const { workflowId } = approved!
  const listed = await call<{ workflow_id: string }[]>('journal::list', { status: 'waiting' })
  await sleep(SLOW_SEND_SETTLE_MS)
  const outboxBefore = outboxLines()
  const resolution = await call<Resolution>('journal::resolve', { workflow_id: workflowId, name: 'approval', value: { approved: true } })
  const settled = await settledInJournal(workflowId)
  const again = await call<Resolution>('journal::resolve', { workflow_id: workflowId, name: 'approval', value: { approved: false } })
  console.log(`    ${workflowId}: resolve ${JSON.stringify(resolution)}, then ${settled?.status} ${JSON.stringify(settled?.output)}; a second resolve ${JSON.stringify(again)}`)
  check(
    'the journal lists the run waiting, resolving it starts it again, it finishes booked, and a second resolve returns resolved: false',
    listed.some((run) => run.workflow_id === workflowId) && resolution.resumed && settled?.status === 'done' && settled.output?.status === 'booked' && !again.resolved,
  )
  await sleep(SLOW_SEND_SETTLE_MS)
  const detail = await call<JournalRun>('journal::get', { workflow_id: workflowId })
  const sendSteps = detail.steps?.filter((step) => step.function_id === 'email::send').length ?? 0
  check(
    'the approved run sent nothing while it waited and one invite per email::send step once approved',
    sendSteps >= 1 && outboxLines() - outboxBefore === sendSteps,
    `${outboxLines() - outboxBefore} new outbox lines, ${sendSteps} email::send steps`,
  )

  const declined = await parkedForApproval('decline')
  if (!declined) {
    check('a declined run replies failed and sends nothing', false, 'no run parked')
    return
  }

  const declinedBefore = outboxLines()
  await call<Resolution>('journal::resolve', { workflow_id: declined.workflowId, name: 'approval', value: { approved: false } })
  const declinedRun = await settledInJournal(declined.workflowId)
  await sleep(SLOW_SEND_SETTLE_MS)
  console.log(`    ${declined.workflowId}: declined, then ${declinedRun?.status} ${JSON.stringify(declinedRun?.output)}`)
  check('a declined run replies failed and sends nothing', declinedRun?.output?.status === 'failed' && outboxLines() === declinedBefore)
}

async function main(): Promise<number> {
  if (!agentIsUnchanged()) {
    console.error(`e2e: ${AGENT_DIR} has uncommitted changes, and the e2e patches it. Commit or revert them first.`)
    return 2
  }

  console.log(`Rewind e2e against ${ENGINE_URL}, outbox ${path.relative(PROJECT_DIR, OUTBOX)}`)
  listenForChanges()
  const started = await status()
  console.log(`  recording ${started.recording.join(', ')}`)
  console.log(`  code under test ${JSON.stringify(started.target_code)}`)

  console.log('1. Record a burst of runs')
  const { found, firstBurst } = await collectKinds()
  await sleep(SLOW_SEND_SETTLE_MS)
  const outboxBefore = outboxLines()

  console.log("1a. Check the tools' formats, each run's trace, and bug 2's string duration")
  const functions = await checkFormats()
  await checkRunTraces(firstBurst)
  checkStringDuration(found, functions)
  const sendFormat = functions.find((f) => f.function_id === 'email::send')?.response_format

  console.log('2. Replay one run of each kind')
  await replayEach(found)

  const booked = found.get('booked') ?? [...found.values()][0]
  if (booked) {
    console.log("3. Find a run by one of its calls' invocation ids")
    await findByCallId(booked)
  }

  const fetched = found.get('booked') && checkFetchRecorded(found.get('booked')!)
  if (found.get('booked')) {
    checkEmailPost(found.get('booked')!)
    await checkTraceIds(found.get('booked')!)
  }

  await checkFunctionSpans(found)

  if (fetched) {
    console.log('4. Replay a booked run with the holiday server stopped, then fork it onto a holiday')
    await replayWithServerStopped(found.get('booked')!, fetched)
    await forkOntoHoliday(found.get('booked')!, fetched)
    await checkInbound(fetched)
  }

  if (found.get('booked')) {
    console.log('4a. Replay a booked run with the tools worker copied')
    await replayWithToolsCopied(found.get('booked')!)
  }

  console.log('4b. Trigger calendar::find-slot directly and replay it as a run of its own')
  await replayOtherRoot()

  const syntax = found.get('SyntaxError')
  if (syntax) {
    console.log('5. Fork the SyntaxError run with the model answer repaired')
    const fork = await forkSyntaxError(syntax)
    console.log('6. Save the fork as a test and run it')
    if (fork.outcome.state === 'done') {
      await saveAndTest(fork)
    }

    console.log('7. Fork the SyntaxError run with auto on, then stop it at email::send')
    await autoForkSyntaxError(syntax, sendFormat)

    console.log('8. Apply the demo fix and check every SyntaxError run against it')
    await checkFix(syntax)
  }

  check('replaying, forking and checking wrote nothing to the outbox', outboxLines() === outboxBefore, `${outboxBefore} lines before and after`)

  console.log('10. Kill the tools worker during a burst and recover a stopped run')
  await killAndRecover()

  console.log('11. Start runs that wait for approval, approve one and decline one')
  await approvedRun()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`)
  return failed.length === 0 ? 0 : 1
}

try {
  process.exitCode = await main()
} catch (error) {
  const { code, message } = error as { code?: string; message?: string }
  console.error(`e2e stopped: ${code ?? ''} ${message ?? String(error)}`)
  process.exitCode = 1
} finally {
  revertPatch()
  await worker.shutdown()
}

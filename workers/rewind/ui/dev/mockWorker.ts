/**
 * A stand-in for the Rust Rewind worker, so the page can be built and shot
 * without it. It registers every rewind::* function with the shapes the Rust
 * core returns, over the simulation in sim.ts, provides the
 * rewind::changed trigger type, and injects the built page the way the core
 * does: one content function plus a console:style and a console:script
 * trigger. It also registers its own traffic::burst, so the empty state's
 * command fills the list live.
 *
 * Run from workers/rewind/ui after npm run build:
 *   III_URL=ws://127.0.0.1:49634 npx tsx dev/mockWorker.ts
 * MOCK_EMPTY=1 starts with no runs. rewind-dev::configure sets a delay, a
 * failure or an empty list at runtime, makes the next few rewind::answer
 * calls fail, reports some functions with no effects, and resets the state,
 * for screenshots.
 */
import { readFileSync, watch } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { InvocationError, registerWorker, TriggerAction } from 'iii-sdk'
import type {
  Answer,
  AnswerRequest,
  Call,
  CallAt,
  ChangedEvent,
  CheckResult,
  ForkOutcome,
  Choice,
  Fork,
  ForkRequest,
  ForkSetRequest,
  FilledCall,
  ForkSettings,
  FunctionRow,
  LostRun,
  RunDetail,
  RunRow,
  RunStatus,
  SavedTest,
  Status,
  TestFixture,
  TestResult,
} from '../src/client/types'
import {
  type AgentCode,
  burstScenario,
  chosenAgain,
  ENTRY,
  type FillSource,
  FIXED_CODE,
  FUNCTIONS,
  forkSummary,
  functionInfo,
  liveAllowed,
  liveAnswer,
  liveTiming,
  type ModelFault,
  modelAnswer,
  lostAt,
  lostCall,
  publicFork,
  RECORDED_CODE,
  type Recording,
  recordRun,
  replayFork,
  sameInput,
  seededRandom,
  seedRecordings,
  setUndeclared,
  spanIdOf,
  traceIdOf,
  type StoredAnswer,
  type StoredFork,
  trafficRequest,
} from './sim'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49634'
const SEED = Number(process.env.MOCK_SEED ?? 412)
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const ASSETS: { path: string; file: string; type: 'console:style' | 'console:script'; contentType: string }[] = [
  { path: 'rewind/styles.css', file: 'styles.css', type: 'console:style', contentType: 'text/css; charset=utf-8' },
  { path: 'rewind/page.js', file: 'page.js', type: 'console:script', contentType: 'text/javascript; charset=utf-8' },
]

// Reads take `delay_ms`. Running a fork takes `run_ms` to start a copy of the
// agent, then as long as the rerun's live calls, so a recovery takes 1 to 3 s.
// The next `answer_failures` calls to rewind::answer fail, to shoot a retry.
type Config = { delay_ms: number; run_ms: number; fail: boolean; answer_failures: number }

const random = seededRandom(SEED + 1)
const config: Config = { delay_ms: 140, run_ms: 1400, fail: false, answer_failures: 0 }
// The agent's code on disk. rewind-dev::configure { code_change: true } plays
// a person saving the fix for bug 1, the way the core will notice a new version.
let code: AgentCode = RECORDED_CODE
let codeChangedAt = Date.parse('2026-10-29T17:40:00-05:00')
let recordings: Recording[] = []
let forks = new Map<string, StoredFork>()
let tests = new Map<string, TestFixture>()
let forkCount = 0
const recordingOn = new Map(FUNCTIONS.map((f) => [f.function_id, true]))

function reset(empty: boolean): void {
  recordings = empty ? [] : seedRecordings(SEED)
  forks = new Map()
  tests = new Map()
  forkCount = 0
  config.answer_failures = 0
  code = RECORDED_CODE
  codeChangedAt = Date.parse('2026-10-29T17:40:00-05:00')
  setUndeclared([])
}

const targetCode = () => ({ version: code.version, changed_at_ms: codeChangedAt })

reset(process.env.MOCK_EMPTY === '1')

const worker = registerWorker(ENGINE_URL, { workerName: 'rewind' })

// The sample app's workers do not run beside the mock, so it connects a stand-in
// for each, and engine::workers::list reports the runtime each has in the app.
const STAND_INS: { name: string; runtime: 'node' | 'python' }[] = [
  { name: 'agent', runtime: 'node' },
  { name: 'clock', runtime: 'node' },
  { name: 'model', runtime: 'node' },
  { name: 'tools', runtime: 'python' },
]
// The Node SDK reports node as it connects, so the Python stand-in says otherwise once it has.
const RUNTIME_AFTER_MS = 1500

for (const { name, runtime } of STAND_INS) {
  const standIn = registerWorker(ENGINE_URL, { workerName: name })
  if (runtime !== 'node') {
    setTimeout(() => {
      void standIn
        .trigger({ function_id: 'engine::workers::register', payload: { runtime, version: '0.25.0', name }, action: TriggerAction.Void() })
        .catch(() => undefined)
    }, RUNTIME_AFTER_MS)
  }
}

// ── rewind::changed ─────────────────────────────────────────────────────

const bindings = new Map<string, { function_id: string; namespace?: string }>()

worker.registerTriggerType(
  { id: 'rewind::changed', description: 'Fires { kind, id } whenever a run, fork or lost run changes' },
  {
    async registerTrigger({ id, function_id, namespace }) {
      bindings.set(id, { function_id, namespace })
    },
    async unregisterTrigger({ id }) {
      bindings.delete(id)
    },
  },
)

function changed(kind: ChangedEvent['kind'], id: string, extra: Partial<ChangedEvent> = {}): void {
  for (const { function_id, namespace } of bindings.values()) {
    void worker
      .trigger({ function_id, payload: { kind, id, ...extra }, action: TriggerAction.Void(), namespace })
      .catch((error: unknown) => process.stdout.write(`CHANGED_FAILED ${function_id} ${String(error)}\n`))
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function fail(code: string, message: string): never {
  throw new InvocationError({ code, message })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function wait(ms: number): Promise<void> {
  await sleep(Math.round(ms * (0.7 + random() * 0.6)))
  if (config.fail) {
    fail('UNAVAILABLE', 'rewind is not answering: the recorder lost its database connection')
  }
}

const reading = () => wait(config.delay_ms)
const running = () => wait(config.run_ms)

function recordingFor(runId: string): Recording {
  return recordings.find((r) => r.run_id === runId) ?? fail('REWIND_NOT_FOUND', `no run ${runId}`)
}

function forkFor(forkId: string): StoredFork {
  return forks.get(forkId) ?? fail('REWIND_NOT_FOUND', `no fork ${forkId}`)
}

function recordedCalls(recording: Recording): Call[] {
  const traced = recording.traced !== false
  return recording.calls.map((call, seq) => {
    const info = functionInfo(call.function_id)
    const out: Call = {
      seq,
      function_id: call.function_id,
      worker: info.worker,
      effects: info.effects,
      input: call.input,
      answer: call.answer,
      source: 'recorded',
      invocation_id: call.invocation_id,
      started_at_ms: call.started_at_ms,
      duration_ms: call.duration_ms,
      ...(traced ? { trace_id: traceIdOf(recording.run_id), span_id: spanIdOf(call.invocation_id) } : {}),
    }
    if (call.inferred) {
      out.inferred = call.inferred
    }

    return out
  })
}

function statusOf(recording: Recording): RunStatus {
  if (lostAt(recording) !== null) {
    return 'stopped'
  }

  return recording.outcome.state === 'done' ? 'success' : 'error'
}

function runRow(recording: Recording): RunRow {
  const row: RunRow = {
    run_id: recording.run_id,
    function_id: ENTRY,
    status: statusOf(recording),
    input: recording.input,
    started_at_ms: recording.started_at_ms,
    duration_ms: recording.duration_ms,
    calls: recording.calls.length,
    code_version: recording.code_version,
    ...(recording.traced !== false ? { trace_id: traceIdOf(recording.run_id), span_id: spanIdOf(recording.run_id) } : {}),
  }
  if (recording.outcome.state === 'done') {
    row.output = recording.outcome.output
  } else {
    row.error = recording.outcome.error
  }

  return row
}

/** As the core's `failed` filter: the run threw, a call returned an error, or a worker stopped. */
function failed(recording: Recording): boolean {
  return statusOf(recording) !== 'success' || recording.calls.some((c) => 'error' in c.answer)
}

const ROOT_WORKER = functionInfo(ENTRY).worker

function newFork(runId: string, mode: Fork['mode'], parent: string | null, editAt: number | null, answers: Map<number, StoredAnswer>, settings: ForkSettings = {}): StoredFork {
  forkCount += 1
  return {
    fork_id: `f${forkCount}`,
    run_id: runId,
    parent,
    edit_at: editAt,
    namespace: `rewind-f${forkCount}`,
    mode,
    auto_read: Boolean(settings.auto_read),
    auto: Boolean(settings.auto),
    stops: stopList(settings.stops),
    copy: copyList(settings.copy),
    answers,
    calls: [],
    outcome: { state: 'crashed', error: { message: 'not run yet' } },
    created_at_ms: Date.now(),
  }
}

function stopList(stops: unknown): string[] {
  if (stops === undefined) {
    return []
  }

  if (!Array.isArray(stops) || stops.some((s) => typeof s !== 'string')) {
    return fail('REWIND_BAD_INPUT', 'stops must be a list of function ids')
  }

  return [...new Set(stops as string[])]
}

/** As the core: the root's worker first, then the others, refusing a worker the project does not have. */
function copyList(copy: unknown): string[] {
  if (copy !== undefined && (!Array.isArray(copy) || copy.some((w) => typeof w !== 'string'))) {
    return fail('REWIND_BAD_INPUT', 'copy must be a list of worker names')
  }

  const known = new Set(FUNCTIONS.map((f) => f.worker))
  const unknown = ((copy ?? []) as string[]).find((worker) => !known.has(worker))
  if (unknown) {
    return fail('REWIND_NOT_FOUND', `no worker ${unknown} in worker-compose.yaml`)
  }

  return [...new Set([ROOT_WORKER, ...((copy ?? []) as string[])])]
}

/** As the core fills a call: the newest successful answer of the function in another recorded run. */
function fillFor(runId: string): FillSource {
  return (functionId) => {
    const success = recordedSuccess(functionId, runId)
    return success ? { answer: success.answer, run_id: success.runId } : undefined
  }
}

/** Reruns a fork, and returns once the rerun's live calls would have finished. */
async function run(fork: StoredFork): Promise<Fork> {
  replayFork(fork, recordingFor(fork.run_id), random, Date.now(), { code, fill: fillFor(fork.run_id) })
  await sleep(fork.rerun?.duration_ms ?? 0)
  fork.code = targetCode()
  forks.set(fork.fork_id, fork)
  changed('fork', fork.fork_id)
  if (fork.mode === 'recover') {
    changed('lost', fork.run_id)
  }

  return publicFork(fork)
}

function checkAnswer(answer: unknown): Answer {
  const shape = answer as { value?: unknown; error?: { message?: unknown } } | null
  if (shape && 'value' in shape) {
    return { value: shape.value }
  }

  if (shape && typeof shape.error?.message === 'string') {
    return { error: shape.error as { code?: string; message: string } }
  }

  return fail('REWIND_BAD_INPUT', 'answer must be { value } or { error: { message } }')
}

function functionAt(runId: string, base: StoredFork | undefined, seq: number): string {
  const fromBase = base?.calls.find((c) => c.seq === seq)?.function_id
  const pending = base?.outcome.state === 'paused' && base.outcome.need.seq === seq ? base.outcome.need.function_id : undefined
  const fromRecording = recordingFor(runId).calls[seq]?.function_id
  return fromBase ?? pending ?? fromRecording ?? fail('REWIND_BAD_INPUT', `no call at seq ${seq}`)
}

function recoveryOf(runId: string): StoredFork | undefined {
  return [...forks.values()].find((f) => f.run_id === runId && f.mode === 'recover')
}

// ── the rewind::* functions ─────────────────────────────────────────────

worker.registerFunction('rewind::status', async (): Promise<Status> => {
  await reading()
  return {
    engine: ENGINE_URL,
    entry: ENTRY,
    recording: [...recordingOn].filter(([, on]) => on).map(([id]) => id),
    runs: recordings.length,
    // The mock records only the agent's runs, so no request arrives at a worker's own server.
    inbound_runs: 0,
    forks: forks.size,
    target_code: targetCode(),
  }
})

worker.registerFunction('rewind::functions', async (): Promise<FunctionRow[]> => {
  await reading()
  return FUNCTIONS.map((f) => ({ ...functionInfo(f.function_id), recording: recordingOn.get(f.function_id) ?? false }))
})

worker.registerFunction('rewind::record-toggle', async (input: { function_id: string; enabled: boolean }): Promise<FunctionRow> => {
  await reading()
  const info = FUNCTIONS.find((f) => f.function_id === input.function_id) ?? fail('REWIND_NOT_FOUND', `no function ${input.function_id} in default`)
  recordingOn.set(info.function_id, Boolean(input.enabled))
  return { ...info, recording: Boolean(input.enabled) }
})

worker.registerFunction('rewind::runs', async (input: { filter?: string; q?: string; limit?: number; before_ms?: number; since_ms?: number }): Promise<RunRow[]> => {
  await reading()
  const q = (input.q ?? '').trim().toLowerCase()
  const keep: Record<string, (r: Recording) => boolean> = {
    all: () => true,
    failed,
    stopped: (r) => lostAt(r) !== null,
  }
  const filter = keep[input.filter ?? 'all'] ?? fail('REWIND_BAD_INPUT', 'filter must be all, failed or stopped')
  // As the core: a run id or any call's invocation id by prefix, or text in the input or result.
  const matches = (r: Recording) =>
    r.run_id.startsWith(q) || r.calls.some((c) => c.invocation_id.startsWith(q)) || JSON.stringify([r.input, r.outcome]).toLowerCase().includes(q)
  // As the core: before_ms leaves out runs that started then or later, since_ms keeps those.
  const inWindow = (r: Recording) => r.started_at_ms < (input.before_ms ?? Number.POSITIVE_INFINITY) && r.started_at_ms >= (input.since_ms ?? 0)
  const rows = recordings
    .filter(inWindow)
    .filter(filter)
    .filter((r) => !q || matches(r))
    .sort((a, b) => b.started_at_ms - a.started_at_ms)
    .slice(0, Math.min(input.limit ?? 50, 500))
  return rows.map(runRow)
})

worker.registerFunction('rewind::run', async (input: { run_id: string }): Promise<RunDetail> => {
  await reading()
  const recording = recordingFor(input.run_id)
  const summaries = [...forks.values()].filter((f) => f.run_id === input.run_id).map(forkSummary)
  return { run: runRow(recording), calls: recordedCalls(recording), forks: summaries, worker_changes: recording.worker_changes ?? [] }
})

// The mock doesn't record function spans, so every call has none.
worker.registerFunction('rewind::spans', async (): Promise<unknown[]> => {
  await reading()
  return []
})

worker.registerFunction('rewind::replay', async (input: { run_id: string } & ForkSettings): Promise<Fork> => {
  await running()
  recordingFor(input.run_id)
  return run(newFork(input.run_id, 'debug', null, null, new Map(), input))
})

worker.registerFunction('rewind::fork', async (input: ForkRequest): Promise<Fork> => {
  await running()
  const base = input.base ? forkFor(input.base) : undefined
  const answers = new Map<number, StoredAnswer>()
  for (const [seq, stored] of base?.answers ?? []) {
    if (seq < input.at_seq) {
      answers.set(seq, stored)
    }
  }

  const functionId = functionAt(input.run_id, base, input.at_seq)
  answers.set(input.at_seq, { function_id: functionId, answer: checkAnswer(input.answer), source: input.source === 'injected' ? 'injected' : 'edited' })
  const settings: ForkSettings = {
    auto_read: input.auto_read ?? base?.auto_read,
    auto: input.auto ?? base?.auto,
    stops: input.stops ?? base?.stops,
    copy: input.copy ?? base?.copy?.slice(1),
  }
  return run(newFork(input.run_id, base?.mode ?? 'debug', input.base ?? null, input.at_seq, answers, settings))
})

worker.registerFunction('rewind::fork-get', async (input: { fork_id: string }): Promise<Fork> => {
  await reading()
  return publicFork(forkFor(input.fork_id))
})

worker.registerFunction('rewind::fork-set', async (input: ForkSetRequest): Promise<Fork> => {
  await running()
  const fork = forkFor(input.fork_id)
  if (typeof input.auto === 'boolean') {
    fork.auto = input.auto
  }

  if (input.stops !== undefined) {
    fork.stops = stopList(input.stops)
  }

  const recording = recordingFor(fork.run_id)
  for (const [seq, stored] of fork.answers) {
    if (!chosenAgain(fork, seq, stored, recording)) {
      fork.answers.delete(seq)
    }
  }

  return run(fork)
})

worker.registerFunction('rewind::answer', async (input: AnswerRequest): Promise<Fork> => {
  // Skipping only deletes the fork. Any other answer starts a copy of the agent first.
  await (input.choice === 'stop' ? reading() : running())
  if (config.answer_failures > 0) {
    config.answer_failures -= 1
    return fail('UNAVAILABLE', 'the copy of the agent did not start')
  }

  const fork = forkFor(input.fork_id)
  if (fork.outcome.state !== 'paused') {
    return fail('REWIND_NOT_PAUSED', `fork ${fork.fork_id} is not waiting for an answer`)
  }

  const need = fork.outcome.need
  if (!need.choices.includes(input.choice)) {
    return fail('REWIND_CHOICE_NOT_ALLOWED', `${input.choice} is not allowed for ${need.function_id}; choose one of ${JSON.stringify(need.choices)}`)
  }

  if (typeof input.auto_read === 'boolean') {
    fork.auto_read = input.auto_read
  }

  if (input.choice === 'stop') {
    forks.delete(fork.fork_id)
    fork.outcome = { state: 'crashed', error: { code: 'REWIND_STOPPED', message: 'stopped by a person; the fork was deleted' } }
    changed('fork', fork.fork_id)
    return publicFork(fork)
  }

  if (input.choice === 'typed' && (input.value === undefined || input.value === null)) {
    return fail('REWIND_BAD_INPUT', 'typed needs a value')
  }

  const now = Date.now()
  // As the core: a live answer is timed, a typed or injected one only says when it was given.
  const answers: Record<Exclude<Choice, 'stop'>, () => StoredAnswer> = {
    live: () => ({
      function_id: need.function_id,
      answer: liveAnswer(need.function_id, need.input, random, now),
      source: 'live',
      timing: liveTiming(need.function_id, random, now),
    }),
    typed: () => ({ function_id: need.function_id, answer: { value: input.value }, source: 'typed', timing: { started_at_ms: now } }),
    inject: () => ({
      function_id: need.function_id,
      answer: { error: { code: 'UNAVAILABLE', message: 'injected by rewind' } },
      source: 'injected',
      timing: { started_at_ms: now },
    }),
  }
  const pick = answers[input.choice] ?? (() => fail('REWIND_BAD_INPUT', `unknown choice ${String(input.choice)}`))
  fork.answers.set(need.seq, pick())
  return run(fork)
})

worker.registerFunction('rewind::lost', async (): Promise<LostRun[]> => {
  await reading()
  return recordings
    .flatMap((recording) => {
      const lost = lostCall(recording)
      return lost ? [{ recording, lost }] : []
    })
    .sort((a, b) => b.recording.started_at_ms - a.recording.started_at_ms)
    .map(({ recording, lost }) => {
      const recovery = recoveryOf(recording.run_id)
      return { ...runRow(recording), lost_at: lost.at, mid_call: lost.midCall, recovery: recovery ? forkSummary(recovery) : null }
    })
})

worker.registerFunction('rewind::recover', async (input: { run_id: string } & ForkSettings): Promise<Fork> => {
  await running()
  const existing = recoveryOf(recordingFor(input.run_id).run_id)
  return existing ? publicFork(existing) : run(newFork(input.run_id, 'recover', null, null, new Map(), input))
})

worker.registerFunction('rewind::save-test', async (input: { fork_id: string; name?: string }): Promise<SavedTest> => {
  await reading()
  const fork = forkFor(input.fork_id)
  const outcome = fork.outcome
  if (outcome.state === 'paused') {
    return fail('REWIND_NOT_FINISHED', `fork ${fork.fork_id} is paused at seq ${outcome.need.seq}; answer it before saving`)
  }

  const name = (input.name ?? `${fork.run_id.slice(0, 8)}-${fork.fork_id}`).trim()
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    return fail('REWIND_BAD_INPUT', 'a test name is lowercase letters, digits, dashes and underscores')
  }

  const fixture: TestFixture = {
    entry: ENTRY,
    input: recordingFor(fork.run_id).input,
    answers: fork.calls.map((c) => ({ seq: c.seq, function_id: c.function_id, answer: c.answer, source: c.source })),
    expect: outcome.state === 'done' ? { status: (outcome.output as { status?: unknown })?.status ?? outcome.output } : { throws: outcome.error.message },
  }
  const testPath = `tests/rewind/${name}.json`
  tests.set(testPath, fixture)
  return { path: testPath, fixture }
})

type ForkStateName = Fork['outcome']['state']

worker.registerFunction('rewind::test', async (input: { path: string }): Promise<TestResult> => {
  await running()
  const fixture = tests.get(input.path) ?? fail('REWIND_NOT_FOUND', `no test at ${input.path}`)
  const answers = new Map(fixture.answers.map((a) => [a.seq, { function_id: a.function_id, answer: a.answer, source: a.source }]))
  const probe: StoredFork = { ...newFork('test', 'debug', null, null, answers), run_id: 'test' }
  forkCount -= 1
  const pseudo: Recording = { run_id: 'test', input: fixture.input as Recording['input'], started_at_ms: 0, duration_ms: 0, calls: [], outcome: { state: 'done', output: null }, scenario: 'ok', code_version: code.version }
  replayFork(probe, pseudo, random, Date.now(), { code })
  const outcome = probe.outcome
  const expect = fixture.expect as { status?: unknown; throws?: unknown }
  const passes: Record<ForkStateName, () => boolean> = {
    done: () => outcome.state === 'done' && 'status' in expect && (outcome.output as { status?: unknown })?.status === expect.status,
    crashed: () => outcome.state === 'crashed' && 'throws' in expect && outcome.error.message === expect.throws,
    paused: () => false,
  }
  return { pass: passes[outcome.state](), expected: fixture.expect, outcome }
})

function recordedOutcome(recording: Recording): ForkOutcome {
  return structuredClone(recording.outcome)
}

// A crash's message comes back with the SDK's code in front, so compare without it.
function sameOutcome(a: ForkOutcome, b: ForkOutcome): boolean {
  const normal = (o: ForkOutcome) =>
    o.state === 'crashed' ? { state: o.state, message: o.error.message.replace(/^[a-z_]+:\s*/, '') } : o
  return sameInput(normal(a), normal(b))
}

// Every fifth run's live model answer gives the duration as text, as the model
// worker sometimes does, so a live check also finds the string duration bug.
function liveFault(runId: string): ModelFault {
  return parseInt(runId.slice(0, 2), 16) % 5 === 0 ? 'string-duration' : 'none'
}

// The latest recorded success of a function in another run, for an irreversible call a live check does not send.
function recordedSuccess(functionId: string, exceptRunId: string): { answer: Answer; runId: string } | undefined {
  for (const recording of [...recordings].reverse()) {
    const call = recording.calls.find((c) => c.function_id === functionId && 'value' in c.answer)
    if (recording.run_id !== exceptRunId && call) {
      return { answer: call.answer, runId: recording.run_id }
    }
  }

  return undefined
}

function checkOne(runId: string, live: boolean): CheckResult {
  const recording = recordingFor(runId)
  const probe = newFork(runId, 'debug', null, null, new Map())
  forkCount -= 1
  const ranLive: CallAt[] = []
  const filled: FilledCall[] = []
  const onMissing = (seq: number, functionId: string, callInput: unknown): StoredAnswer | undefined => {
    const effects = functionInfo(functionId).effects
    if (effects.includes('irreversible')) {
      const success = recordedSuccess(functionId, runId)
      if (success) {
        filled.push({ seq, function_id: functionId, from_run_id: success.runId })
      }

      return success ? { function_id: functionId, answer: success.answer, source: 'recorded' } : undefined
    }

    if (!liveAllowed(effects, 'debug')) {
      return undefined
    }

    ranLive.push({ seq, function_id: functionId })
    const answer: Answer =
      functionId === 'model::complete' ? { value: modelAnswer(callInput as Parameters<typeof modelAnswer>[0], liveFault(runId)) } : liveAnswer(functionId, callInput, random, Date.now())
    return { function_id: functionId, answer, source: 'live', timing: liveTiming(functionId, random, Date.now()) }
  }
  replayFork(probe, recording, random, Date.now(), { code, onMissing: live ? onMissing : undefined })
  const outcome = probe.outcome
  const result: CheckResult = { run_id: runId, result: 'same', recorded: recordedOutcome(recording), outcome, code: targetCode(), live_calls: ranLive.length, live: ranLive, filled }
  if (outcome.state === 'paused') {
    result.result = 'stopped'
    result.stopped_at = { seq: outcome.need.seq, function_id: outcome.need.function_id }
  } else if (!sameOutcome(result.recorded, outcome)) {
    result.result = 'different'
  }

  return result
}

// One copy replays every run, so only the first run pays for starting it.
worker.registerFunction('rewind::check', async (input: { run_ids: string[]; live?: boolean }): Promise<CheckResult[]> => {
  const results: CheckResult[] = []
  await running()
  for (const runId of input.run_ids ?? []) {
    await sleep(input.live ? 320 : 140)
    const result = checkOne(runId, Boolean(input.live))
    results.push(result)
    changed('check', runId, { check: result })
  }

  return results
})

// ── dev controls and a simulated traffic::burst ─────────────────────────

worker.registerFunction(
  'rewind-dev::configure',
  async (input: {
    delay_ms?: number
    run_ms?: number
    fail?: boolean
    answer_failures?: number
    empty?: boolean
    reset?: boolean
    code_change?: boolean
    undeclared?: string[]
  }) => {
    if (typeof input.delay_ms === 'number') {
      config.delay_ms = input.delay_ms
    }

    if (typeof input.answer_failures === 'number') {
      config.answer_failures = input.answer_failures
    }

    if (typeof input.run_ms === 'number') {
      config.run_ms = input.run_ms
    }

    if (typeof input.fail === 'boolean') {
      config.fail = input.fail
    }

    if (input.reset || typeof input.empty === 'boolean') {
      reset(Boolean(input.empty))
    }

    if (input.code_change) {
      code = FIXED_CODE
      codeChangedAt = Date.now()
      changed('code', code.version)
    }

    if (Array.isArray(input.undeclared)) {
      setUndeclared(input.undeclared)
    }

    // The core sends no event when its data changes underneath a page, so a page opened before a reset keeps what it read.
    return { ...config, runs: recordings.length, code: targetCode() }
  },
  { description: 'Mock only: set latency, failure and seed state', metadata: { internal: true } },
)

worker.registerFunction(
  'traffic::burst',
  async (input: { count?: number; interval_ms?: number }) => {
    const count = input.count ?? 20
    const interval = input.interval_ms ?? 400
    const tally = { sent: count, booked: 0, failed: 0, errors: 0 }
    for (let index = 0; index < count; index++) {
      if (index > 0) {
        await sleep(interval)
      }

      const recording = recordRun(trafficRequest(index), Date.now(), burstScenario(random), random, 0.5 + random() * 0.5, code)
      recordings.push(recording)
      changed('run', recording.run_id)
      const status = recording.outcome.state === 'done' ? (recording.outcome.output as { status?: string }).status : 'error'
      const outcome: Record<string, keyof typeof tally> = { booked: 'booked', failed: 'failed' }
      tally[outcome[status ?? ''] ?? 'errors'] += 1
    }

    return tally
  },
  { description: 'Mock stand-in for the traffic worker: records simulated agent::run calls', metadata: { effects: ['writes'] } },
)

// ── the page itself ─────────────────────────────────────────────────────

worker.registerFunction(
  'rewind::ui-content',
  async (input: { path: string }) => {
    const asset = ASSETS.find((a) => a.path === input.path) ?? fail('UNKNOWN_UI_ASSET', input.path)
    return { content: readFileSync(path.join(dist, asset.file), 'utf8'), content_type: asset.contentType }
  },
  { description: 'Serves the Rewind console UI assets', metadata: { internal: true } },
)

// Styles before the script, so the page never renders unstyled.
let registered = ASSETS.map((a) => worker.registerTrigger({ type: a.type, function_id: 'rewind::ui-content', config: { path: a.path } }))

// A rebuild changes the bytes; registering the paths again makes the console
// fetch them and hot reload every open tab. The new triggers go in first.
let pending: NodeJS.Timeout | undefined
watch(dist, () => {
  clearTimeout(pending)
  pending = setTimeout(() => {
    const previous = registered
    registered = ASSETS.map((a) => worker.registerTrigger({ type: a.type, function_id: 'rewind::ui-content', config: { path: a.path } }))
    for (const trigger of previous) {
      trigger.unregister()
    }

    process.stdout.write('RELOADED rewind ui\n')
  }, 250)
})

process.stdout.write(`READY rewind mock on ${ENGINE_URL}, ${recordings.length} runs, pid ${process.pid}\n`)

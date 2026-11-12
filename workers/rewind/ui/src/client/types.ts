/**
 * The shapes the page exchanges with Rewind, as docs/rewind.md gives them and
 * the Rust core sends them. Where the core settled what the spec left open,
 * this file follows the core: run status includes `stopped`, a run row counts
 * its calls, `ForkSummary` is a fork without calls, lost rows have `lost_at`,
 * seq starts at 0, and `rewind::replay` replays a run with no edits.
 *
 * A field a newer core added is optional here when an older core leaves it
 * out, so the page still works against one. Each union the core sends as a
 * serde enum is listed as a constant, which the contract test compares with
 * the Rust enum.
 */

export type ErrorValue = { code?: string; message: string }

export type Answer = { value: unknown } | { error: ErrorValue }

/**
 * Where a call's answer came from. `filled` is another run's newest success for
 * a call a fork could not run live, such as an irreversible one. `copy` is what
 * a copy of the callee's worker returned, because the fork copies that worker.
 */
export const ANSWER_SOURCES = ['recorded', 'edited', 'injected', 'live', 'typed', 'filled', 'copy'] as const

export type AnswerSource = (typeof ANSWER_SOURCES)[number]

/** What a call went through. A request around iii is a `fetch` or an `http_out`. */
export const CALL_KINDS = ['iii', 'fetch', 'http_out', 'function', 'http_in'] as const

export type CallKind = (typeof CALL_KINDS)[number]

/**
 * A call's place in its run: its position under each caller, from the run
 * down. Only a call inside another call has one, and its `seq` is then the
 * seq of the run's call it is in.
 */
export type CallPath = number[]

export type Call = {
  seq: number
  path?: CallPath
  function_id: string
  worker: string
  effects: string[]
  input: unknown
  answer: Answer
  source: AnswerSource
  /** On a filled call, the run whose answer it got. */
  filled_from?: string
  /** Why the caller's view differs from the callee's outcome, such as a timeout the caller saw. */
  inferred?: string
  invocation_id?: string
  started_at_ms?: number
  duration_ms?: number
  /** Where this call is in the ADE's traces. A core that does not keep them sends neither. */
  trace_id?: string
  span_id?: string
  /**
   * What the call went through. A request around iii, such as the agent's
   * fetch, has `outside_iii`, its method and its URL, and its function id is
   * `fetch GET <url>`. An older core sends none of these.
   */
  kind?: CallKind
  outside_iii?: boolean
  method?: string
  url?: string
  /**
   * Requests the callee's worker made while it ran, such as the email POST
   * under `email::send`, and in a fork, the calls a copied call made.
   */
  inner?: Call[]
  /** On a fork call: when the copy made it, in ms from the start of that rerun, and how long the stub took. */
  rerun_at_ms?: number
  rerun_ms?: number
}

/** A body the preload cut past `REWIND_MAX_BODY_BYTES`: the whole body's length and its SHA-256. */
export type CutBody = { bytes: number; sha256: string }

/**
 * A request around iii, as a request call's input. A copy's question lists
 * the secret headers its preload left out in `redacted_headers`. A request
 * with `body_truncated` is never sent live, since only the start of its body
 * would go out.
 */
export type HttpRequest = {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string | null
  body_encoding?: 'base64'
  body_truncated?: CutBody
  redacted_headers?: string[]
}

/** A request's answer: the response, with its body as text, or base64 when it is not UTF-8. */
export type HttpResponse = { status: number; status_text?: string; headers?: Record<string, string>; body: string | null; body_encoding?: 'base64'; body_truncated?: CutBody }

/** A traced function that ran inside one iii call, from `rewind::spans`. `name` is `function <file>:<name>`. */
export type FunctionSpan = {
  id: string
  name: string
  worker?: string
  invocation_id?: string
  function_id?: string
  trace_id?: string
  span_id?: string
  started_at_ms: number
  duration_ms: number
  status: string
  input: unknown
  output?: unknown
  error?: unknown
}

export type Choice = 'live' | 'typed' | 'inject' | 'stop'

/**
 * Why a fork paused: a stop someone set on the function, a call with no
 * answer to record, run live or fill, or the call a dead worker took with it
 * while it ran. An older core sends no reason.
 */
export const PAUSE_REASONS = ['stop', 'no_answer', 'lost'] as const

export type PauseReason = (typeof PAUSE_REASONS)[number]

export type PausedNeed = {
  seq: number
  /** For a call inside another call, the same as `Call.path`. */
  path?: CallPath
  function_id: string
  input: unknown
  /** Empty when nobody declared any effects for the function. */
  effects: string[]
  choices: string[]
  reason?: PauseReason
  trace_id?: string
  span_id?: string
  /** The JSON schema of what the function returns, when it declares one. */
  response_format?: unknown
}

export const OUTCOME_STATES = ['done', 'crashed', 'paused'] as const

export type ForkOutcome =
  | { state: 'done'; output: unknown }
  | { state: 'crashed'; error: ErrorValue }
  | { state: 'paused'; need: PausedNeed }

/**
 * A version of the worker under test's code, and when it last changed. An
 * older core sends no code fields at all, so each one is optional here, and
 * null means the core could not tell.
 */
export type CodeVersion = { version: string; changed_at_ms: number }

/** `debug` is a fork a person made or a replay; `recover` finishes a run a dead worker cut off. */
export const FORK_MODES = ['debug', 'recover'] as const

export type ForkMode = (typeof FORK_MODES)[number]

export type Fork = {
  fork_id: string
  run_id: string
  /** Fork id, or null for a fork of the original. */
  parent: string | null
  /** The seq that was edited; null for a replay or a recovery. */
  edit_at: number | null
  namespace: string
  mode: ForkMode
  auto_read: boolean
  /**
   * With `auto`, a call the recording has no answer for runs live when its
   * effects allow it and is filled from another run otherwise, so the fork
   * pauses only at a function in `stops` or a call with nothing to fill from.
   * An older core sends neither.
   */
  auto?: boolean
  stops?: string[]
  /** The workers the fork runs copies of, the root's first. An older core copies only the root's and sends none. */
  copy?: string[]
  calls: Call[]
  outcome: ForkOutcome
  /** The code the fork's copy of the worker ran. */
  code?: CodeVersion | null
  /** The trace of the fork's latest rerun, and its entry span. */
  trace_id?: string | null
  span_id?: string | null
  /** When the latest rerun started and how long it took, once the core measures it. */
  rerun?: { started_at_ms: number; duration_ms: number } | null
}

export type ForkSummary = Omit<Fork, 'calls'> & { created_at_ms: number }

/** `stopped` when a worker died under the run, even if the agent caught the error and returned. */
export type RunStatus = 'success' | 'error' | 'stopped'

export type RunRow = {
  run_id: string
  /** The root's function, such as `agent::run`, or `calendar::find-slot` for a call made with `iii trigger`. */
  function_id?: string
  status: RunStatus
  error?: ErrorValue
  input: unknown
  output?: unknown
  started_at_ms: number
  duration_ms: number
  calls: number
  /** The code version when the run was recorded. */
  code_version?: string | null
  /** The run's trace in the ADE, and its entry span. */
  trace_id?: string
  span_id?: string
}

/** A worker in `default` connecting or going away, while a run was going or up to five seconds after. */
export type WorkerChange = { at_ms: number; worker: string; worker_id: string; event: 'connected' | 'disconnected' }

/** `worker_changes` is missing on a core that does not record them yet. */
export type RunDetail = { run: RunRow; calls: Call[]; forks: ForkSummary[]; worker_changes?: WorkerChange[] }

/**
 * A run a dead worker cut short. `lost_at` is the seq the lost call would have
 * had. `mid_call` is false when that call failed with function_not_found
 * because the worker was already gone, so it never ran. An older core sends
 * no `mid_call`.
 */
export type LostRun = RunRow & { lost_at: number; mid_call?: boolean; recovery: ForkSummary | null }

export type Status = {
  engine: string
  entry: string
  recording: string[]
  /** Runs of the entry function. */
  runs: number
  /** Runs whose root is a request that arrived at a worker's own HTTP server. */
  inbound_runs?: number
  forks: number
  /** The code on disk now. A core that sends it also has `rewind::check`. */
  target_code?: CodeVersion | null
  /** How far behind Rewind's writer is. An older core sends nothing. */
  recorder?: RecorderBacklog
}

/**
 * Calls waiting for Rewind's writer, how many may wait, and how many Rewind dropped since it
 * started because that many were already waiting.
 */
export type RecorderBacklog = { waiting: number; limit: number; dropped: number }

/** A call in a run, by its place. */
export type CallAt = { seq: number; path?: CallPath; function_id: string }

/** An irreversible call a live check did not send, answered with that function's latest recorded success from another run. */
export type FilledCall = CallAt & { from_run_id: string }

/** `same` ended like the recording, `stopped` reached a call it could not answer, `different` ended otherwise. */
export const CHECK_VERDICTS = ['same', 'different', 'stopped'] as const

export type CheckVerdict = (typeof CHECK_VERDICTS)[number]

/**
 * One run replayed against the current code by `rewind::check`. Without
 * `live`, a call the recording lacks stops the run. With it, those calls run
 * live where their effects allow, and irreversible ones are filled instead.
 * An older core leaves out the code and every field about live calls.
 */
export type CheckResult = {
  run_id: string
  result: CheckVerdict
  recorded: ForkOutcome
  outcome: ForkOutcome
  stopped_at?: CallAt
  code?: CodeVersion
  live_calls?: number
  /** Each call the check ran live, in run order. */
  live?: CallAt[]
  filled?: FilledCall[]
}

/** `request_format` and `response_format` are the JSON schemas the function registered, as the engine reports them. */
export type FunctionRow = {
  function_id: string
  worker: string
  effects: string[]
  recording: boolean
  request_format?: unknown
  response_format?: unknown
}

/** One connection from `engine::workers::list`. `runtime` is the SDK's: node, python or rust. */
export type EngineWorker = { name: string; runtime?: string | null }

/** `failed` also matches runs where any call returned an error, and stopped runs. */
export type RunsFilter = 'all' | 'failed' | 'stopped'

/** Which roots `rewind::runs` lists: the entry's runs (the default), inbound requests, both, or every root. */
export type RunsRoot = 'entry' | 'http_in' | 'all' | 'any'

export type RunsRequest = {
  filter?: RunsFilter
  q?: string
  limit?: number
  root?: RunsRoot
  /** Only the roots of this function; `root` is ignored then. */
  function_id?: string
  before_ms?: number
  since_ms?: number
}

/** What every request that starts a fork may set. `copy` lists workers to copy besides the root's own. */
export type ForkSettings = { auto_read?: boolean; auto?: boolean; stops?: string[]; copy?: string[] }

export type ForkRequest = ForkSettings & {
  run_id: string
  base?: string
  at_seq: number
  answer: Answer
  source: 'edited' | 'injected'
}

/** Changes a fork's settings and reruns it, keeping the answers it already has. */
export type ForkSetRequest = { fork_id: string; auto?: boolean; stops?: string[] }

/** `value` is the raw JSON for `typed`, not wrapped in `{ value }`. */
export type AnswerRequest = { fork_id: string; choice: Choice; value?: unknown; auto_read?: boolean }

/**
 * One call in a saved test and the answer it gets. `input` is what the call sent when the test was
 * saved, and a call gets the answer only when it sends the same input, unless `match` is `function`.
 */
export type TestAnswer = { seq: number; path?: CallPath; function_id: string; input?: unknown; match?: 'function'; answer: Answer; source: AnswerSource }

export type TestFixture = {
  entry: string
  input: unknown
  answers: TestAnswer[]
  /** A run that returned a `status` expects it; one that returned anything else expects the whole output. */
  expect: { status: unknown } | { throws: unknown } | { output: unknown }
}

export type SavedTest = { path: string; fixture: TestFixture }

/** One field of a call's input, as a JSON pointer. A field only one side has leaves the other out. */
export type InputDifference = { field: string; saved?: unknown; sent?: unknown }

/**
 * Where a test's run left its file: the call that paused it and what it sent, what the file has
 * at that place, and each field of the input that changed. `saved` is missing when the file has
 * no call there, and `differences` is empty when the file has another function there.
 */
export type TestDiverged = {
  seq: number
  path?: CallPath
  function_id: string
  input: unknown
  saved?: { function_id: string; input?: unknown }
  differences: InputDifference[]
}

/** `diverged` comes only from a core that compares inputs, and only when the run paused. */
export type TestResult = { pass: boolean; expected: unknown; outcome: unknown; diverged?: TestDiverged }

/**
 * What `rewind::changed` sends. A `code` event's id is the new code version. A
 * `fork` event also has the trace of the fork's latest rerun. A `check` event
 * fires once per run as `rewind::check` finishes it, with the run id and the
 * result.
 */
/** `recorder` means Rewind dropped calls, and its id is how many since Rewind started. */
export type ChangedEvent = { kind: 'run' | 'fork' | 'lost' | 'code' | 'check' | 'recorder'; id: string; trace_id?: string | null; check?: CheckResult }

/** The error a stopped fork comes back with. */
export const STOPPED_FORK_CODE = 'REWIND_STOPPED'

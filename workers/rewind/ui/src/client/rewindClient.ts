/**
 * Typed calls to Rewind's `rewind::*` functions over the console tab's bus
 * client. The page talks to Rewind through nothing else. It asks the engine
 * one thing of its own: which runtime each worker runs, for the player.
 */
import type { ExtensionIii } from '@iii-dev/console-ui'
import type {
  AnswerRequest,
  CheckResult,
  EngineWorker,
  Fork,
  ForkRequest,
  ForkSetRequest,
  ForkSettings,
  FunctionSpan,
  FunctionRow,
  LostRun,
  RunDetail,
  RunRow,
  RunsRequest,
  SavedTest,
  Status,
  TestResult,
} from './types'

const READ_TIMEOUT_MS = 10_000
// Running a fork starts a copy of the worker under test (1 to 3 s), may call
// functions live, and waits out recorded slow calls, so these wait longer.
const RUN_TIMEOUT_MS = 120_000
const CHECK_MS_PER_RUN = 5_000
const CHECK_TIMEOUT_CAP_MS = 900_000

export type RewindClient = ReturnType<typeof createRewindClient>

/** What `rewind::check` takes besides the runs. `copy` lists workers to copy besides the root's own. */
export type CheckOptions = { live?: boolean; copy?: string[] }

/**
 * The page's only way to Rewind, over the console tab's bus client. Reads
 * time out after 10 s. Anything that starts a copy of a worker (a fork, a
 * replay, an answer, a recovery, a test) waits up to 120 s, and a check waits
 * 5 s more for every run it replays. A setting left undefined is dropped when
 * the payload is sent as JSON, so the core applies its own default.
 */
export function createRewindClient(iii: ExtensionIii) {
  const read = <T>(fn: string, payload: Record<string, unknown> = {}) =>
    iii.call<T>(fn, payload, { timeoutMs: READ_TIMEOUT_MS })
  const run = <T>(fn: string, payload: Record<string, unknown>) => iii.call<T>(fn, payload, { timeoutMs: RUN_TIMEOUT_MS })

  return {
    status: () => read<Status>('rewind::status'),
    functions: () => read<FunctionRow[]>('rewind::functions'),
    recordToggle: (function_id: string, enabled: boolean) =>
      read<FunctionRow>('rewind::record-toggle', { function_id, enabled }),
    runs: (request: RunsRequest = {}) => read<RunRow[]>('rewind::runs', { ...request }),
    run: (run_id: string) => read<RunDetail>('rewind::run', { run_id }),
    replay: (run_id: string, settings: ForkSettings = {}) => run<Fork>('rewind::replay', { run_id, ...settings }),
    fork: (request: ForkRequest) => run<Fork>('rewind::fork', { ...request }),
    forkSet: (request: ForkSetRequest) => run<Fork>('rewind::fork-set', { ...request }),
    forkGet: (fork_id: string) => read<Fork>('rewind::fork-get', { fork_id }),
    answer: (request: AnswerRequest) => run<Fork>('rewind::answer', { ...request }),
    lost: () => read<LostRun[]>('rewind::lost'),
    recover: (run_id: string, settings: Omit<ForkSettings, 'auto_read'> = {}) => run<Fork>('rewind::recover', { run_id, ...settings }),
    saveTest: (fork_id: string, name?: string) => read<SavedTest>('rewind::save-test', { fork_id, name: name || undefined }),
    test: (path: string) => run<TestResult>('rewind::test', { path }),
    check: (run_ids: string[], { live, copy }: CheckOptions = {}) =>
      iii.call<CheckResult[]>('rewind::check', { run_ids, live, copy }, { timeoutMs: checkTimeout(run_ids.length) }),
    workers: () => read<{ workers?: EngineWorker[] }>('engine::workers::list'),
    spans: (invocation_id: string) => read<FunctionSpan[]>('rewind::spans', { invocation_id }),
  }
}

// One check replays every run on one copy, one after another, so it waits longer the more runs it has.
function checkTimeout(runs: number): number {
  return Math.min(RUN_TIMEOUT_MS + runs * CHECK_MS_PER_RUN, CHECK_TIMEOUT_CAP_MS)
}

/**
 * What the start script and the measuring scripts share: where each engine
 * listens, which compose file runs it, a connection that calls functions on
 * it, and a few numbers helpers.
 *
 * Engine A (50034) runs the agent, Rewind and the bridge. Engine B (50134)
 * runs the tools, the probe worker and a second Rewind. The one-engine
 * baseline also listens on 50034, so it never runs at the same time as A.
 *
 * Not run on its own. The scripts next to it import it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { registerWorker } from 'iii-sdk'

export const EXPERIMENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_DIR = path.resolve(EXPERIMENT_DIR, '..', '..')
export const RESULTS_DIR = path.join(EXPERIMENT_DIR, 'results')

export const ENGINE_A = 'ws://127.0.0.1:50034'
export const ENGINE_B = 'ws://127.0.0.1:50134'
export const PROVIDERS = 'http://127.0.0.1:50036'
export const ADE_PORT = 4033

export const III_BIN = process.env.III_BIN ?? 'iii'

export type Setup = 'single' | 'engine-a' | 'engine-b'

export function composeDir(setup: Setup): string {
  return path.join(EXPERIMENT_DIR, setup)
}

export function composeFile(setup: Setup): string {
  return path.join(composeDir(setup), 'worker-compose.yaml')
}

export const OUTBOX_A = path.join(composeDir('engine-a'), 'data', 'outbox.jsonl')
export const OUTBOX_SINGLE = path.join(composeDir('single'), 'data', 'outbox.jsonl')

export type Engine = Awaited<ReturnType<typeof connect>>

/** One SDK connection to an engine, with a trigger that never waits less than the call needs. */
export function connect(url: string, workerName: string) {
  const worker = registerWorker(url, { workerName })
  async function call<T>(functionId: string, payload: unknown = {}, timeoutMs = 120_000): Promise<T> {
    return worker.trigger<unknown, T>({ function_id: functionId, payload, timeoutMs })
  }

  return { url, worker, call, shutdown: () => worker.shutdown() }
}

export type FunctionRow = { function_id: string; namespace?: string; worker_name?: string; metadata?: Record<string, unknown>; description?: string }
export type WorkerRow = { id: string; name?: string; namespace?: string; pid?: number; status?: string; function_count?: number }

export async function functions(engine: Engine): Promise<FunctionRow[]> {
  return (await engine.call<{ functions: FunctionRow[] }>('engine::functions::list', {}, 10_000)).functions
}

export async function workers(engine: Engine): Promise<WorkerRow[]> {
  return (await engine.call<{ workers: WorkerRow[] }>('engine::workers::list', {}, 10_000)).workers
}

export function inDefault(row: { namespace?: string }): boolean {
  return (row.namespace ?? 'default') === 'default'
}

/** Waits until every one of `ids` is listed in `default`. Returns how long that took, or throws. */
export async function waitForFunctions(engine: Engine, ids: string[], timeoutMs: number): Promise<number> {
  const started = Date.now()
  for (;;) {
    try {
      const listed = new Set((await functions(engine)).filter(inDefault).map((f) => f.function_id))
      const missing = ids.filter((id) => !listed.has(id))
      if (missing.length === 0) {
        return Date.now() - started
      }

      if (Date.now() - started > timeoutMs) {
        throw new Error(`still missing on ${engine.url} after ${timeoutMs} ms: ${missing.join(', ')}`)
      }
    } catch (error) {
      if (Date.now() - started > timeoutMs) {
        throw error
      }
    }

    await sleep(250)
  }
}

type IiiProcess = { pid: number; kind: string; name: string; compose_file: string | null; command: string }

function processes(setup: Setup): IiiProcess[] {
  const listing = execFileSync(III_BIN, ['ps', '--json'], { encoding: 'utf8' })
  const file = composeFile(setup)
  return (JSON.parse(listing) as IiiProcess[]).filter((p) => p.compose_file === file)
}

/** The pid of a worker compose started from one of this experiment's compose files. */
export function workerPid(setup: Setup, name: string): number | undefined {
  return processes(setup).find((p) => p.kind === 'worker' && p.name === name && !p.command.includes('esbuild'))?.pid
}

/** The pid of the engine compose started for one of this experiment's compose files. */
export function enginePid(setup: Setup): number | undefined {
  return processes(setup).find((p) => p.kind === 'engine')?.pid
}

export function lines(file: string): string[] {
  if (!existsSync(file)) {
    return []
  }

  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
}

/** Rows from one of Rewind's sqlite files, read with the sqlite3 command line tool. */
export function sqlite<T>(file: string, query: string): T[] {
  const out = execFileSync('sqlite3', ['-readonly', '-json', file, query], { encoding: 'utf8' }).trim()
  return out === '' ? [] : (JSON.parse(out) as T[])
}

export function rewindDb(setup: Setup): string {
  return path.join(composeDir(setup), 'data', 'rewind.sqlite')
}

export type Summary = { n: number; mean: number; p50: number; p90: number; p99: number; min: number; max: number }

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

export function summarize(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length)
  return {
    n: sorted.length,
    mean,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

export function formatSummary(label: string, s: Summary): string {
  const ms = (value: number) => value.toFixed(2).padStart(8)
  return `${label.padEnd(44)} n=${String(s.n).padStart(3)} mean ${ms(s.mean)}  p50 ${ms(s.p50)}  p90 ${ms(s.p90)}  p99 ${ms(s.p99)}  min ${ms(s.min)}  max ${ms(s.max)}  (ms)`
}

export { sleep }

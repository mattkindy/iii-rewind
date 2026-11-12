/**
 * Measures how many calls per second one iii engine can have recorded. It starts a fresh
 * engine on 49534, lanes of a small app (src/lane.ts) and one recorder, sends calls at a
 * rising rate, and compares calls made with calls stored, engine drops, and catch-up time.
 *
 * Recorders: `rewind` is Rewind's binary with its SQLite writer, `noop` only counts (the
 * ceiling), `batch` sends envelopes to a store worker in one call per batch, and `none`
 * records nothing, which is what the app alone can do on this machine.
 *
 * Build workers/rewind and experiments/scale/noop with cargo build --release first. Then:
 *   npx tsx src/bench.ts rewind
 *   npx tsx src/bench.ts noop --lanes 4 --seconds 10 --rates 1000,2000,4000
 * Each run writes results/<label>.json and leaves its logs and database in runs/<label>; the label
 * defaults to the recorder. SCALE_MAX_IN_FLIGHT sets max_in_flight on the noop and batch observers.
 * III_BIN is the engine. The lanes and Rewind use iii-sdk 0.26, so it has to be an iii 0.26 binary.
 * The noop and batch targets still build against the 0.25 Rust SDK and were measured on iii 0.25.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, loadavg } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { registerWorker } from 'iii-sdk'

const SCALE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DIR = path.resolve(SCALE_DIR, '..', '..')
const REWIND_DIR = path.join(REPO_DIR, 'workers', 'rewind')
const NOOP_BIN = path.join(SCALE_DIR, 'noop', 'target', 'release', 'scale-noop')
const III_BIN = process.env.III_BIN ?? path.join(process.env.HOME ?? '', '.local', 'bin', 'iii')
const SQLITE_BIN = process.env.SQLITE_BIN ?? 'sqlite3'
const PORT = 49534
const ENGINE_URL = `ws://127.0.0.1:${PORT}`

// Results are committed, so the engine's path leaves out this machine's home folder.
function shownPath(file: string): string {
  const inRepo = path.relative(REPO_DIR, file)
  if (!inRepo.startsWith('..')) {
    return inRepo
  }

  return file.replace(homedir(), '~')
}

type RecorderName = 'rewind' | 'noop' | 'batch' | 'none'

type Options = { recorder: RecorderName; label: string; lanes: number; seconds: number; fanout: number; padBytes: number; rates: number[] }

const DEFAULT_RATES = [500, 1000, 2000, 3000, 4000, 6000, 8000, 12000, 16000, 24000]

function parseOptions(argv: string[]): Options {
  const recorder = argv[0] as RecorderName
  if (!['rewind', 'noop', 'batch', 'none'].includes(recorder)) {
    console.error('usage: bench.ts rewind|noop|batch|none [--lanes n] [--seconds s] [--fanout n] [--pad bytes] [--rates a,b,c]')
    process.exit(2)
  }

  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? undefined : argv[at + 1]
  }
  return {
    recorder,
    label: flag('label') ?? recorder,
    lanes: Number(flag('lanes') ?? 4),
    seconds: Number(flag('seconds') ?? 10),
    fanout: Number(flag('fanout') ?? 9),
    padBytes: Number(flag('pad') ?? 512),
    rates: (flag('rates') ?? DEFAULT_RATES.join(',')).split(',').map(Number),
  }
}

const options = parseOptions(process.argv.slice(2))
const RUN_DIR = path.join(SCALE_DIR, 'runs', options.label)
const children: { role: string; child: ChildProcess }[] = []

function start(role: string, command: string, args: string[], cwd: string, env: Record<string, string> = {}): ChildProcess {
  const log = openSync(path.join(RUN_DIR, `${role}.log`), 'a')
  const child = spawn(command, args, { cwd, env: { ...process.env, III_URL: ENGINE_URL, ...env }, stdio: ['ignore', log, log] })
  children.push({ role, child })
  return child
}

async function stopAll(): Promise<void> {
  for (const { child } of [...children].reverse()) {
    child.kill('SIGTERM')
  }

  await sleep(3000)
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
}

function writeEngineConfig(): void {
  const config = ['workers:', '  - name: iii-worker-manager', '    config:', '      host: 127.0.0.1', `      port: ${PORT}`, '']
  writeFileSync(path.join(RUN_DIR, 'config.yaml'), config.join('\n'))
}

const bench = registerWorker(ENGINE_URL, { workerName: 'scale-bench' })

async function call<T>(functionId: string, payload: unknown = {}): Promise<T> {
  return bench.call<unknown, T>({ function_id: functionId, payload, timeoutMs: 30_000 })
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return
      }
    } catch {
      // The engine or a worker is still starting.
    }

    await sleep(250)
  }

  throw new Error(`timed out waiting for ${what}`)
}

type ObserverRow = { function_id: string; state: string; fires: number; dropped: Record<string, number>; target: { function_id: string } }

async function observers(target: string): Promise<ObserverRow[]> {
  const listed = await call<{ observers: ObserverRow[] }>('engine::observers::list', {})
  return listed.observers.filter((row) => row.target.function_id === target && row.function_id.startsWith('scale::'))
}

type Totals = { fires: number; dropped: Record<string, number> }

async function observerTotals(target: string | undefined): Promise<Totals> {
  const totals: Totals = { fires: 0, dropped: {} }
  if (target === undefined) {
    return totals
  }

  for (const row of await observers(target)) {
    totals.fires += row.fires
    for (const [reason, count] of Object.entries(row.dropped ?? {})) {
      totals.dropped[reason] = (totals.dropped[reason] ?? 0) + count
    }
  }

  return totals
}

function laneFunctions(lanes: number): string[] {
  return Array.from({ length: lanes }, (_, lane) => [`scale::run-${lane}`, `scale::echo-${lane}`]).flat()
}

type Recorder = {
  /** The function the observers deliver to, or none when nothing records. */
  target?: string
  start: () => void
  /** How many recorded calls the recorder has stored so far. */
  stored: () => Promise<number>
  /** Counters since the recorder started, read after each step. */
  details?: () => Promise<Record<string, number>>
}

function rewindStored(): number {
  const db = path.join(RUN_DIR, 'data', 'rewind.sqlite')
  if (!existsSync(db)) {
    return 0
  }

  const out = execFileSync(SQLITE_BIN, ['-readonly', db,"select count(*) from events where function_id like 'scale::%'"], { encoding: 'utf8' })
  return Number(out.trim())
}

type Stats = { received: number; batches: number; batched_events: number; failed_batches: number; flush_ms_mean: number; flush_ms_max: number }

async function stats(role: string): Promise<Stats> {
  return call<Stats>(`scale::stats-${role}`, {})
}

const RECORDERS: Record<RecorderName, Recorder> = {
  rewind: {
    target: 'rewind::record',
    start: () => {
      start('rewind', path.join(REWIND_DIR, 'target', 'release', 'rewind'), [], REWIND_DIR, {
        III_COMPOSE_DIR: RUN_DIR,
        REWIND_ENTRY: 'scale::run-0',
        // Rewind hashes this folder for code versions, so it must not contain the run's database.
        REWIND_TARGET_DIR: path.join(SCALE_DIR, 'src'),
        REWIND_POOL_SIZE: '0',
        REWIND_CAPTURE_FILE: path.join(RUN_DIR, 'data', 'captures.jsonl'),
        REWIND_UI_DIST: path.join(RUN_DIR, 'no-ui'),
      })
    },
    stored: async () => rewindStored(),
    details: async () => {
      const status = await call<{ recorder?: { waiting: number; limit: number; dropped: number } }>('rewind::status', {})
      return status.recorder ?? {}
    },
  },
  noop: {
    target: 'scale::noop-record',
    start: () => {
      start('noop', NOOP_BIN, ['noop'], SCALE_DIR, { SCALE_OBSERVE: laneFunctions(options.lanes).join(',') })
    },
    stored: async () => (await stats('noop')).received,
  },
  batch: {
    target: 'scale::noop-record',
    start: () => {
      start('sink', NOOP_BIN, ['sink'], SCALE_DIR)
      start('batch', NOOP_BIN, ['batch'], SCALE_DIR, { SCALE_OBSERVE: laneFunctions(options.lanes).join(',') })
    },
    stored: async () => (await stats('sink')).received,
    details: async () => {
      const batcher = await stats('batch')
      return { batches: batcher.batches, failed_batches: batcher.failed_batches, flush_ms_mean: batcher.flush_ms_mean, flush_ms_max: batcher.flush_ms_max }
    },
  },
  none: {
    start: () => {},
    stored: async () => 0,
  },
}

/** Cumulative CPU seconds of each pid, from `ps`, which prints them as [[h:]m:]s.cc. */
function cpuSeconds(pids: number[]): Map<number, number> {
  const seconds = new Map<number, number>()
  const alive = pids.filter((pid) => pid > 0)
  if (alive.length === 0) {
    return seconds
  }

  let out = ''
  try {
    out = execFileSync('ps', ['-o', 'pid=,time=', '-p', alive.join(',')], { encoding: 'utf8' })
  } catch {
    return seconds
  }

  for (const line of out.trim().split('\n')) {
    const [pidText, time] = line.trim().split(/\s+/)
    const parts = time.split(':').map(Number)
    const total = parts.reduce((sum, part) => sum * 60 + part, 0)
    seconds.set(Number(pidText), total)
  }

  return seconds
}

function rssMb(pid: number): number {
  try {
    return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024)
  } catch {
    return 0
  }
}

function pidsOf(roles: (role: string) => boolean): number[] {
  return children.filter(({ role }) => roles(role)).map(({ child }) => child.pid ?? 0)
}

type LoadResult = { lane: number; sent: number; done: number; errors: number; skipped: number; calls_made: number; sending_ms: number; run_ms_p50: number; run_ms_p99: number }

function runLoader(lane: number, runsPerSecond: number): Promise<LoadResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/load.ts', String(lane), String(runsPerSecond), String(options.seconds), String(options.fanout), String(options.padBytes)],
      { cwd: SCALE_DIR, env: { ...process.env, III_URL: ENGINE_URL }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.on('exit', () => {
      const line = out.split('\n').find((text) => text.startsWith('{"lane"'))
      if (line === undefined) {
        reject(new Error(`loader ${lane} printed no result:\n${out}`))
        return
      }

      resolve(JSON.parse(line) as LoadResult)
    })
  })
}

type Step = {
  target_calls_per_s: number
  made_calls_per_s: number
  calls_made: number
  delivered: number
  stored: number
  stored_ratio: number
  dropped: Record<string, number>
  skipped_runs: number
  run_errors: number
  run_ms_p50: number
  run_ms_p99: number
  backlog_max: number
  backlog_at_end: number
  catch_up_ms: number
  cpu_percent: { engine: number; recorder: number; app: number }
  recorder_rss_mb: number
  load_average: number
  recorder_totals?: Record<string, number>
  saturated: string[]
}

function percentOf(before: Map<number, number>, after: Map<number, number>, pids: number[], wallSeconds: number): number {
  const used = pids.reduce((sum, pid) => sum + ((after.get(pid) ?? 0) - (before.get(pid) ?? 0)), 0)
  return Math.round((used / wallSeconds) * 100)
}

/** Waits until the recorder has stored every event the engine delivered, or stops making progress. */
async function catchUp(recorder: Recorder, storedBefore: number, firesBefore: number): Promise<{ ms: number; stored: number; delivered: number }> {
  const started = Date.now()
  let last = -1
  let lastChange = Date.now()
  for (;;) {
    const stored = (await recorder.stored()) - storedBefore
    const delivered = (await observerTotals(recorder.target)).fires - firesBefore
    if (recorder.target === undefined || stored >= delivered) {
      return { ms: Date.now() - started, stored, delivered }
    }

    if (stored !== last) {
      last = stored
      lastChange = Date.now()
    }

    if (Date.now() - lastChange > 10_000 || Date.now() - started > 180_000) {
      return { ms: Date.now() - started, stored, delivered }
    }

    await sleep(100)
  }
}

async function backlog(recorder: Recorder, storedBefore: number, firesBefore: number): Promise<number> {
  if (recorder.target === undefined) {
    return 0
  }

  const delivered = (await observerTotals(recorder.target)).fires - firesBefore
  return delivered - ((await recorder.stored()) - storedBefore)
}

function saturation(rate: number, madeRate: number, skipped: number, storedRatio: number, dropped: Record<string, number>, catchUpMs: number): string[] {
  const reasons: string[] = []
  if (madeRate < rate * 0.85) {
    reasons.push('app made fewer calls than asked')
  }

  if (skipped > 0) {
    reasons.push('runs skipped at the in-flight limit')
  }

  if (storedRatio < 0.99) {
    reasons.push('recorder stored under 99% of calls')
  }

  if (Object.keys(dropped).length > 0) {
    reasons.push('engine dropped events')
  }

  if (catchUpMs > 5000) {
    reasons.push('store took over 5 s to catch up')
  }

  return reasons
}

async function runStep(recorder: Recorder, rate: number): Promise<Step> {
  const runsPerSecondPerLane = rate / (options.fanout + 1) / options.lanes
  const storedBefore = await recorder.stored()
  const totalsBefore = await observerTotals(recorder.target)
  const watched = {
    engine: pidsOf((role) => role === 'engine'),
    recorder: pidsOf((role) => ['rewind', 'noop', 'batch', 'sink'].includes(role)),
    app: pidsOf((role) => role.startsWith('lane')),
  }
  const allPids = [...watched.engine, ...watched.recorder, ...watched.app]
  const cpuBefore = cpuSeconds(allPids)
  const startedAt = Date.now()

  const loaders = Promise.all(Array.from({ length: options.lanes }, (_, lane) => runLoader(lane, runsPerSecondPerLane)))
  let finished = false
  void loaders.finally(() => {
    finished = true
  })
  let backlogMax = 0
  let rss = 0
  while (!finished) {
    await sleep(1000)
    backlogMax = Math.max(backlogMax, await backlog(recorder, storedBefore, totalsBefore.fires))
    rss = Math.max(rss, ...watched.recorder.map(rssMb), 0)
  }

  const results = await loaders
  const wallSeconds = (Date.now() - startedAt) / 1000
  const cpuAfter = cpuSeconds(allPids)
  const atEnd = await backlog(recorder, storedBefore, totalsBefore.fires)
  const caught = await catchUp(recorder, storedBefore, totalsBefore.fires)
  const totalsAfter = await observerTotals(recorder.target)

  const callsMade = results.reduce((sum, r) => sum + r.calls_made, 0)
  const sendingSeconds = Math.max(...results.map((r) => r.sending_ms)) / 1000
  const dropped: Record<string, number> = {}
  for (const [reason, count] of Object.entries(totalsAfter.dropped)) {
    const delta = count - (totalsBefore.dropped[reason] ?? 0)
    if (delta > 0) {
      dropped[reason] = delta
    }
  }

  const skipped = results.reduce((sum, r) => sum + r.skipped, 0)
  const madeRate = Math.round(callsMade / sendingSeconds)
  const storedRatio = recorder.target === undefined ? 1 : caught.stored / Math.max(1, callsMade)
  return {
    target_calls_per_s: rate,
    made_calls_per_s: madeRate,
    calls_made: callsMade,
    delivered: caught.delivered,
    stored: caught.stored,
    stored_ratio: Number(storedRatio.toFixed(4)),
    dropped,
    skipped_runs: skipped,
    run_errors: results.reduce((sum, r) => sum + r.errors, 0),
    run_ms_p50: Math.max(...results.map((r) => r.run_ms_p50)),
    run_ms_p99: Math.max(...results.map((r) => r.run_ms_p99)),
    backlog_max: Math.max(backlogMax, atEnd),
    backlog_at_end: atEnd,
    catch_up_ms: caught.ms,
    cpu_percent: {
      engine: percentOf(cpuBefore, cpuAfter, watched.engine, wallSeconds),
      recorder: percentOf(cpuBefore, cpuAfter, watched.recorder, wallSeconds),
      app: percentOf(cpuBefore, cpuAfter, watched.app, wallSeconds),
    },
    recorder_rss_mb: rss,
    load_average: Number(loadavg()[0].toFixed(1)),
    recorder_totals: await recorder.details?.(),
    saturated: saturation(rate, madeRate, skipped, storedRatio, dropped, caught.ms),
  }
}

function printStep(step: Step): void {
  const dropped = Object.entries(step.dropped).map(([reason, count]) => `${reason} ${count}`).join(' ') || '0'
  console.log(
    [
      `asked ${step.target_calls_per_s}/s`,
      `made ${step.made_calls_per_s}/s`,
      `stored ${step.stored}/${step.calls_made} (${(step.stored_ratio * 100).toFixed(1)}%)`,
      `dropped ${dropped}`,
      `backlog max ${step.backlog_max}`,
      `catch-up ${step.catch_up_ms} ms`,
      `cpu engine ${step.cpu_percent.engine}% recorder ${step.cpu_percent.recorder}% app ${step.cpu_percent.app}%`,
      `rss ${step.recorder_rss_mb} MB`,
      `p99 run ${step.run_ms_p99} ms`,
      `load ${step.load_average}`,
      step.recorder_totals === undefined ? '' : JSON.stringify(step.recorder_totals),
      step.saturated.length > 0 ? `SATURATED: ${step.saturated.join('; ')}` : 'ok',
    ].join(' | '),
  )
}

async function main(): Promise<void> {
  rmSync(RUN_DIR, { recursive: true, force: true })
  mkdirSync(path.join(RUN_DIR, 'data'), { recursive: true })
  writeEngineConfig()
  start('engine', III_BIN, ['-c', 'config.yaml', '--no-update-check'], RUN_DIR)
  await waitFor('the engine', async () => (await call<{ functions: unknown[] }>('engine::functions::list', {})).functions.length > 0)

  for (let lane = 0; lane < options.lanes; lane++) {
    start(`lane-echo-${lane}`, process.execPath, ['--import', 'tsx', 'src/lane.ts', 'echo', String(lane)], SCALE_DIR)
    start(`lane-run-${lane}`, process.execPath, ['--import', 'tsx', 'src/lane.ts', 'run', String(lane)], SCALE_DIR)
  }

  const wanted = laneFunctions(options.lanes)
  await waitFor('the lanes', async () => {
    const listed = await call<{ functions: { function_id: string }[] }>('engine::functions::list', { prefix: 'scale::' })
    const ids = new Set(listed.functions.map((row) => row.function_id))
    return wanted.every((id) => ids.has(id))
  })

  const recorder = RECORDERS[options.recorder]
  recorder.start()
  const target = recorder.target
  if (target !== undefined) {
    await waitFor('the recorder to observe every lane', async () => {
      const active = (await observers(target)).filter((row) => row.state === 'active')
      return wanted.every((id) => active.some((row) => row.function_id === id))
    })
  }

  console.log(`${options.recorder}: ${options.lanes} lanes, ${options.fanout} calls under each run, ${options.padBytes} byte pad, ${options.seconds} s per step`)
  const steps: Step[] = []
  let saturatedSteps = 0
  for (const rate of options.rates) {
    const step = await runStep(recorder, rate)
    steps.push(step)
    printStep(step)
    saturatedSteps += step.saturated.length > 0 ? 1 : 0
    if (saturatedSteps >= 2) {
      break
    }

    await sleep(2000)
  }

  const maxInFlight = process.env.SCALE_MAX_IN_FLIGHT ?? 'engine default'
  const result = { recorder: options.recorder, at: new Date().toISOString(), engine: shownPath(III_BIN), max_in_flight: maxInFlight, options, steps }
  mkdirSync(path.join(SCALE_DIR, 'results'), { recursive: true })
  writeFileSync(path.join(SCALE_DIR, 'results', `${options.label}.json`), `${JSON.stringify(result, null, 2)}\n`)
}

try {
  await main()
} finally {
  await bench.shutdown()
  await stopAll()
}
process.exit(0)

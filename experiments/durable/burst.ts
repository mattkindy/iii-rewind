/**
 * One arm of the durable experiment: a burst of agent runs on the experiment stack, with faults
 * at seeded random points while the burst is being sent, then a count of what happened.
 *
 *   npx tsx burst.ts <arm> [count] [seed]
 *
 * The arms are in ARMS below. Each starts the stack fresh from stack/worker-compose.yaml and
 * writes results/<arm>.json. Run from this folder after `npm install`, with the project's own
 * stack stopped, since both use port 49734.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { countRun, type JournalDetail, type Metric, requestOfCapture, type RunReport, type Send, summarize } from './count.js'
import { brief, HERE, III_BIN, log, sleep, startProxy } from './lib.js'
import { COMPOSE_FILE, DATA_DIR, observeCalls, STACK_URL, startStack, waitForRestart } from './stack.js'

const KILL_SCRIPT = path.resolve(HERE, '../../scripts/kill.ts')

type Fault = 'none' | 'kill-agent' | 'kill-journal' | 'cut-agent'
type Arm = { durable: boolean; start: 'call' | 'queue'; retry: boolean; fault: Fault; faults: number; what: string }

const ARMS: Record<string, Arm> = {
  plain: { durable: false, start: 'call', retry: false, fault: 'none', faults: 0, what: 'today’s code, nothing killed' },
  journal: { durable: true, start: 'call', retry: false, fault: 'none', faults: 0, what: 'the journal, nothing killed' },
  'queue-calm': { durable: true, start: 'queue', retry: false, fault: 'none', faults: 0, what: 'the journal with runs started through the queue, nothing killed' },
  rival: { durable: false, start: 'call', retry: false, fault: 'kill-agent', faults: 3, what: 'today’s code, agent killed' },
  'rival-retry': { durable: false, start: 'call', retry: true, fault: 'kill-agent', faults: 3, what: 'today’s code with the caller starting a stopped run over, agent killed' },
  recovery: { durable: true, start: 'call', retry: true, fault: 'kill-agent', faults: 3, what: 'the journal and its recovery, agent killed' },
  queue: { durable: true, start: 'queue', retry: false, fault: 'kill-agent', faults: 3, what: 'the journal with runs started through the queue, agent killed' },
  'journal-kill': { durable: true, start: 'call', retry: true, fault: 'kill-journal', faults: 1, what: 'the journal, journal killed once' },
  zombie: { durable: true, start: 'call', retry: true, fault: 'cut-agent', faults: 1, what: 'the journal, the agent’s connection cut for 1.5 s while it keeps running' },
}

const INTERVAL_MS = 400
const MIN_FAULT_GAP_MS = 3_500
const PROXY_PORT = 49736
const CUT_MS = 1_500
// A slow send lands 2.5 s after it starts, and a zombie's cut-off call ends with its 30 s timeout.
const SETTLE_MS = 4_000
const ZOMBIE_SETTLE_MS = 35_000

const [armName, countArg = '40', seedArg = '7'] = process.argv.slice(2)
const arm = ARMS[armName]
if (!arm) {
  console.error(`usage: npx tsx burst.ts <${Object.keys(ARMS).join(' | ')}> [count] [seed]`)
  process.exit(2)
}

const count = Number(countArg)
const seed = Number(seedArg)
const runDir = path.join(HERE, '.run', `burst-${armName}`)
mkdirSync(runDir, { recursive: true })
mkdirSync(path.join(HERE, 'results'), { recursive: true })

// mulberry32, so every arm gets its faults at the same moments for the same seed.
function seededRandom(start: number): () => number {
  let state = start >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fault times inside the window the burst is still sending in, at least MIN_FAULT_GAP_MS apart. */
function faultTimes(n: number): number[] {
  const random = seededRandom(seed)
  const window = count * INTERVAL_MS
  const slot = (window - 1_500) / Math.max(n, 1)
  return Array.from({ length: n }, (_, i) => Math.round(1_500 + i * slot + random() * Math.max(slot - MIN_FAULT_GAP_MS, 0)))
}

/** Kills a worker of the stack with the project's kill script, the way `npm run kill-agent` does. */
function killWorker(name: string): string {
  const out = execFileSync(process.execPath, ['--import', 'tsx', KILL_SCRIPT, name, COMPOSE_FILE], { encoding: 'utf8', env: { ...process.env, III_BIN } }).trim()
  log(out)
  return out
}

function readLines<T>(file: string): T[] {
  if (!existsSync(file)) {
    return []
  }

  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T)
}

function repeatsDropped(): number {
  const file = path.join(DATA_DIR, 'email-sends.sqlite')
  if (!existsSync(file)) {
    return 0
  }

  const db = new Database(file, { readonly: true })
  const row = db.prepare('select coalesce(sum(repeats), 0) as repeats from sends').get() as { repeats: number }
  db.close()
  return row.repeats
}

const proxy = arm.fault === 'cut-agent' ? await startProxy(PROXY_PORT, 49734) : undefined
const metricsFile = path.join(DATA_DIR, 'metrics.jsonl')
const stack = await startStack(runDir, {
  REWIND_DURABLE: arm.durable ? 'on' : 'off',
  REWIND_DURABLE_METRICS: metricsFile,
  MODEL_SEED: '412',
  ...(proxy ? { AGENT_III_URL: proxy.url } : {}),
})
const observed = await observeCalls(stack.client)

const faults: { at_ms: number; what: string }[] = []
const startedAt = Date.now()

async function injectFaults(): Promise<void> {
  for (const at of faultTimes(arm.faults)) {
    const wait = startedAt + at - Date.now()
    if (wait > 0) {
      await sleep(wait)
    }

    const what = await injectOne()
    faults.push({ at_ms: Date.now() - startedAt, what })
  }
}

const INJECT: Record<Exclude<Fault, 'none'>, () => Promise<string>> = {
  'kill-agent': async () => {
    await waitForRestart(stack.client, 'agent::run')
    return killWorker('agent')
  },
  'kill-journal': async () => {
    await waitForRestart(stack.client, 'journal::begin')
    return killWorker('journal')
  },
  'cut-agent': async () => {
    await proxy!.cut(CUT_MS)
    return `cut the agent's connection for ${CUT_MS} ms`
  },
}

function injectOne(): Promise<string> {
  if (arm.fault === 'none') {
    return Promise.resolve('nothing')
  }

  return INJECT[arm.fault]()
}

log(`--- ${armName}: ${arm.what}; ${count} runs, faults at ${JSON.stringify(faultTimes(arm.faults))} ms, seed ${seed}`)
const burst = stack.client.call<unknown, Record<string, unknown> & { runs: RunReport[] }>({
  function_id: 'traffic::burst',
  payload: { count, interval_ms: INTERVAL_MS, start: arm.start, retry: arm.retry, detail: true },
  timeoutMs: 15 * 60_000,
})
const [result] = await Promise.all([burst, injectFaults()])
const burstMs = Date.now() - startedAt
const { runs: reports, ...tally } = result
log(`burst done in ${burstMs} ms`, tally)
await sleep(arm.fault === 'cut-agent' ? ZOMBIE_SETTLE_MS : SETTLE_MS)

const journals = new Map<string, JournalDetail>()
for (const report of reports) {
  try {
    journals.set(report.workflow_id, await stack.client.call<unknown, JournalDetail>({ function_id: 'journal::get', payload: { workflow_id: report.workflow_id } }))
  } catch (error) {
    log(`journal::get ${report.workflow_id} failed`, brief(error))
    journals.set(report.workflow_id, null)
  }
}

const outbox = readLines<Send>(path.join(DATA_DIR, 'outbox.jsonl'))
const metrics = readLines<Metric>(metricsFile)
const modelCalls = readLines<{ kind: string; name: string; input?: { args?: unknown } }>(path.join(DATA_DIR, 'captures.jsonl'))
  .filter((capture) => capture.kind === 'function' && capture.name.endsWith(':answerFor'))
  .map((capture) => requestOfCapture(capture) ?? '')
const rows = reports.map((report) => countRun(report, journals.get(report.workflow_id) ?? null, observed, outbox, modelCalls))
const summary = summarize(rows, metrics, observed, repeatsDropped())
writeFileSync(path.join(runDir, 'observed.jsonl'), `${observed.map((event) => JSON.stringify(event)).join('\n')}\n`)
writeFileSync(
  path.join(HERE, 'results', `${armName}.json`),
  `${JSON.stringify({ arm: armName, what: arm.what, config: { ...arm, count, interval_ms: INTERVAL_MS, seed, engine: STACK_URL }, faults, burst_ms: burstMs, tally, summary, runs: rows }, null, 2)}\n`,
)
log('summary', summary)
proxy?.close()
await stack.stop()
process.exit(0)

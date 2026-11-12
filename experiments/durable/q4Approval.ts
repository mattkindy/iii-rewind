/**
 * The app's agent waits for approval, dies while it waits, and is approved: does each run finish
 * once and send one invite? Forty runs start agent::run with approval: true on the experiment's
 * stack (stack/worker-compose.yaml, no Rewind). The ones that reach their invite park. The agent
 * is killed with the project's kill script while they wait, compose restarts it, and every
 * parked run is approved. The agent's memory is read with ps before the runs and while they wait.
 *
 * Run from this folder after `npm install`, with the project's own stack stopped, since both use
 * the providers' port: III_BIN=~/.local/bin/iii npx tsx q4Approval.ts > results/q4Approval.txt
 * It writes the numbers to results/q4Approval.json.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { HERE, III_BIN, log, sleep } from './lib.js'
import { COMPOSE_FILE, DATA_DIR, startStack, waitForRestart } from './stack.js'

const RUNS = 40
const KILL_SCRIPT = path.resolve(HERE, '../../scripts/kill.ts')
const ATTENDEES = ['Dana', 'Priya', 'Marcus', 'Lena', 'Omar', 'Sofia']
const DURATIONS = [15, 30, 45, 60]
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

type Invite = { to: string; subject: string }
type Parked = { pending: true; workflow_id: string; waiting_for: { name: string; detail: { input: Invite } } }
type Reply = Parked | { status: string; reply: string } | { error: string }
type Detail = { status: string; output?: { status: string }; executions: unknown[]; steps: { function_id: string }[] }

const runDir = path.join(HERE, '.run', 'q4')
mkdirSync(runDir, { recursive: true })
const stack = await startStack(runDir, { REWIND_DURABLE: 'on', MODEL_SEED: '412' })
const client = stack.client

function call<T>(functionId: string, payload: unknown, timeoutMs = 60_000): Promise<T> {
  return client.call<unknown, T>({ function_id: functionId, payload, timeoutMs })
}

function agentPid(): number | undefined {
  const listing = JSON.parse(execFileSync(III_BIN, ['ps', '--json'], { encoding: 'utf8' })) as { pid: number; kind: string; name: string; compose_file: string | null; command: string }[]
  return listing.find((p) => p.kind === 'worker' && p.name === 'agent' && p.compose_file === COMPOSE_FILE && !p.command.includes('esbuild'))?.pid
}

function rssMb(pid: number | undefined): number | null {
  if (!pid) {
    return null
  }

  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024
}

function outbox(): Invite[] {
  const file = path.join(DATA_DIR, 'outbox.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Invite) : []
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

const isParked = (reply: Reply): reply is Parked => 'pending' in reply

const rssBefore = rssMb(agentPid())
const began = Date.now()
const replies = await Promise.all(
  Array.from({ length: RUNS }, (_, index) => {
    const request = `Book ${DURATIONS[index % DURATIONS.length]} minutes with ${ATTENDEES[index % ATTENDEES.length]} next ${WEEKDAYS[index % WEEKDAYS.length]} afternoon`
    return call<Reply>('agent::run', { request, approval: true, _workflow_id: `approve-${index}` }).catch((error: Error) => ({ error: error.message }))
  }),
)
const parked = replies.filter(isParked)
log(`${RUNS} runs started, ${parked.length} parked at their invite in ${Date.now() - began} ms; the rest ended first:`, replies.filter((reply) => !isParked(reply)))
await sleep(1_000)
const pid = agentPid()
const rssWaiting = rssMb(pid)
const invitesWhileWaiting = outbox().length
log(`agent pid ${pid}: ${rssBefore?.toFixed(1)} MB before, ${rssWaiting?.toFixed(1)} MB with ${parked.length} runs waiting; ${invitesWhileWaiting} invites sent so far`)

log(execFileSync(process.execPath, ['--import', 'tsx', KILL_SCRIPT, 'agent', COMPOSE_FILE], { encoding: 'utf8', env: { ...process.env, III_BIN } }).trim())
await sleep(500)
await waitForRestart(client, 'agent::run')
log(`agent back as pid ${agentPid()}`)

const resolvedAt = Date.now()
const resolutions = await Promise.all(parked.map((run) => call<{ resolved: boolean; resumed: boolean }>('journal::resolve', { workflow_id: run.workflow_id, name: 'approval', value: { approved: true } })))
const details: Detail[] = []
for (const run of parked) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const found = await call<{ status: string } | null>('journal::wait', { workflow_id: run.workflow_id, timeout_ms: 10_000 }, 15_000)
    if (found && found.status !== 'running') {
      break
    }
  }

  details.push(await call<Detail>('journal::get', { workflow_id: run.workflow_id }))
}

const allDoneMs = Date.now() - resolvedAt
// A slow send lands after its run gives up on it (bug 3), so the outbox is read a moment later.
await sleep(4_000)
const sent = outbox()
const perRun = parked.map((run, index) => {
  const invite = run.waiting_for.detail.input
  const invites = sent.filter((line) => line.to === invite.to && line.subject === invite.subject).length
  const sendSteps = details[index].steps.filter((step) => step.function_id === 'email::send').length
  return { workflow_id: run.workflow_id, status: details[index].status, booked: details[index].output?.status === 'booked', executions: details[index].executions.length, invites, send_steps: sendSteps }
})
const result = {
  runs: RUNS,
  parked: parked.length,
  rss_mb_before: rssBefore,
  rss_mb_waiting: rssWaiting,
  invites_while_waiting: invitesWhileWaiting,
  resolved: resolutions.filter((resolution) => resolution.resolved && resolution.resumed).length,
  done: perRun.filter((run) => run.status === 'done').length,
  booked: perRun.filter((run) => run.booked).length,
  executions: perRun.map((run) => run.executions),
  one_invite: perRun.filter((run) => run.invites === 1).length,
  invites_matching_send_steps: perRun.filter((run) => run.invites === run.send_steps).length,
  more_than_one_invite: perRun.filter((run) => run.invites > 1).map((run) => run.workflow_id),
  repeats_dropped: repeatsDropped(),
  all_done_ms: allDoneMs,
}
log('CHECK', result)
for (const run of perRun.filter((row) => row.invites !== 1)) {
  log('  not one invite:', run)
}

writeFileSync(path.join(HERE, 'results', 'q4Approval.json'), `${JSON.stringify({ ...result, per_run: perRun }, null, 2)}\n`)
await stack.stop()
process.exit(0)

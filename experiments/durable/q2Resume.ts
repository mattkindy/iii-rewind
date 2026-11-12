/**
 * The journal and the preload on a small durable function, before the agent: does a run killed
 * mid-step finish on the restarted worker with each step run once, a send cut off mid-call go out
 * once, a zombie get fenced, and changed code fail loudly?
 *
 * 1. calm: a run with no crash. 2. kill: the flow worker dies during the first think. 3. send:
 * it dies while the send is in flight. 4. zombie: its connection drops during a think while the
 * process keeps running. 5. changed: it dies, and comes back with code that calls something else.
 *
 * Run from this folder after `npm install` here and in workers/journal: npx tsx q2Resume.ts
 */
import path from 'node:path'
import { brief, connect, JOURNAL_WORKER, log, sleep, startProbe, startProxy, startRole, waitForFunctions, type Role } from './lib.js'

type Detail = {
  status: string
  output?: unknown
  error?: unknown
  executions: { epoch: number }[]
  attempts: { step: number; function_id: string }[]
  fenced: { epoch: number; step: number | null; write: string }[]
}

const probe = await startProbe('q2')
const journal = startRole('journal', JOURNAL_WORKER, { JOURNAL_FILE: path.join(probe.dir, 'journal.sqlite') })
const callee = startRole('callee', 'callee.ts')
const flowEnv = { REWIND_CAPTURE_FILE: path.join(probe.dir, 'captures.jsonl') }
let flow = startRole('flow', 'flow.ts', flowEnv, true)
await Promise.all([journal.waitFor(/journal ready/), callee.waitFor(/^ROLE/), flow.waitFor(/^ROLE/)])
const caller = connect('probe-caller')
await waitForFunctions(caller, ['probe::flow', 'probe::read', 'journal::begin'])

function steps(label: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const line of callee.lines) {
    const match = new RegExp(`^STEP (\\S+) ${label}( |$)`).exec(line)
    if (match) {
      counts[match[1]] = (counts[match[1]] ?? 0) + 1
    }
  }

  return counts
}

async function detail(workflowId: string): Promise<Detail> {
  return caller.call<unknown, Detail>({ function_id: 'journal::get', payload: { workflow_id: workflowId } })
}

async function waitDone(workflowId: string, timeoutMs = 30_000): Promise<Detail> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const settled = await caller.call<unknown, { status: string } | null>({ function_id: 'journal::wait', payload: { workflow_id: workflowId, timeout_ms: 5_000 }, timeoutMs: 10_000 })
    if (settled && settled.status !== 'running') {
      break
    }
  }

  return detail(workflowId)
}

function start(label: string, extra: Record<string, unknown> = {}): Promise<void> {
  return caller
    .call({ function_id: 'probe::flow', payload: { label, _workflow_id: `wf-${label}`, ...extra }, timeoutMs: 30_000 })
    .then((value) => log(`call ${label} answered`, value))
    .catch((error) => log(`call ${label} failed`, brief(error)))
}

async function report(label: string, waited = true): Promise<void> {
  const found = waited ? await waitDone(`wf-${label}`) : await detail(`wf-${label}`)
  log(`CHECK ${label}: ${found.status}, ${found.executions.length} executions, ${found.attempts.length} attempts, ${found.fenced.length} fenced writes; the callee ran`, steps(label))
  log(`  ${label} output`, found.output ?? found.error ?? null)
  if (found.fenced.length > 0) {
    log(`  ${label} fenced`, found.fenced)
  }
}

async function restartFlow(env: Record<string, string> = flowEnv): Promise<Role> {
  flow = startRole('flow', 'flow.ts', env, true)
  await flow.waitFor(/^ROLE/)
  return flow
}

log('--- 1. calm')
await start('calm')
await report('calm')

log('--- 2. kill during the first think')
const killed = start('kill', { think_ms: 2_000 })
await callee.waitFor(/^STEP think kill/)
await sleep(500)
flow.kill('SIGKILL')
await killed
await sleep(1_000)
await restartFlow()
await report('kill')

log('--- 3. kill while the send is in flight')
const sending = start('send', { send_ms: 2_000 })
await callee.waitFor(/^STEP send send/)
await sleep(300)
flow.kill('SIGKILL')
await sending
await sleep(1_000)
await restartFlow()
await report('send')

log('--- 4. zombie: the connection drops during a think, the process keeps running')
flow.kill('SIGKILL')
const proxy = await startProxy(49736, 49738)
await restartFlow({ ...flowEnv, III_URL: proxy.url })
await waitForFunctions(caller, ['probe::flow'])
const zombie = start('zombie', { think_ms: 3_000 })
await callee.waitFor(/^STEP think zombie/)
await proxy.cut(1_500)
await zombie
// The zombie's think never gets its answer, so it goes on when its 30 s call timeout ends.
await waitDone('wf-zombie')
for (let waited = 0; waited < 40_000 && (await detail('wf-zombie')).fenced.length === 0; waited += 500) {
  await sleep(500)
}
await report('zombie')
log('flow lines', flow.lines.filter((line) => /zombie|FENCED|rewind preload/.test(line)))

log('--- 5. changed code: the flow dies, and comes back calling something else')
proxy.close()
flow.kill('SIGKILL')
await restartFlow()
await waitForFunctions(caller, ['probe::flow'])
const changing = start('changed', { think_ms: 2_000 })
await callee.waitFor(/^STEP think changed/)
flow.kill('SIGKILL')
await changing
await restartFlow({ ...flowEnv, FLOW_CHANGED: '1' })
await report('changed')
log('journal lines', journal.lines.filter((line) => /changed/.test(line)))

await caller.shutdown()
for (const role of [flow, callee, journal]) {
  await role.stop('SIGKILL')
}

await probe.engine.stop()
process.exit(0)

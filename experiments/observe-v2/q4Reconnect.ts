/**
 * Question (d): what happens to Rewind's observers when the observed worker disconnects and
 * reconnects, and when Rewind itself does? The probe engine's grace period is 3 s.
 *
 * 1. The owner of probe::slow is killed and restarted under the same name, once after 1 s and
 *    once after 6 s. 2. The recorder's own connection goes through a proxy that cuts it off for
 *    1 s, then for 6 s. 3. The owner's connection goes through a proxy that drops it in the
 *    middle of a call. After each, a call checks that the recorder still gets events.
 *
 * Run from this folder after `npm install`: npx tsx q4Reconnect.ts
 */
import { brief, connect, finish, log, observerRows, sleep, startEngine, startProxy, startRole, waitForFunctions } from './lib.js'

const engine = await startEngine('q4')
let owner = startRole('owner', 'owner.ts', { ROLE_NAME: 'probe-owner' })
await owner.waitFor(/^ROLE/)

const recorderProxy = await startProxy(49835)
const recorder = connect('probe-recorder-d', recorderProxy.url)
const seen: string[] = []
recorder.registerFunction('probe::record-d', async (observed: { input?: { label?: string }; status: string }) => {
  seen.push(observed.input?.label ?? '?')
  log(`EVENT recorder got ${observed.input?.label} (${observed.status})`)
  return null
})

const caller = connect('probe-caller-d')
await waitForFunctions(caller, ['probe::slow', 'probe::record-d'])
const handle = recorder.observe(
  { function_id: 'probe::slow', capture: ['input', 'output', 'error', 'caller', 'metadata'] },
  'probe::record-d',
)
handle.onStateChange((state, reason) => log(`STATE recorder's handle ${handle.id.slice(0, 8)}: ${state}`, reason ?? ''))
await handle.ready()

async function callAndCheck(label: string): Promise<void> {
  await caller
    .call({ function_id: 'probe::slow', payload: { hold_ms: 0, label }, timeoutMs: 10_000 })
    .catch((error) => log(`call ${label} failed`, brief(error)))
  await sleep(500)
  log(`CHECK ${label}: recorder got it ${seen.includes(label)}; handle ${handle.state}`, await observerRows(caller, 'probe::slow'))
}

async function restartOwnerAfter(ms: number): Promise<void> {
  owner.kill('SIGKILL')
  await sleep(ms)
  log(`rows while the owner is away for ${ms} ms`, await observerRows(caller, 'probe::slow'))
  owner = startRole('owner', 'owner.ts', { ROLE_NAME: 'probe-owner' })
  await owner.waitFor(/^ROLE/)
  await waitForFunctions(caller, ['probe::slow'])
  await sleep(300)
}

/** The engine's view, since the recorder's own handle can say active while the engine says suspended. */
async function waitEngineActive(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await observerRows(caller, 'probe::slow')
    if (rows.some((row) => row.state === 'active')) {
      log(`the engine has the recorder's observer active again; the recorder's handle says ${handle.state}`)
      return
    }

    await sleep(100)
  }
}

/** Cuts the recorder off for `ms`, makes a call while it is away, then checks what reached it. */
async function cutRecorder(ms: number): Promise<void> {
  const cut = recorderProxy.cut(ms)
  await sleep(200)
  const during = `during-recorder-cut-${ms}`
  await caller.call({ function_id: 'probe::slow', payload: { hold_ms: 0, label: during } }).catch((error) => log('call failed', brief(error)))
  log(`while the recorder is away the recorder's handle says ${handle.state}`, await observerRows(caller, 'probe::slow'))
  await cut
  await waitEngineActive(30_000)
  await sleep(1000)
  log(`CHECK ${during}: the recorder got it after reattaching ${seen.includes(during)}`)
  await callAndCheck(`recorder-back-${ms}`)
}

await callAndCheck('before')

log('--- 1. the owner is killed and back after 1 s, then after 6 s')
await restartOwnerAfter(1000)
await callAndCheck('owner-back-1s')
await restartOwnerAfter(6000)
await callAndCheck('owner-back-6s')

log('--- 2. the recorder is cut off for 1 s, then for 6 s')
await cutRecorder(1000)
await cutRecorder(6000)

log('--- 3. the owner connection drops in the middle of a call')
owner.kill('SIGKILL')
const ownerProxy = await startProxy(49836)
owner = startRole('owner', 'owner.ts', { ROLE_NAME: 'probe-owner', III_URL: ownerProxy.url })
await owner.waitFor(/^ROLE/)
await waitForFunctions(caller, ['probe::slow'])
await sleep(300)
const inFlight = caller
  .call({ function_id: 'probe::slow', payload: { hold_ms: 3000, label: 'in-flight' }, timeoutMs: 20_000 })
  .then((value) => log('in-flight call RESULT', value))
  .catch((error) => log('in-flight call ERROR', brief(error)))
await owner.waitFor(/HANDLER start in-flight/)
await ownerProxy.cut(500)
await inFlight
await owner.waitFor(/HANDLER end in-flight/, 10_000).catch(() => log('the handler never finished'))
await sleep(3000)
log(`CHECK in-flight: recorder got it ${seen.includes('in-flight')}`, await observerRows(caller, 'probe::slow'))
await callAndCheck('after-owner-blip')

recorderProxy.close()
ownerProxy.close()
await finish(engine, [caller, recorder])

/**
 * The worker that hosts `probe::slow`, run as its own process so a probe can kill it. The
 * handler waits `hold_ms`, then returns which process ran it. ROLE_NAME is the worker name, so a
 * restarted owner comes back under the same name. OWNER_SDK=0.25 runs it on the 0.25 SDK,
 * which the engine treats as a host without observe.v2.
 */
import { setTimeout as sleep } from 'node:timers/promises'

const { registerWorker } = (await import(process.env.OWNER_SDK === '0.25' ? 'iii-sdk-025' : 'iii-sdk')) as typeof import('iii-sdk')
const name = process.env.ROLE_NAME ?? 'probe-owner'
const iii = registerWorker(process.env.III_URL ?? 'ws://127.0.0.1:49834', { workerName: name, otel: { enabled: false } })

iii.registerFunction(
  'probe::slow',
  async (input: { hold_ms?: number; label?: string }) => {
    const invocation = iii.currentInvocation()?.invocation_id
    console.log(`HANDLER start ${input.label ?? ''} inv ${invocation} at ${Date.now()}`)
    await sleep(input.hold_ms ?? 0)
    console.log(`HANDLER end ${input.label ?? ''} inv ${invocation} at ${Date.now()}`)
    return { answered_by: name, pid: process.pid, label: input.label }
  },
  { description: 'Waits hold_ms, then returns' },
)

console.log(`ROLE ${name} up, pid ${process.pid}`)

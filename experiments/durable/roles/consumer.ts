/**
 * The worker the queue delivers jobs to, run as its own process so a probe can kill it.
 *
 * probe::job waits `hold_ms` and returns. probe::fail always throws, so the probe can count the
 * queue's retries. Each handler prints one HANDLER line when it starts and one when it ends, with
 * the payload and metadata it got, so the probe can see what a job keeps across a redelivery.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { registerWorker } from 'iii-sdk'

const name = process.env.ROLE_NAME ?? 'probe-consumer'
const iii = registerWorker(process.env.III_URL ?? 'ws://127.0.0.1:49738', { workerName: name, otel: { enabled: false } })

type Job = { label: string; hold_ms?: number; workflow_id?: string }

function line(event: string, job: Job, metadata: unknown): string {
  const invocation = iii.currentInvocation()
  return `HANDLER ${event} ${job.label} at ${Date.now()} ${JSON.stringify({ payload: job, metadata: metadata ?? null, invocation_id: invocation?.invocation_id, caller: invocation?.caller ?? null })}`
}

iii.registerFunction(
  'probe::job',
  async (job: Job, metadata?: unknown) => {
    console.log(line('start', job, metadata))
    await sleep(job.hold_ms ?? 0)
    console.log(line('end', job, metadata))
    return { done: job.label, pid: process.pid }
  },
  { description: 'Waits hold_ms, then returns' },
)

iii.registerFunction(
  'probe::fail',
  async (job: Job, metadata?: unknown) => {
    console.log(line('start', job, metadata))
    throw new Error(`probe::fail refused ${job.label}`)
  },
  { description: 'Always throws' },
)

console.log(`ROLE ${name} up, pid ${process.pid}`)

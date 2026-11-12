/**
 * The plain way to pause, for the pause probe's rival: the handler awaits a promise until the
 * value arrives, with no journal. probe::rival-approve does what probe::approve does, and
 * probe::rival-resolve settles the promise a run is awaiting, or reports that no run is. A value
 * that arrives before the run awaits it finds nobody and is dropped. probe::rival-nap sleeps
 * with a timer. probe::rival-stats reports memory and running handlers, like probe::stats.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { registerWorker } from 'iii-sdk'

const name = process.env.ROLE_NAME ?? 'probe-rival'
const iii = registerWorker(process.env.III_URL ?? 'ws://127.0.0.1:49738', { workerName: name, otel: { enabled: false } })

let running = 0
const awaiting = new Map<string, (value: unknown) => void>()

type Decision = { timed_out: true } | { timed_out: false; value: { approved?: boolean } | null }

function waitFor(label: string, timeoutMs?: number): Promise<Decision> {
  return new Promise((resolve) => {
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      awaiting.delete(label)
      resolve({ timed_out: true })
    }, timeoutMs)
    awaiting.set(label, (value) => {
      clearTimeout(timer)
      awaiting.delete(label)
      resolve({ timed_out: false, value: value as { approved?: boolean } })
    })
  })
}

iii.registerFunction(
  'probe::rival-approve',
  async (input: { label: string; timeout_ms?: number; think_ms?: number }) => {
    running += 1
    try {
      const read = await iii.call<unknown, { value: number }>({ function_id: 'probe::read', payload: { label: input.label } })
      const thought = await iii.call<unknown, { idea: string }>({ function_id: 'probe::think', payload: { label: input.label, read: read.value, hold_ms: input.think_ms ?? 50 } })
      const decision = await waitFor(input.label, input.timeout_ms)
      if (decision.timed_out || decision.value?.approved !== true) {
        return { label: input.label, sent: null, decision }
      }

      const sent = await iii.call<unknown, { id: string }>({ function_id: 'probe::send', payload: { label: input.label, idea: thought.idea } })
      console.log(`HANDLER ${input.label} sent ${sent.id}`)
      return { label: input.label, sent: sent.id, decision }
    } finally {
      running -= 1
    }
  },
  { description: 'Reads, thinks, awaits approval in memory and sends', metadata: { effects: ['writes'] } },
)

iii.registerFunction(
  'probe::rival-resolve',
  async (input: { label: string; value: unknown }) => {
    const settle = awaiting.get(input.label)
    settle?.(input.value)
    return { resolved: settle !== undefined }
  },
  { description: 'Settles the promise a run is awaiting, if one is' },
)

iii.registerFunction(
  'probe::rival-nap',
  async (input: { label: string; ms: number }) => {
    running += 1
    const began = Date.now()
    try {
      await sleep(input.ms)
      return { label: input.label, slept_ms: Date.now() - began }
    } finally {
      running -= 1
    }
  },
  { description: 'Sleeps for ms with a timer' },
)

iii.registerFunction(
  'probe::rival-stats',
  async () => {
    globalThis.gc?.()
    const { rss, heapUsed } = process.memoryUsage()
    return { rss, heap_used: heapUsed, running, awaiting: awaiting.size }
  },
  { description: "This process's memory after a GC, and how many handlers are running" },
)

console.log(`ROLE ${name} up, pid ${process.pid}`)

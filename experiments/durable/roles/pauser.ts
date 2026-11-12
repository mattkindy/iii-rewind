/**
 * Durable functions that pause, for the pause probe, run with Rewind's Node preload.
 * probe::approve reads, thinks, waits for a value named approval and sends when it is approved,
 * the way agent::run does with `approval: true`. probe::nap reads, sleeps and reads again.
 * probe::stats reports this process's memory and how many handlers are running, which is what a
 * parked run should leave at zero. Start it with --expose-gc so the memory is read after a GC.
 */
import { registerWorker } from 'iii-sdk'

const name = process.env.ROLE_NAME ?? 'probe-pauser'
const iii = registerWorker(process.env.III_URL ?? 'ws://127.0.0.1:49738', { workerName: name, otel: { enabled: false } })

let running = 0

function counted<I, O>(handler: (input: I) => Promise<O>): (input: I) => Promise<O> {
  return async (input) => {
    running += 1
    try {
      return await handler(input)
    } finally {
      running -= 1
    }
  }
}

type Approve = { label: string; timeout_ms?: number; think_ms?: number }
type Decision = { timed_out: true } | { timed_out: false; value: { approved?: boolean } | null }

iii.registerFunction(
  'probe::approve',
  counted(async (input: Approve) => {
    const read = await iii.call<unknown, { value: number }>({ function_id: 'probe::read', payload: { label: input.label } })
    const thought = await iii.call<unknown, { idea: string }>({ function_id: 'probe::think', payload: { label: input.label, read: read.value, hold_ms: input.think_ms ?? 50 } })
    const decision = await iii.call<unknown, Decision>({ function_id: 'durable::wait', payload: { name: 'approval', ...(input.timeout_ms === undefined ? {} : { timeout_ms: input.timeout_ms }) } })
    if (decision.timed_out || decision.value?.approved !== true) {
      console.log(`HANDLER ${input.label} not approved ${JSON.stringify(decision)}`)
      return { label: input.label, sent: null, decision }
    }

    const sent = await iii.call<unknown, { id: string }>({ function_id: 'probe::send', payload: { label: input.label, idea: thought.idea } })
    console.log(`HANDLER ${input.label} sent ${sent.id}`)
    return { label: input.label, sent: sent.id, decision }
  }),
  { description: 'Reads, thinks, waits for approval and sends', metadata: { effects: ['writes'], durable: true } },
)

iii.registerFunction(
  'probe::nap',
  counted(async (input: { label: string; ms: number }) => {
    await iii.call({ function_id: 'probe::read', payload: { label: input.label } })
    const slept = await iii.call<unknown, { slept_ms: number }>({ function_id: 'durable::sleep', payload: { ms: input.ms } })
    await iii.call({ function_id: 'probe::read', payload: { label: `${input.label}-after` } })
    console.log(`HANDLER ${input.label} woke after ${slept.slept_ms} ms`)
    return { label: input.label, ...slept }
  }),
  { description: 'Reads, sleeps for ms and reads again', metadata: { effects: ['writes'], durable: true } },
)

iii.registerFunction(
  'probe::stats',
  async () => {
    globalThis.gc?.()
    const { rss, heapUsed } = process.memoryUsage()
    return { rss, heap_used: heapUsed, running }
  },
  { description: "This process's memory after a GC, and how many handlers are running" },
)

console.log(`ROLE ${name} up, pid ${process.pid}`)

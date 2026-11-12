/**
 * The functions probe::flow calls, with the effects the agent's callees declare: probe::read is
 * read-only like clock::now, probe::think is external like model::complete, and probe::send is
 * irreversible and drops a repeat idempotency key like email::send. Each prints one STEP line
 * per execution, so a probe can count how many times each ran.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { registerWorker } from 'iii-sdk'

const iii = registerWorker(process.env.III_URL ?? 'ws://127.0.0.1:49738', { workerName: 'probe-callee', otel: { enabled: false } })

type Labeled = { label: string; hold_ms?: number }

const sends = new Map<string, { id: string }>()
let counter = 0

iii.registerFunction(
  'probe::read',
  async (input: Labeled) => {
    console.log(`STEP read ${input.label}`)
    return { value: input.label.length }
  },
  { description: 'Reads a number', metadata: { effects: ['read-only'] } },
)

iii.registerFunction(
  'probe::think',
  async (input: Labeled & { read: unknown }) => {
    console.log(`STEP think ${input.label}`)
    await sleep(input.hold_ms ?? 300)
    return { idea: `${input.label}-${String(input.read)}` }
  },
  { description: 'Thinks for hold_ms', metadata: { effects: ['external'] } },
)

iii.registerFunction(
  'probe::send',
  async (input: Labeled, metadata?: unknown) => {
    const key = (metadata as { idempotency_key?: string } | null | undefined)?.idempotency_key
    const seen = key ? sends.get(key) : undefined
    if (seen) {
      console.log(`STEP send-repeat ${input.label} key ${key}`)
      return seen
    }

    counter += 1
    const sent = { id: `msg-${counter}` }
    if (key) {
      sends.set(key, sent)
    }

    console.log(`STEP send ${input.label} key ${key ?? 'none'}`)
    await sleep(input.hold_ms ?? 0)
    return sent
  },
  { description: 'Sends once per idempotency key', metadata: { effects: ['irreversible'], idempotency_key: true } },
)

console.log(`ROLE probe-callee up, pid ${process.pid}`)

/**
 * A durable function for the probes, run with Rewind's Node preload. probe::flow reads, thinks,
 * sends, thinks again and returns, each a call to the callee role, the way agent::run calls
 * clock::now, model::complete and email::send. Each call is a step in the journal.
 * FLOW_CHANGED=1 makes the first read ask for something else, the way edited code would.
 */
import { registerWorker } from 'iii-sdk'

const name = process.env.ROLE_NAME ?? 'probe-flow'
const iii = registerWorker(process.env.III_URL ?? 'ws://127.0.0.1:49738', { workerName: name, otel: { enabled: false } })
const changed = process.env.FLOW_CHANGED === '1'

type Flow = { label: string; think_ms?: number; send_ms?: number }

iii.registerFunction(
  'probe::flow',
  async (input: Flow) => {
    console.log(`HANDLER start ${input.label} inv ${iii.currentInvocation()?.invocation_id}`)
    const read = await iii.call<unknown, { value: number }>({ function_id: 'probe::read', payload: { label: input.label, changed } })
    const thought = await iii.call<unknown, { idea: string }>({ function_id: 'probe::think', payload: { label: input.label, read: read.value, hold_ms: input.think_ms ?? 300 } })
    const sent = await iii.call<unknown, { id: string }>({ function_id: 'probe::send', payload: { label: input.label, idea: thought.idea, hold_ms: input.send_ms ?? 0 } })
    const again = await iii.call<unknown, { idea: string }>({ function_id: 'probe::think', payload: { label: input.label, read: sent.id, hold_ms: input.think_ms ?? 300 } })
    console.log(`HANDLER end ${input.label}`)
    return { label: input.label, sent: sent.id, idea: again.idea }
  },
  { description: 'Reads, thinks, sends and thinks again', metadata: { effects: ['writes'], durable: true } },
)

console.log(`ROLE ${name} up, pid ${process.pid}`)

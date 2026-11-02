/**
 * The probe worker for the two-engine experiment. probe::echo returns its input
 * at once, so the time a caller measures is the cost of routing the call and
 * nothing else. It declares no effects, so neither Rewind records it.
 *
 * Run: III_URL=ws://127.0.0.1:50134 node --import tsx src/worker.ts
 */
import { registerWorker } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:50134'

const worker = registerWorker(ENGINE_URL, { workerName: 'probe' })

worker.registerFunction('probe::echo', async (input: unknown) => ({ echoed: input, at_ms: Date.now() }), {
  description: 'Returns its input at once, for timing a call',
})

console.log(`probe ready on ${ENGINE_URL}`)

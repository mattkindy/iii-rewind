/**
 * Calls one function on the Rewind engine and prints its result as JSON.
 *
 * Run from the repo root, after `npm --prefix scripts install`:
 *   npx tsx scripts/trigger.ts traffic::burst '{"count":20}'
 *
 * The engine address comes from III_URL (default ws://127.0.0.1:49334).
 * TIMEOUT_MS sets how long to wait, 120 s by default, because a burst of 60
 * runs takes longer than the SDK's own 30 s.
 */
import { registerWorker } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49334'
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 120_000)

const [functionId, payloadText = '{}'] = process.argv.slice(2)
if (!functionId) {
  console.error("usage: npx tsx scripts/trigger.ts <function_id> ['<json payload>']")
  process.exit(2)
}

const payload = JSON.parse(payloadText)
const worker = registerWorker(ENGINE_URL, { workerName: 'trigger-cli' })

async function main(): Promise<number> {
  try {
    const result = await worker.call({ function_id: functionId, payload, timeoutMs: TIMEOUT_MS })
    console.log(JSON.stringify(result, null, 2))
    return 0
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string }
    console.error(JSON.stringify({ code, message }, null, 2))
    return 1
  } finally {
    await worker.shutdown()
  }
}

process.exit(await main())

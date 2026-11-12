/**
 * One lane of the app the bench records. A lane is two processes: `run <n>` owns
 * scale::run-<n>, which calls scale::echo-<n> `fanout` times one after another, the
 * way the agent calls its tools, and `echo <n>` owns scale::echo-<n>, which returns
 * its input. The two run in separate processes so every call goes through the engine.
 * Both declare `pure`, so Rewind records them.
 *
 * Run: III_URL=ws://127.0.0.1:49534 npx tsx src/lane.ts echo 0
 *      III_URL=ws://127.0.0.1:49534 npx tsx src/lane.ts run 0
 */
import { registerWorker } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49534'
const [role, lane] = process.argv.slice(2)

type RunInput = { fanout?: number; pad?: string }
type RunOutput = { calls: number; failed: number }

const PURE = { metadata: { effects: ['pure'] } }

function startEcho(name: string): void {
  const worker = registerWorker(ENGINE_URL, { workerName: name })
  worker.registerFunction(`scale::echo-${lane}`, async (input: unknown) => ({ echoed: input }), PURE)
}

function startRun(name: string): void {
  const worker = registerWorker(ENGINE_URL, { workerName: name })
  async function run(input: RunInput): Promise<RunOutput> {
    const fanout = input.fanout ?? 9
    let calls = 0
    let failed = 0
    for (let step = 0; step < fanout; step++) {
      try {
        await worker.call({ function_id: `scale::echo-${lane}`, payload: { step, pad: input.pad ?? '' }, timeoutMs: 60_000 })
        calls += 1
      } catch {
        failed += 1
      }
    }

    return { calls, failed }
  }

  worker.registerFunction(`scale::run-${lane}`, run, PURE)
}

const ROLES: Record<string, (name: string) => void> = { echo: startEcho, run: startRun }

const start = ROLES[role ?? '']
if (start === undefined || lane === undefined) {
  console.error('usage: lane.ts echo|run <lane number>')
  process.exit(2)
}

start(`scale-${role}-${lane}`)
console.log(`scale ${role} ${lane} ready on ${ENGINE_URL}`)

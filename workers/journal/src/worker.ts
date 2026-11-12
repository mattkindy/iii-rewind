/**
 * The journal for durable runs. Rewind's Node preload writes to it from inside a function that
 * opts in with `durable: true` in its metadata: once when the run starts, before and after each
 * call the run makes, and once when it ends. After a crash the run starts again, and for every
 * call that already finished the preload returns the saved result instead of sending the call.
 *
 * The journal owns its data, in one SQLite file. At scale this is the transactional store behind
 * Rewind's store workers. Its functions declare no effects and are internal, so Rewind does not
 * record them. Every write comes back as `{ rejected, message }` instead of an error when the
 * journal refuses it, because the SDK turns a thrown error into `invocation_failed`.
 *
 * Run: III_URL=ws://127.0.0.1:49334 node --import tsx src/worker.ts
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { registerWorker } from 'iii-sdk'
import { callees } from './callees.js'
import { startRecovery } from './recovery.js'
import { type Begin, Journal, type Outcome, type Status } from './store.js'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49334'
const PROJECT_DIR = process.env.III_COMPOSE_DIR ?? path.resolve(process.cwd(), '..', '..')
const JOURNAL_FILE = process.env.JOURNAL_FILE ?? path.join(PROJECT_DIR, 'data', 'journal.sqlite')
const MAX_WAIT_MS = 60_000

mkdirSync(path.dirname(JOURNAL_FILE), { recursive: true })
const journal = new Journal(JOURNAL_FILE)
const worker = registerWorker(ENGINE_URL, { workerName: 'journal' })
const functions = callees(worker)

function log(line: string): void {
  console.log(`journal: ${line}`)
}

// journal::wait callers, woken when their workflow finishes or pauses.
const waiters = new Map<string, Set<() => void>>()

function wake(workflowId: string): void {
  for (const resolve of waiters.get(workflowId) ?? []) {
    resolve()
  }

  waiters.delete(workflowId)
}

function settled(status: Status | undefined): boolean {
  return status !== undefined && status !== 'running'
}

type Epoch = { workflow_id: string; epoch: number }

/** The worker and invocation the journal's caller runs in, which is the durable run itself. */
function caller(): { worker_id: string | null; invocation_id: string | null } {
  const invocation = worker.currentInvocation()?.caller as { worker_id?: string; invocation_id?: string } | undefined
  return { worker_id: invocation?.worker_id ?? null, invocation_id: invocation?.invocation_id ?? null }
}

const INTERNAL = { metadata: { internal: true } }

worker.registerFunction(
  'journal::begin',
  async (input: Omit<Begin, 'worker_id' | 'invocation_id'>) => {
    const claim = journal.begin({ ...input, ...caller() })
    if ('status' in claim && claim.status === 'paused') {
      log(`${input.workflow_id} paused at step ${claim.pause.step} (${claim.pause.function_id}), which was in flight and may have done its work`)
      wake(input.workflow_id)
    }

    return claim
  },
  { description: 'Starts a durable run, or starts it again under the next epoch', ...INTERNAL },
)

worker.registerFunction(
  'journal::intent',
  async (input: Epoch & { step: number; function_id: string; input_hash: string }) =>
    journal.intent(input.workflow_id, input.epoch, input.step, input.function_id, input.input_hash, await functions.of(input.function_id)),
  { description: "Writes a step's intent before its call goes out", ...INTERNAL },
)

worker.registerFunction(
  'journal::result',
  async (input: Epoch & { step: number; outcome: Outcome }) => journal.result(input.workflow_id, input.epoch, input.step, input.outcome),
  { description: "Writes a step's outcome before the run sees it", ...INTERNAL },
)

worker.registerFunction(
  'journal::finish',
  async (input: Epoch & { outcome: Outcome }) => {
    const saved = journal.finish(input.workflow_id, input.epoch, input.outcome)
    wake(input.workflow_id)
    return saved
  },
  { description: 'Ends a durable run with what it returned or threw', ...INTERNAL },
)

worker.registerFunction(
  'journal::answer',
  async (input: { workflow_id: string; step: number; again?: boolean; outcome?: Outcome }) =>
    journal.answer(input.workflow_id, input.step, input.outcome ? { outcome: input.outcome } : { again: true }),
  { description: 'Answers a paused run: send the lost step again, or take the outcome given for it', ...INTERNAL },
)

worker.registerFunction(
  'journal::wait',
  async (input: { workflow_id: string; timeout_ms?: number }) => {
    const current = journal.get(input.workflow_id)
    if (!current || settled(current.status)) {
      return current ?? null
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(input.timeout_ms ?? MAX_WAIT_MS, MAX_WAIT_MS))
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      waiters.set(input.workflow_id, (waiters.get(input.workflow_id) ?? new Set()).add(done))
    })
    return journal.get(input.workflow_id) ?? null
  },
  { description: 'Waits until a durable run finishes, fails or pauses, for at most timeout_ms', ...INTERNAL },
)

worker.registerFunction('journal::get', async (input: { workflow_id: string }) => journal.detail(input.workflow_id) ?? null, {
  description: "A durable run with its steps, its executions, every attempt at each step, and the writes it fenced",
  ...INTERNAL,
})

worker.registerFunction('journal::list', async (input: { status?: Status }) => journal.list(input.status), {
  description: 'Durable runs, oldest first, optionally only those with one status',
  ...INTERNAL,
})

startRecovery(worker, journal, log)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    journal.close()
    process.exit(0)
  })
}

console.log(`journal ready on ${ENGINE_URL}, writing ${JOURNAL_FILE}`)

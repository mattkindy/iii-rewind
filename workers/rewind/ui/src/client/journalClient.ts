/**
 * Typed calls to the journal's functions, for durable runs that wait on a pending step. The
 * journal is a worker of its own, beside Rewind, so the page calls it directly. A stack without
 * the journal has no waiting runs, and the page leaves them out.
 */
import type { ExtensionIii } from '@iii-dev/console-ui'

const READ_TIMEOUT_MS = 10_000

/** A wait waits for a value sent to its name, a sleep for its wake time, and a lost step for a person. */
export type PendingKind = 'wait' | 'sleep' | 'lost'

export type Choice = { label: string; value: unknown }

export type Pending = {
  step: number
  function_id: string
  kind: PendingKind
  since_ms: number
  name?: string
  timeout_at_ms?: number
  wake_at_ms?: number
  detail?: unknown
  choices?: Choice[]
}

export type WaitingRun = {
  workflow_id: string
  function_id: string
  input: unknown
  status: 'waiting'
  created_at_ms: number
  pending: Pending
}

export type JournalStatus = 'running' | 'waiting' | 'done' | 'failed'

/** A durable run as the journal has it once it stops running. */
export type Settled = { workflow_id: string; status: JournalStatus; output?: unknown; error?: { code?: string; message: string }; pending?: Pending }

export type ResolveRequest = { workflow_id: string; step: number; action?: 'deliver' | 'execute'; value?: unknown }

export type Resolution = { resolved: boolean; resumed: boolean; step?: number; reason?: string }

export type JournalClient = ReturnType<typeof createJournalClient>

export function createJournalClient(iii: ExtensionIii) {
  return {
    waiting: () => iii.call<WaitingRun[]>('journal::list', { status: 'waiting' }, { timeoutMs: READ_TIMEOUT_MS }),
    resolve: (request: ResolveRequest) => iii.call<Resolution>('journal::resolve', { ...request }, { timeoutMs: READ_TIMEOUT_MS }),
    /** The run once it finishes, fails or waits again, or as it is after `timeoutMs`. */
    settled: (workflow_id: string, timeoutMs: number) =>
      iii.call<Settled | null>('journal::wait', { workflow_id, timeout_ms: timeoutMs }, { timeoutMs: timeoutMs + READ_TIMEOUT_MS }),
  }
}

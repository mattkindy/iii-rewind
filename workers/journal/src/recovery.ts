/**
 * Starts interrupted workflows again on whichever worker hosts their function now.
 *
 * When a worker disconnects, the engine stops every call it was running, so the journal forgets
 * it as the owner of its workflows at once, even if the same process reconnects a moment later
 * and keeps running the old handlers. A sweep every SWEEP_MS, and one after each disconnect,
 * calls the function again with the workflow's id for each running workflow that has no owner,
 * an owner that is gone, or no write for JOURNAL_STALE_MS. The sweep also catches workers that
 * left while the journal itself was down.
 *
 * A workflow the queue started is the queue's to deliver again, so the sweep waits QUEUE_GRACE_MS
 * after its last write before taking it over, for a job the queue gave up on.
 */
import type { IIIClient } from 'iii-sdk'
import type { Journal, Workflow } from './store.js'

const SWEEP_MS = 1_000
const STALE_MS = Number(process.env.JOURNAL_STALE_MS ?? 300_000)
const QUEUE_GRACE_MS = 30_000
// A run started again can take as long as the run itself.
const RERUN_TIMEOUT_MS = 10 * 60_000
const WAIT_FOR_FUNCTION_MS = 60_000

type WorkerRow = { id: string }
type FunctionRow = { function_id: string; namespace?: string }
type WorkersChanged = { input?: { event?: string; worker_id?: string } }

export const WORKFLOW_FIELD = '_workflow_id'

async function hosted(iii: IIIClient, functionId: string): Promise<boolean> {
  const { functions } = await iii.call<unknown, { functions: FunctionRow[] }>({
    function_id: 'engine::functions::list',
    payload: { include_internal: true },
    timeoutMs: 10_000,
  })
  return functions.some((row) => row.function_id === functionId && (row.namespace ?? 'default') === 'default')
}

async function liveWorkers(iii: IIIClient): Promise<Set<string>> {
  const { workers } = await iii.call<unknown, { workers: WorkerRow[] }>({ function_id: 'engine::workers::list', payload: {}, timeoutMs: 10_000 })
  return new Set(workers.map((row) => row.id))
}

function due(workflow: Workflow, now: number): boolean {
  return workflow.started_by !== 'queue' || now - workflow.updated_at_ms > QUEUE_GRACE_MS
}

export function startRecovery(iii: IIIClient, journal: Journal, log: (line: string) => void) {
  const rerunning = new Set<string>()
  let sweeping = false

  async function rerun(workflow: Workflow, why: string): Promise<void> {
    rerunning.add(workflow.workflow_id)
    try {
      const deadline = Date.now() + WAIT_FOR_FUNCTION_MS
      while (!(await hosted(iii, workflow.function_id))) {
        if (Date.now() > deadline) {
          return
        }

        await new Promise((resolve) => setTimeout(resolve, 200))
      }

      log(`starting ${workflow.workflow_id} again ${why} (epoch ${workflow.epoch} was its last)`)
      const payload = { ...(workflow.input as object), [WORKFLOW_FIELD]: workflow.workflow_id }
      await iii.call({ function_id: workflow.function_id, payload, timeoutMs: RERUN_TIMEOUT_MS })
    } catch (error) {
      // The run's own failure is in the journal already; a stop means the next sweep tries again.
      log(`${workflow.workflow_id} ended without finishing: ${(error as Error).message}`)
    } finally {
      rerunning.delete(workflow.workflow_id)
    }
  }

  async function sweep(): Promise<void> {
    if (sweeping) {
      return
    }

    sweeping = true
    try {
      const live = await liveWorkers(iii)
      const now = Date.now()
      for (const workflow of journal.orphans(live, STALE_MS)) {
        if (due(workflow, now) && !rerunning.has(workflow.workflow_id)) {
          void rerun(workflow, 'after its worker left')
        }
      }
    } catch (error) {
      log(`sweep failed: ${(error as Error).message}`)
    } finally {
      sweeping = false
    }
  }

  iii.registerFunction(
    'journal::on-workers-changed',
    async (envelope: WorkersChanged) => {
      const { event, worker_id: workerId } = envelope.input ?? {}
      if (event === 'worker_disconnected' && workerId) {
        const released = journal.release(workerId)
        if (released.length > 0) {
          log(`worker ${workerId.slice(0, 8)} left with ${released.length} running workflows`)
          void sweep()
        }
      }

      return null
    },
    { description: 'Forgets the owner of the workflows a disconnected worker was running', metadata: { internal: true } },
  )
  iii.observe({ function_id: 'engine::on-workers-changed', capture: ['input'] }, 'journal::on-workers-changed')
  setInterval(() => void sweep(), SWEEP_MS)

  return {
    /** Starts a workflow whose pending step was resolved at once, since the queue won't deliver a run that parked and returned. */
    resume(workflowId: string): void {
      const workflow = journal.get(workflowId)
      if (workflow?.status === 'running' && !rerunning.has(workflowId)) {
        void rerun(workflow, 'now that its pending step is resolved')
      }
    },
  }
}

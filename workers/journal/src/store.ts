/**
 * The journal's SQLite tables and every write a durable run makes, each in one transaction.
 *
 * A workflow is one durable run, keyed by the id its caller gave it. Each time it starts, it takes
 * the next epoch, and every later write names that epoch. A write from an older epoch is refused
 * as FENCED, which is how a handler that lost its connection but kept running (a zombie) is kept
 * from landing results after a newer execution took over. A step is one outgoing call, numbered in
 * the order the workflow's code started it, with an intent written before the call goes out and
 * the outcome written after it returns.
 *
 * Writes answer with a Rejection instead of throwing, because the SDK turns a thrown error into
 * `invocation_failed` and the caller needs the code. Retrying a write that already landed is
 * harmless, since the preload retries while the journal restarts.
 */
import Database from 'better-sqlite3'
import { type Callee, idempotencyKey, type Resume, resumeOf } from './resume.js'

export type StoredError = { code?: string; name?: string; message: string; function_id?: string; stacktrace?: string }
export type Outcome = { ok: true; value: unknown } | { ok: false; error: StoredError }
export type Status = 'running' | 'done' | 'failed' | 'paused'
export type Rejection = { rejected: 'FENCED' | 'DIVERGED' | 'UNKNOWN_WORKFLOW'; message: string }

export type Pause = { step: number; function_id: string; reason: 'lost' }

/** A step as a re-execution sees it: `outcome` when it finished, `resume` when it was in flight. */
export type SavedStep = { step: number; function_id: string; input_hash: string; outcome?: Outcome; resume?: Resume; idempotency_key: string | null }

export type Intent = { idempotency_key: string | null; outcome?: Outcome }

export type Claim =
  | { status: 'running'; epoch: number; steps: SavedStep[] }
  | { status: 'done'; output: unknown }
  | { status: 'failed'; error: StoredError }
  | { status: 'paused'; pause: Pause }

export type Begin = {
  workflow_id: string
  function_id: string
  input: unknown
  input_hash: string
  worker_id: string | null
  invocation_id: string | null
  started_by: string | null
}

export type Workflow = {
  workflow_id: string
  function_id: string
  input: unknown
  status: Status
  epoch: number
  owner_worker_id: string | null
  started_by: string | null
  output?: unknown
  error?: StoredError
  pause?: Pause
  created_at_ms: number
  updated_at_ms: number
  finished_at_ms: number | null
}

type WorkflowRow = {
  workflow_id: string
  function_id: string
  input: string
  input_hash: string
  status: Status
  epoch: number
  owner_worker_id: string | null
  started_by: string | null
  output: string | null
  error: string | null
  pause: string | null
  created_at_ms: number
  updated_at_ms: number
  finished_at_ms: number | null
}

type StepRow = {
  step: number
  function_id: string
  input_hash: string
  effects: string
  takes_key: number
  epoch: number
  status: 'intent' | 'done'
  outcome: string | null
  idempotency_key: string | null
  answer: Resume | null
}

const SCHEMA = `
create table if not exists workflows (
  workflow_id     text primary key,
  function_id     text not null,
  input           text not null,
  input_hash      text not null,
  status          text not null,
  epoch           integer not null,
  owner_worker_id text,
  started_by      text,
  output          text,
  error           text,
  pause           text,
  created_at_ms   integer not null,
  updated_at_ms   integer not null,
  finished_at_ms  integer
);
create index if not exists workflows_running on workflows (status) where status = 'running';

create table if not exists steps (
  workflow_id     text not null,
  step            integer not null,
  function_id     text not null,
  input_hash      text not null,
  effects         text not null,
  takes_key       integer not null,
  epoch           integer not null,
  status          text not null,
  outcome         text,
  idempotency_key text,
  answer          text,
  started_at_ms   integer not null,
  finished_at_ms  integer,
  primary key (workflow_id, step)
);

-- One row each time a step is sent, so a repeated call shows up as a second row.
create table if not exists attempts (
  workflow_id text not null,
  step        integer not null,
  epoch       integer not null,
  function_id text not null,
  at_ms       integer not null
);
create index if not exists attempts_by_workflow on attempts (workflow_id);

-- One row each time a workflow starts executing, the first time or again after a crash.
create table if not exists executions (
  workflow_id   text not null,
  epoch         integer not null,
  worker_id     text,
  invocation_id text,
  started_by    text,
  at_ms         integer not null
);
create index if not exists executions_by_workflow on executions (workflow_id);

-- Writes refused because a newer execution had taken the workflow over.
create table if not exists fenced (
  workflow_id text not null,
  epoch       integer not null,
  step        integer,
  write       text not null,
  at_ms       integer not null
);
`

function parsed<T>(text: string | null): T | undefined {
  return text === null ? undefined : (JSON.parse(text) as T)
}

function workflowOf(row: WorkflowRow): Workflow {
  return {
    workflow_id: row.workflow_id,
    function_id: row.function_id,
    input: JSON.parse(row.input),
    status: row.status,
    epoch: row.epoch,
    owner_worker_id: row.owner_worker_id,
    started_by: row.started_by,
    output: parsed(row.output),
    error: parsed<StoredError>(row.error),
    pause: parsed<Pause>(row.pause),
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
    finished_at_ms: row.finished_at_ms,
  }
}

function calleeOf(row: StepRow): Callee {
  return { effects: JSON.parse(row.effects), takesKey: row.takes_key === 1 }
}

function savedStep(row: StepRow): SavedStep {
  const base = { step: row.step, function_id: row.function_id, input_hash: row.input_hash, idempotency_key: row.idempotency_key }
  if (row.status === 'done') {
    return { ...base, outcome: JSON.parse(row.outcome!) as Outcome }
  }

  return { ...base, resume: row.answer ?? resumeOf(calleeOf(row)) }
}

function terminal(row: WorkflowRow): Claim | undefined {
  if (row.status === 'done') {
    return { status: 'done', output: parsed(row.output) }
  }

  if (row.status === 'failed') {
    return { status: 'failed', error: parsed<StoredError>(row.error)! }
  }

  if (row.status === 'paused') {
    return { status: 'paused', pause: parsed<Pause>(row.pause)! }
  }

  return undefined
}

export class Journal {
  private readonly db: Database.Database
  private readonly now: () => number

  constructor(file: string, now: () => number = Date.now) {
    this.db = new Database(file)
    // FULL makes each commit wait for the disk, so an acknowledged write survives the journal's
    // process dying. On macOS fsync stops at the drive's cache unless fullfsync is on.
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.exec(SCHEMA)
    this.now = now
  }

  close(): void {
    this.db.close()
  }

  private row(workflowId: string): WorkflowRow | undefined {
    return this.db.prepare('select * from workflows where workflow_id = ?').get(workflowId) as WorkflowRow | undefined
  }

  private stepRow(workflowId: string, step: number): StepRow | undefined {
    return this.db.prepare('select * from steps where workflow_id = ? and step = ?').get(workflowId, step) as StepRow | undefined
  }

  /** Why a write from `epoch` may not land, or undefined when it may. A refused write is kept for counting. */
  private fence(workflowId: string, epoch: number, step: number | null, write: string): { row: WorkflowRow } | Rejection {
    const row = this.row(workflowId)
    if (!row) {
      return { rejected: 'UNKNOWN_WORKFLOW', message: `UNKNOWN_WORKFLOW: no workflow ${workflowId}` }
    }

    if (row.epoch !== epoch || row.status !== 'running') {
      this.db.prepare('insert into fenced (workflow_id, epoch, step, write, at_ms) values (?, ?, ?, ?, ?)').run(workflowId, epoch, step, write, this.now())
      return { rejected: 'FENCED', message: `FENCED: workflow ${workflowId} is at epoch ${row.epoch} (${row.status}); this ${write} came from epoch ${epoch}` }
    }

    // Recovery reads this to tell a run in progress from one whose handler gave up on the journal.
    this.db.prepare('update workflows set updated_at_ms = ? where workflow_id = ?').run(this.now(), workflowId)
    return { row }
  }

  private diverge(row: WorkflowRow, message: string): Rejection {
    const error: StoredError = { code: 'DIVERGED', message }
    this.db
      .prepare("update workflows set status = 'failed', error = ?, owner_worker_id = null, updated_at_ms = ?, finished_at_ms = ? where workflow_id = ?")
      .run(JSON.stringify(error), this.now(), this.now(), row.workflow_id)
    return { rejected: 'DIVERGED', message: `DIVERGED: ${message}` }
  }

  /**
   * Starts or restarts a workflow and gives it the next epoch. A finished, failed or paused
   * workflow is returned as it is. A step that was in flight and needs a person pauses the
   * workflow here, before any of its code runs again.
   */
  begin(start: Begin): Claim | Rejection {
    return this.db.transaction((): Claim | Rejection => {
      const now = this.now()
      const existing = this.row(start.workflow_id)
      if (existing && (existing.function_id !== start.function_id || existing.input_hash !== start.input_hash)) {
        return { rejected: 'DIVERGED', message: `DIVERGED: workflow ${start.workflow_id} started as ${existing.function_id} with another input` }
      }

      const ended = existing && terminal(existing)
      if (ended) {
        return ended
      }

      const epoch = (existing?.epoch ?? 0) + 1
      if (existing) {
        this.db
          .prepare('update workflows set epoch = ?, owner_worker_id = ?, updated_at_ms = ? where workflow_id = ?')
          .run(epoch, start.worker_id, now, start.workflow_id)
      } else {
        this.db
          .prepare(
            `insert into workflows (workflow_id, function_id, input, input_hash, status, epoch, owner_worker_id, started_by, created_at_ms, updated_at_ms)
             values (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
          )
          .run(start.workflow_id, start.function_id, JSON.stringify(start.input), start.input_hash, epoch, start.worker_id, start.started_by, now, now)
      }

      this.db
        .prepare('insert into executions (workflow_id, epoch, worker_id, invocation_id, started_by, at_ms) values (?, ?, ?, ?, ?, ?)')
        .run(start.workflow_id, epoch, start.worker_id, start.invocation_id, start.started_by, now)
      const steps = (this.db.prepare('select * from steps where workflow_id = ? order by step').all(start.workflow_id) as StepRow[]).map(savedStep)
      const lost = steps.find((step) => step.resume === 'pause')
      if (lost) {
        const pause: Pause = { step: lost.step, function_id: lost.function_id, reason: 'lost' }
        this.db
          .prepare("update workflows set status = 'paused', pause = ?, owner_worker_id = null, updated_at_ms = ? where workflow_id = ?")
          .run(JSON.stringify(pause), now, start.workflow_id)
        return { status: 'paused', pause }
      }

      return { status: 'running', epoch, steps }
    })()
  }

  /**
   * Writes the intent of a step about to go out, and returns the idempotency key the call should
   * carry. A step that already has its outcome returns that instead, and nothing is sent.
   */
  intent(workflowId: string, epoch: number, step: number, functionId: string, inputHash: string, callee: Callee): Intent | Rejection {
    return this.db.transaction((): Intent | Rejection => {
      const fenced = this.fence(workflowId, epoch, step, 'intent')
      if ('rejected' in fenced) {
        return fenced
      }

      const now = this.now()
      const existing = this.stepRow(workflowId, step)
      if (existing && (existing.function_id !== functionId || existing.input_hash !== inputHash)) {
        return this.diverge(fenced.row, `step ${step} of ${workflowId} was ${existing.function_id} with another input, and is now ${functionId}`)
      }

      if (existing?.status === 'done') {
        return { idempotency_key: existing.idempotency_key, outcome: JSON.parse(existing.outcome!) as Outcome }
      }

      // The same intent again, from a write the preload retried while the journal restarted.
      if (existing && existing.epoch === epoch) {
        return { idempotency_key: existing.idempotency_key }
      }

      const key = existing?.idempotency_key ?? idempotencyKey(workflowId, step, callee)
      if (existing) {
        this.db.prepare('update steps set epoch = ?, started_at_ms = ? where workflow_id = ? and step = ?').run(epoch, now, workflowId, step)
      } else {
        this.db
          .prepare(
            `insert into steps (workflow_id, step, function_id, input_hash, effects, takes_key, epoch, status, idempotency_key, started_at_ms)
             values (?, ?, ?, ?, ?, ?, ?, 'intent', ?, ?)`,
          )
          .run(workflowId, step, functionId, inputHash, JSON.stringify(callee.effects), callee.takesKey ? 1 : 0, epoch, key, now)
      }

      this.db.prepare('insert into attempts (workflow_id, step, epoch, function_id, at_ms) values (?, ?, ?, ?, ?)').run(workflowId, step, epoch, functionId, now)
      return { idempotency_key: key }
    })()
  }

  /** Writes what a step returned. Only after this is acknowledged does the workflow's code see it. */
  result(workflowId: string, epoch: number, step: number, outcome: Outcome): { saved: true } | Rejection {
    return this.db.transaction((): { saved: true } | Rejection => {
      const fenced = this.fence(workflowId, epoch, step, 'result')
      if ('rejected' in fenced) {
        return fenced
      }

      const existing = this.stepRow(workflowId, step)
      if (!existing) {
        return this.diverge(fenced.row, `step ${step} of ${workflowId} has a result and no intent`)
      }

      if (existing.status === 'done') {
        return { saved: true }
      }

      this.db
        .prepare("update steps set status = 'done', outcome = ?, finished_at_ms = ? where workflow_id = ? and step = ?")
        .run(JSON.stringify(outcome), this.now(), workflowId, step)
      return { saved: true }
    })()
  }

  /** Ends a workflow with what its code returned or threw. */
  finish(workflowId: string, epoch: number, outcome: Outcome): { saved: true } | Rejection {
    return this.db.transaction((): { saved: true } | Rejection => {
      const existing = this.row(workflowId)
      if (existing && existing.epoch === epoch && existing.status !== 'running' && existing.status !== 'paused') {
        return { saved: true }
      }

      const fenced = this.fence(workflowId, epoch, null, 'finish')
      if ('rejected' in fenced) {
        return fenced
      }

      const now = this.now()
      const [status, output, error] = outcome.ok ? ['done', JSON.stringify(outcome.value ?? null), null] : ['failed', null, JSON.stringify(outcome.error)]
      this.db
        .prepare('update workflows set status = ?, output = ?, error = ?, owner_worker_id = null, updated_at_ms = ?, finished_at_ms = ? where workflow_id = ?')
        .run(status, output, error, now, now, workflowId)
      return { saved: true }
    })()
  }

  /**
   * A person's answer to a paused workflow: send the lost step again, or take the outcome they
   * give for it. The workflow is then running with no owner, so recovery starts it again.
   */
  answer(workflowId: string, step: number, choice: { again: true } | { outcome: Outcome }): { answered: true } | Rejection {
    return this.db.transaction((): { answered: true } | Rejection => {
      const row = this.row(workflowId)
      const pause = row && parsed<Pause>(row.pause)
      if (!row || row.status !== 'paused' || pause?.step !== step) {
        return { rejected: 'UNKNOWN_WORKFLOW', message: `UNKNOWN_WORKFLOW: ${workflowId} is not paused at step ${step}` }
      }

      if ('outcome' in choice) {
        this.db
          .prepare("update steps set status = 'done', outcome = ?, finished_at_ms = ? where workflow_id = ? and step = ?")
          .run(JSON.stringify(choice.outcome), this.now(), workflowId, step)
      } else {
        this.db.prepare("update steps set answer = 'again' where workflow_id = ? and step = ?").run(workflowId, step)
      }

      this.db
        .prepare("update workflows set status = 'running', pause = null, owner_worker_id = null, updated_at_ms = ? where workflow_id = ?")
        .run(this.now(), workflowId)
      return { answered: true }
    })()
  }

  /** Forgets who runs the workflows a worker had, because the engine stopped their invocations when it left. */
  release(workerId: string): string[] {
    const rows = this.db.prepare("select workflow_id from workflows where status = 'running' and owner_worker_id = ?").all(workerId) as { workflow_id: string }[]
    this.db.prepare("update workflows set owner_worker_id = null where status = 'running' and owner_worker_id = ?").run(workerId)
    return rows.map((row) => row.workflow_id)
  }

  /**
   * Running workflows nobody is executing: no owner, an owner that is no longer connected, or no
   * write for `staleMs`, which is what a handler leaves behind when it stops after the journal
   * was unreachable for too long.
   */
  orphans(live: Set<string>, staleMs: number): Workflow[] {
    const staleBefore = this.now() - staleMs
    const rows = this.db.prepare("select * from workflows where status = 'running'").all() as WorkflowRow[]
    return rows
      .filter((row) => row.owner_worker_id === null || !live.has(row.owner_worker_id) || row.updated_at_ms < staleBefore)
      .map(workflowOf)
  }

  get(workflowId: string): Workflow | undefined {
    const row = this.row(workflowId)
    return row && workflowOf(row)
  }

  /** Everything the journal has on a workflow, for the experiments and for debugging. */
  detail(workflowId: string) {
    const workflow = this.get(workflowId)
    if (!workflow) {
      return undefined
    }

    const steps = (this.db.prepare('select * from steps where workflow_id = ? order by step').all(workflowId) as StepRow[]).map((row) => ({
      step: row.step,
      function_id: row.function_id,
      status: row.status,
      epoch: row.epoch,
      idempotency_key: row.idempotency_key,
      outcome: parsed<Outcome>(row.outcome),
    }))
    const attempts = this.db.prepare('select step, epoch, function_id, at_ms from attempts where workflow_id = ? order by at_ms').all(workflowId)
    const executions = this.db.prepare('select epoch, worker_id, invocation_id, started_by, at_ms from executions where workflow_id = ? order by epoch').all(workflowId)
    const fenced = this.db.prepare('select epoch, step, write, at_ms from fenced where workflow_id = ? order by at_ms').all(workflowId)
    return { ...workflow, steps, attempts, executions, fenced }
  }

  list(status?: Status): Workflow[] {
    const rows = status
      ? (this.db.prepare('select * from workflows where status = ? order by created_at_ms').all(status) as WorkflowRow[])
      : (this.db.prepare('select * from workflows order by created_at_ms').all() as WorkflowRow[])
    return rows.map(workflowOf)
  }
}

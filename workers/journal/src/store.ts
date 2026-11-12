/**
 * The journal's SQLite tables and every write a durable run makes, each in one transaction.
 *
 * A workflow is one durable run, keyed by the id its caller gave it. Each start takes the next
 * epoch, and a write from an older epoch is refused as FENCED, so a handler that lost its
 * connection but kept running can't land results after a newer execution took over. A step is
 * one outgoing call, numbered in the order the code started it, with an intent written before it
 * goes out and the outcome after it returns. A pending step waits for a value, a wake time, or a
 * person deciding about a call a crash cut off, and its workflow waits with nobody running it.
 *
 * Writes answer with a Rejection instead of throwing, because the SDK turns a thrown error into
 * `invocation_failed` and the caller needs the code.
 */
import Database from 'better-sqlite3'
import { type Callee, idempotencyKey, type Resume, resumeOf } from './resume.js'

export type StoredError = { code?: string; name?: string; message: string; function_id?: string; stacktrace?: string }
export type Outcome = { ok: true; value: unknown } | { ok: false; error: StoredError }
export type Status = 'running' | 'waiting' | 'done' | 'failed'

/** A wait waits for a value sent to its name, a sleep for its wake time, and a lost step for a person. */
export type PendingKind = 'wait' | 'sleep' | 'lost'

/** A value the code offers the person who resolves its wait, with the words for its button. */
export type Choice = { label: string; value: unknown }

export type Pending = {
  step: number
  function_id: string
  kind: PendingKind
  since_ms: number
  name?: string
  /** When a wait's timeout wins, if nothing resolves it first. */
  timeout_at_ms?: number
  wake_at_ms?: number
  /** What the code told the person about the wait. */
  detail?: unknown
  choices?: Choice[]
}

export type Rejection = { rejected: 'FENCED' | 'DIVERGED' | 'UNKNOWN_WORKFLOW' | 'WAITING'; message: string; pending?: Pending }

/** A step as a re-execution sees it: `outcome` when it finished, `resume` when it was in flight. */
export type SavedStep = { step: number; function_id: string; input_hash: string; outcome?: Outcome; resume?: Resume; idempotency_key: string | null }

export type Intent = { idempotency_key: string | null; outcome?: Outcome }

export type Park =
  | { kind: 'wait'; name: string; timeout_ms?: number; detail?: unknown; choices?: Choice[] }
  | { kind: 'sleep'; ms: number }

/** A wait or sleep step: its result when it has one already, or the step left pending. */
export type Parked = { outcome: Outcome } | { pending: Pending }

/** Which pending step a resolve is for, and what it gives it. `execute` sends a lost call again. */
export type Resolve = {
  workflow_id: string
  name?: string
  step?: number
  action?: 'deliver' | 'execute'
  value?: unknown
  error?: StoredError
}

/** `resolved` is false when the step was already resolved, timed out, or isn't pending. */
export type Resolution = { resolved: boolean; resumed: boolean; step?: number; reason?: string }

export type Claim =
  | { status: 'running'; epoch: number; steps: SavedStep[] }
  | { status: 'done'; output: unknown }
  | { status: 'failed'; error: StoredError }
  | { status: 'waiting'; pending: Pending }

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
  pending?: Pending
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
  status: 'intent' | 'pending' | 'done'
  outcome: string | null
  idempotency_key: string | null
  answer: Resume | null
}

type PendingRow = {
  workflow_id: string
  step: number
  function_id: string
  kind: PendingKind
  name: string | null
  due_at_ms: number | null
  detail: string | null
  choices: string | null
  since_ms: number
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

-- One row for each step that is pending. due_at_ms is a sleep's wake time or a wait's timeout.
create table if not exists pending (
  workflow_id text not null,
  step        integer not null,
  function_id text not null,
  kind        text not null,
  name        text,
  due_at_ms   integer,
  detail      text,
  choices     text,
  since_ms    integer not null,
  primary key (workflow_id, step)
);
create index if not exists pending_due on pending (due_at_ms) where due_at_ms is not null;

-- The value each named wait got, whichever landed first: a resolve or the wait's timeout. A value
-- sent before the run reached its wait is kept here with no step until the run gets there.
create table if not exists wait_values (
  workflow_id text not null,
  name        text not null,
  outcome     text not null,
  settled_by  text not null,
  step        integer,
  at_ms       integer not null,
  primary key (workflow_id, name)
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

function pendingOf(row: PendingRow): Pending {
  const due = row.due_at_ms ?? undefined
  return {
    step: row.step,
    function_id: row.function_id,
    kind: row.kind,
    since_ms: row.since_ms,
    ...(row.name === null ? {} : { name: row.name }),
    ...(due !== undefined && row.kind === 'wait' ? { timeout_at_ms: due } : {}),
    ...(due !== undefined && row.kind === 'sleep' ? { wake_at_ms: due } : {}),
    ...(row.detail === null ? {} : { detail: JSON.parse(row.detail) }),
    ...(row.choices === null ? {} : { choices: JSON.parse(row.choices) as Choice[] }),
  }
}

function workflowOf(row: WorkflowRow, pending?: PendingRow): Workflow {
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
    ...(pending ? { pending: pendingOf(pending) } : {}),
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

/** What a wait's code gets: the value, told apart from a timeout. */
function waitOutcome(value: unknown): Outcome {
  return { ok: true, value: { timed_out: false, value: value ?? null } }
}

const TIMED_OUT: Outcome = { ok: true, value: { timed_out: true } }

function refused(reason: string): Resolution {
  return { resolved: false, resumed: false, reason }
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

  private pendingRow(workflowId: string): PendingRow | undefined {
    return this.db.prepare('select * from pending where workflow_id = ? order by step limit 1').get(workflowId) as PendingRow | undefined
  }

  /**
   * Whether a write from `epoch` may land. A write from another epoch, or to a finished run, is
   * refused as FENCED and kept for counting. While the run waits, its own handler may still save
   * the result of a call that was already out, but may not start anything new.
   */
  private fence(workflowId: string, epoch: number, step: number | null, write: string, whileWaiting = false): { row: WorkflowRow } | Rejection {
    const row = this.row(workflowId)
    if (!row) {
      return { rejected: 'UNKNOWN_WORKFLOW', message: `UNKNOWN_WORKFLOW: no workflow ${workflowId}` }
    }

    if (row.epoch === epoch && row.status === 'waiting' && !whileWaiting) {
      const pending = this.pendingRow(workflowId)
      return { rejected: 'WAITING', message: `WAITING: workflow ${workflowId} is waiting at step ${pending?.step}`, ...(pending ? { pending: pendingOf(pending) } : {}) }
    }

    const open = row.status === 'running' || (whileWaiting && row.status === 'waiting')
    if (row.epoch !== epoch || !open) {
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

  /** Leaves a step pending and the workflow waiting, with nobody running it. */
  private wait(workflowId: string, row: Omit<PendingRow, 'workflow_id' | 'since_ms'>): Pending {
    const now = this.now()
    this.db.prepare("update steps set status = 'pending' where workflow_id = ? and step = ?").run(workflowId, row.step)
    this.db
      .prepare('insert or replace into pending (workflow_id, step, function_id, kind, name, due_at_ms, detail, choices, since_ms) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(workflowId, row.step, row.function_id, row.kind, row.name, row.due_at_ms, row.detail, row.choices, now)
    this.db.prepare("update workflows set status = 'waiting', owner_worker_id = null, updated_at_ms = ? where workflow_id = ?").run(now, workflowId)
    return pendingOf({ ...row, workflow_id: workflowId, since_ms: now })
  }

  private terminal(row: WorkflowRow): Claim | undefined {
    if (row.status === 'done') {
      return { status: 'done', output: parsed(row.output) }
    }

    if (row.status === 'failed') {
      return { status: 'failed', error: parsed<StoredError>(row.error)! }
    }

    const pending = row.status === 'waiting' ? this.pendingRow(row.workflow_id) : undefined
    return pending ? { status: 'waiting', pending: pendingOf(pending) } : undefined
  }

  /**
   * Starts or restarts a workflow and gives it the next epoch. A finished, failed or waiting
   * workflow is returned as it is. A step that was in flight and needs a person becomes pending
   * here, before any of the workflow's code runs again.
   */
  begin(start: Begin): Claim | Rejection {
    return this.db.transaction((): Claim | Rejection => {
      const now = this.now()
      const existing = this.row(start.workflow_id)
      if (existing && (existing.function_id !== start.function_id || existing.input_hash !== start.input_hash)) {
        return { rejected: 'DIVERGED', message: `DIVERGED: workflow ${start.workflow_id} started as ${existing.function_id} with another input` }
      }

      const ended = existing && this.terminal(existing)
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
        const pending = this.wait(start.workflow_id, { step: lost.step, function_id: lost.function_id, kind: 'lost', name: null, due_at_ms: null, detail: null, choices: null })
        return { status: 'waiting', pending }
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
      const fenced = this.fence(workflowId, epoch, step, 'result', true)
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

      this.saveStep(workflowId, step, outcome)
      return { saved: true }
    })()
  }

  /**
   * A `durable::wait` or `durable::sleep` step. It returns its result at once when it has one: a
   * saved one, a value sent to the wait's name before the run got here, or a sleep of no time.
   * Otherwise the step is left pending and the workflow waits.
   */
  park(workflowId: string, epoch: number, step: number, functionId: string, inputHash: string, park: Park): Parked | Rejection {
    return this.db.transaction((): Parked | Rejection => {
      const fenced = this.fence(workflowId, epoch, step, 'park')
      if ('rejected' in fenced) {
        return fenced
      }

      const existing = this.stepRow(workflowId, step)
      if (existing && (existing.function_id !== functionId || existing.input_hash !== inputHash)) {
        return this.diverge(fenced.row, `step ${step} of ${workflowId} was ${existing.function_id} with another input, and is now ${functionId}`)
      }

      if (existing?.status === 'done') {
        return { outcome: JSON.parse(existing.outcome!) as Outcome }
      }

      const now = this.now()
      this.db
        .prepare(
          `insert or replace into steps (workflow_id, step, function_id, input_hash, effects, takes_key, epoch, status, started_at_ms)
           values (?, ?, ?, ?, '[]', 0, ?, 'intent', ?)`,
        )
        .run(workflowId, step, functionId, inputHash, epoch, now)
      const ready = this.ready(workflowId, step, park)
      if (ready) {
        this.saveStep(workflowId, step, ready)
        return { outcome: ready }
      }

      return {
        pending: this.wait(workflowId, {
          step,
          function_id: functionId,
          kind: park.kind,
          name: park.kind === 'wait' ? park.name : null,
          due_at_ms: this.dueAt(park, now),
          detail: park.kind === 'wait' && park.detail !== undefined ? JSON.stringify(park.detail) : null,
          choices: park.kind === 'wait' && park.choices !== undefined ? JSON.stringify(park.choices) : null,
        }),
      }
    })()
  }

  /** A wait's or sleep's result when it needs no waiting: a value already sent to its name, or no time to sleep. */
  private ready(workflowId: string, step: number, park: Park): Outcome | undefined {
    if (park.kind === 'sleep') {
      return park.ms <= 0 ? { ok: true, value: { slept_ms: 0 } } : undefined
    }

    const sent = this.db.prepare('select outcome from wait_values where workflow_id = ? and name = ?').get(workflowId, park.name) as { outcome: string } | undefined
    if (!sent) {
      return undefined
    }

    this.db.prepare('update wait_values set step = coalesce(step, ?) where workflow_id = ? and name = ?').run(step, workflowId, park.name)
    return JSON.parse(sent.outcome) as Outcome
  }

  private dueAt(park: Park, now: number): number | null {
    if (park.kind === 'sleep') {
      return now + park.ms
    }

    return park.timeout_ms === undefined ? null : now + park.timeout_ms
  }

  private saveStep(workflowId: string, step: number, outcome: Outcome): void {
    this.db
      .prepare("update steps set status = 'done', outcome = ?, finished_at_ms = ? where workflow_id = ? and step = ?")
      .run(JSON.stringify(outcome), this.now(), workflowId, step)
  }

  /** Ends a step's pending, and lets the workflow run again once nothing else in it is pending. */
  private unpend(workflowId: string, step: number): boolean {
    this.db.prepare('delete from pending where workflow_id = ? and step = ?').run(workflowId, step)
    if (this.pendingRow(workflowId)) {
      return false
    }

    const resumed = this.db
      .prepare("update workflows set status = 'running', owner_worker_id = null, updated_at_ms = ? where workflow_id = ? and status = 'waiting'")
      .run(this.now(), workflowId)
    return resumed.changes > 0
  }

  /**
   * Saves what a pending step resolved to, in the transaction that ends its pending, so a value
   * and a timeout racing for one wait can't both land. A wait's value is also kept under its name,
   * which is how a duplicate resolve and a later wait with the same name find it.
   */
  private settle(row: PendingRow, outcome: Outcome | 'again', by: 'resolve' | 'timeout'): Resolution {
    if (outcome === 'again') {
      this.db.prepare("update steps set status = 'intent', answer = 'again' where workflow_id = ? and step = ?").run(row.workflow_id, row.step)
    } else {
      this.saveStep(row.workflow_id, row.step, outcome)
    }

    if (row.kind === 'wait' && outcome !== 'again') {
      this.db
        .prepare('insert into wait_values (workflow_id, name, outcome, settled_by, step, at_ms) values (?, ?, ?, ?, ?, ?)')
        .run(row.workflow_id, row.name, JSON.stringify(outcome), by, row.step, this.now())
    }

    return { resolved: true, resumed: this.unpend(row.workflow_id, row.step), step: row.step }
  }

  /** What resolving this pending step gives it, or why it can't. */
  private resolutionOf(row: PendingRow, request: Resolve): Outcome | 'again' | { reason: string } {
    if (request.action === 'execute') {
      return row.kind === 'lost' ? 'again' : { reason: `only a call a crash cut off can be sent again, and step ${row.step} is a ${row.kind}` }
    }

    if (request.error) {
      return { ok: false, error: request.error }
    }

    const byKind: Record<PendingKind, () => Outcome> = {
      wait: () => waitOutcome(request.value),
      sleep: () => ({ ok: true, value: { slept_ms: this.now() - row.since_ms } }),
      lost: () => ({ ok: true, value: request.value ?? null }),
    }
    return byKind[row.kind]()
  }

  /**
   * Resolves a pending step by its wait's name or its number. A value for a name nothing waits on
   * yet is kept for the wait when the run gets there. A second resolve, or one after the timeout
   * won, changes nothing and returns `resolved: false`.
   */
  resolve(request: Resolve): Resolution {
    return this.db.transaction((): Resolution => {
      const { workflow_id: workflowId, name, step } = request
      const row = this.row(workflowId)
      if (row && (row.status === 'done' || row.status === 'failed')) {
        return refused(`${workflowId} has ended (${row.status})`)
      }

      if (name !== undefined) {
        const sent = this.db.prepare('select settled_by from wait_values where workflow_id = ? and name = ?').get(workflowId, name) as { settled_by: string } | undefined
        if (sent) {
          return refused(sent.settled_by === 'timeout' ? `the wait for "${name}" timed out first` : `"${name}" was already resolved`)
        }
      }

      const target = (step !== undefined
        ? this.db.prepare('select * from pending where workflow_id = ? and step = ?').get(workflowId, step)
        : this.db.prepare("select * from pending where workflow_id = ? and kind = 'wait' and name = ?").get(workflowId, name ?? null)) as PendingRow | undefined
      if (!target) {
        return this.keep(request)
      }

      const resolution = this.resolutionOf(target, request)
      if (resolution !== 'again' && 'reason' in resolution) {
        return refused(resolution.reason)
      }

      return this.settle(target, resolution, 'resolve')
    })()
  }

  /** A value for a wait the run hasn't reached, kept under its name. */
  private keep(request: Resolve): Resolution {
    if (request.name === undefined || request.action === 'execute') {
      return refused(`step ${request.step} of ${request.workflow_id} is not pending`)
    }

    const outcome: Outcome = request.error ? { ok: false, error: request.error } : waitOutcome(request.value)
    this.db
      .prepare("insert into wait_values (workflow_id, name, outcome, settled_by, step, at_ms) values (?, ?, ?, 'resolve', null, ?)")
      .run(request.workflow_id, request.name, JSON.stringify(outcome), this.now())
    return { resolved: true, resumed: false }
  }

  /** Wakes every sleep whose time has come and times out every wait past its deadline. Returns the workflows that can run again. */
  due(): string[] {
    return this.db.transaction((): string[] => {
      const now = this.now()
      const rows = this.db.prepare('select * from pending where due_at_ms is not null and due_at_ms <= ? order by due_at_ms').all(now) as PendingRow[]
      const resumed: string[] = []
      for (const row of rows) {
        const outcome: Outcome = row.kind === 'sleep' ? { ok: true, value: { slept_ms: now - row.since_ms } } : TIMED_OUT
        if (this.settle(row, outcome, 'timeout').resumed) {
          resumed.push(row.workflow_id)
        }
      }

      return resumed
    })()
  }

  /** When the next sleep wakes or wait times out, or null when nothing is due. */
  nextDue(): number | null {
    return (this.db.prepare('select min(due_at_ms) as at from pending').get() as { at: number | null }).at
  }

  /** Ends a workflow with what its code returned or threw. */
  finish(workflowId: string, epoch: number, outcome: Outcome): { saved: true } | Rejection {
    return this.db.transaction((): { saved: true } | Rejection => {
      const existing = this.row(workflowId)
      if (existing && existing.epoch === epoch && (existing.status === 'done' || existing.status === 'failed')) {
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

  /** Forgets who runs the workflows a worker had, because the engine stopped their invocations when it left. */
  release(workerId: string): string[] {
    const rows = this.db.prepare("select workflow_id from workflows where status = 'running' and owner_worker_id = ?").all(workerId) as { workflow_id: string }[]
    this.db.prepare("update workflows set owner_worker_id = null where status = 'running' and owner_worker_id = ?").run(workerId)
    return rows.map((row) => row.workflow_id)
  }

  /**
   * Running workflows nobody is executing: no owner, an owner that is no longer connected, or no
   * write for `staleMs`, which is what a handler leaves behind when it stops after the journal
   * was unreachable for too long. A waiting workflow is never one, since nothing should run it.
   */
  orphans(live: Set<string>, staleMs: number): Workflow[] {
    const staleBefore = this.now() - staleMs
    const rows = this.db.prepare("select * from workflows where status = 'running'").all() as WorkflowRow[]
    return rows
      .filter((row) => row.owner_worker_id === null || !live.has(row.owner_worker_id) || row.updated_at_ms < staleBefore)
      .map((row) => workflowOf(row))
  }

  get(workflowId: string): Workflow | undefined {
    const row = this.row(workflowId)
    return row && workflowOf(row, this.pendingRow(workflowId))
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
    const values = this.db.prepare('select name, outcome, settled_by, step, at_ms from wait_values where workflow_id = ? order by at_ms').all(workflowId) as { outcome: string }[]
    return { ...workflow, steps, attempts, executions, fenced, values: values.map((value) => ({ ...value, outcome: JSON.parse(value.outcome) as Outcome })) }
  }

  list(status?: Status): Workflow[] {
    const rows = status
      ? (this.db.prepare('select * from workflows where status = ? order by created_at_ms').all(status) as WorkflowRow[])
      : (this.db.prepare('select * from workflows order by created_at_ms').all() as WorkflowRow[])
    const pending = new Map((this.db.prepare('select * from pending order by step desc').all() as PendingRow[]).map((row) => [row.workflow_id, row]))
    return rows.map((row) => workflowOf(row, pending.get(row.workflow_id)))
  }
}

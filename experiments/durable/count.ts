/**
 * Counts what one burst did, per run and in total: whether each run finished, how many invites
 * the email provider took for it, and how many model calls it made against how many the same run
 * makes when nothing interrupts it.
 *
 * A run finished when the agent's own code ended it: booked, failed, or threw (bug 1's
 * SyntaxError). It never finished when a stop ended it. Model calls are counted at the model, from
 * its captures, because an observer never hears of a call whose caller died before it returned.
 * A run's uninterrupted model calls are the model steps in its journal, or for a run without a
 * journal, the observed model calls of the execution that finished.
 */
import type { Observed } from './stack.js'

export type RunReport = {
  index: number
  workflow_id: string
  request: string
  outcome: 'booked' | 'failed' | 'errors' | 'paused'
  starts: number
  resumed: boolean
  elapsed_ms: number
  output?: { status: string }
  error?: { code?: string; message?: string; name?: string }
}

export type JournalDetail = {
  status: string
  executions: { epoch: number; started_by: string | null }[]
  attempts: { step: number; function_id: string }[]
  steps: { step: number; function_id: string }[]
  fenced: unknown[]
} | null

export type Send = { to: string; subject: string; caller_invocation_id: string | null }
export type Metric = { kind: 'step' | 'run'; journal_ms?: number; replayed?: boolean; again?: boolean; function_id?: string }

const STOP_CODES = ['invocation_stopped', 'function_not_found', 'TIMEOUT', 'JOURNAL_UNAVAILABLE', 'FENCED', 'PAUSED', 'DIVERGED', 'UNKNOWN_WORKFLOW']

function stoppedBy(error: RunReport['error']): string | undefined {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`
  return STOP_CODES.find((code) => text.includes(code))
}

/** The invite's `to` and `subject` for a request, which tell one run's sends apart from another's. */
function inviteOf(request: string): { to: string; subject: string } {
  const [, minutes, name, weekday] = /Book (\d+) minutes with (\w+) next (\w+)/.exec(request) ?? []
  return { to: `${name.toLowerCase()}@example.com`, subject: `${minutes} minutes, ${weekday}` }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null
  }

  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(2))
}

function finishedRun(report: RunReport): boolean {
  if (report.outcome === 'paused') {
    return false
  }

  return report.outcome !== 'errors' || stoppedBy(report.error) === undefined
}

/** The model calls the same run makes uninterrupted, or null when no execution of it finished. */
function referenceModelCalls(report: RunReport, journal: JournalDetail, runs: Observed[], models: Observed[]): number | null {
  if (journal && journal.steps.length > 0 && journal.status !== 'running') {
    return journal.steps.filter((step) => step.function_id === 'model::complete').length
  }

  const finished = runs.filter((run) => run.input?.request === report.request && run.input?._workflow_id === report.workflow_id && ['success', 'error'].includes(run.status))
  const last = finished.at(-1)
  if (!last || !finishedRun(report)) {
    return null
  }

  return models.filter((model) => model.caller?.invocation_id === last.invocation_id).length
}

/** The request a model call was about, from the model's capture of answerFor. */
export function requestOfCapture(capture: { input?: { args?: unknown } }): string | undefined {
  const text = JSON.stringify(capture.input?.args ?? '')
  return /Book \d+ minutes with \w+ next \w+ afternoon/.exec(text)?.[0]
}

export function countRun(report: RunReport, journal: JournalDetail, observed: Observed[], outbox: Send[], modelCalls: string[]) {
  const models = observed.filter((event) => event.function_id === 'model::complete' && event.input?.messages?.[0]?.content === report.request)
  const made = modelCalls.filter((request) => request === report.request).length
  const runs = observed.filter((event) => event.function_id === 'agent::run')
  const invite = inviteOf(report.request)
  const sends = outbox.filter((send) => send.to === invite.to && send.subject === invite.subject)
  const executions = journal?.executions.length ?? 0
  const stop = report.outcome === 'errors' ? stoppedBy(report.error) : undefined
  const interrupted = report.starts > 1 || report.resumed || executions > 1 || stop !== undefined
  const reference = referenceModelCalls(report, journal, runs, models)
  return {
    index: report.index,
    workflow_id: report.workflow_id,
    outcome: report.outcome,
    status: report.output?.status ?? null,
    stopped_by: stop ?? (report.outcome === 'paused' ? 'PAUSED' : null),
    finished: finishedRun(report),
    interrupted,
    starts: report.starts,
    elapsed_ms: report.elapsed_ms,
    executions,
    started_again_by: journal?.executions.slice(1).map((execution) => execution.started_by) ?? [],
    emails: sends.length,
    email_invocations: new Set(sends.map((send) => send.caller_invocation_id)).size,
    email_steps: journal?.steps.filter((step) => step.function_id === 'email::send').length ?? null,
    model_calls: made,
    model_calls_observed: models.length,
    model_reference: reference,
    model_repeats: reference === null ? null : made - reference,
    model_attempts: journal?.attempts.filter((attempt) => attempt.function_id === 'model::complete').length ?? null,
    fenced: journal?.fenced.length ?? 0,
  }
}

export type RunRow = ReturnType<typeof countRun>

export function summarize(rows: RunRow[], metrics: Metric[], observed: Observed[], repeatsDropped: number) {
  const booked = rows.filter((row) => row.status === 'booked' && row.finished)
  const interrupted = rows.filter((row) => row.interrupted)
  const counted = rows.filter((row) => row.model_repeats !== null)
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  const sentSteps = metrics.filter((metric) => metric.kind === 'step' && !metric.replayed && metric.journal_ms !== undefined)
  const runDurations = observed.filter((event) => event.function_id === 'agent::run' && ['success', 'error'].includes(event.status)).map((event) => (event as unknown as { duration_ms: number }).duration_ms)
  return {
    runs: rows.length,
    finished: rows.filter((row) => row.finished).length,
    never_finished: rows.filter((row) => !row.finished).length,
    paused: rows.filter((row) => row.stopped_by === 'PAUSED').length,
    interrupted: interrupted.length,
    interrupted_finished: interrupted.filter((row) => row.finished).length,
    booked: booked.length,
    emails_for_booked: sum(booked.map((row) => row.emails)),
    booked_with_one_email: booked.filter((row) => row.emails === 1).length,
    booked_with_no_email: booked.filter((row) => row.emails === 0).length,
    // Two sends from one execution are the agent's own retry after a slow send (bug 3).
    booked_sent_twice_by_the_agents_retry: booked.filter((row) => row.emails > 1 && row.email_invocations === 1).length,
    booked_sent_twice_across_executions: booked.filter((row) => row.emails > 1 && row.email_invocations > 1).length,
    emails_for_runs_not_booked: sum(rows.filter((row) => !booked.includes(row)).map((row) => row.emails)),
    model_calls: sum(rows.map((row) => row.model_calls)),
    model_calls_observed: sum(rows.map((row) => row.model_calls_observed)),
    model_reference: sum(counted.map((row) => row.model_reference ?? 0)),
    model_repeats: sum(counted.map((row) => row.model_repeats ?? 0)),
    model_repeats_on_interrupted: sum(counted.filter((row) => row.interrupted).map((row) => row.model_repeats ?? 0)),
    runs_without_a_reference: rows.length - counted.length,
    executions: sum(rows.map((row) => row.executions)),
    fenced_writes: sum(rows.map((row) => row.fenced)),
    repeat_sends_dropped: repeatsDropped,
    journal_step_ms: { p50: percentile(sentSteps.map((metric) => metric.journal_ms!), 50), p99: percentile(sentSteps.map((metric) => metric.journal_ms!), 99), steps: sentSteps.length },
    journal_run_ms: (() => {
      const values = metrics.filter((metric) => metric.kind === 'run').map((metric) => metric.journal_ms!)
      return { p50: percentile(values, 50), p99: percentile(values, 99), runs: values.length }
    })(),
    steps_answered_from_the_journal: metrics.filter((metric) => metric.replayed).length,
    // Every agent::run call that returned, including deliveries of a run that had already ended.
    agent_run_calls_observed: runDurations.length,
    // From the burst sending the run to it ending, as the caller saw it.
    run_elapsed_ms: { p50: percentile(rows.map((row) => row.elapsed_ms), 50), p99: percentile(rows.map((row) => row.elapsed_ms), 99) },
  }
}

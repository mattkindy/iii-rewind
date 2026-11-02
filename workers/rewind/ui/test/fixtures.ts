// Small builders for the shapes the model reads, with every field a test doesn't care about filled in.
import type { Answer, Call, Fork, ForkOutcome, LostRun, RunRow } from '../src/client/types'
import type { Line, LineOutcome } from '../src/model/lines'

export function call(seq: number, function_id: string, answer: Answer = { value: {} }, extra: Partial<Call> = {}): Call {
  return { seq, function_id, worker: function_id.split('::')[0], effects: [], input: {}, answer, source: 'recorded', ...extra }
}

export function line(calls: Call[], outcome: LineOutcome = { state: 'done', output: {} }, extra: Partial<Line> = {}): Line {
  return { id: 'original', kind: 'original', label: 'Original', parent: null, branchAt: null, namespace: 'default', calls, outcome, lost: null, ...extra }
}

export function fork(calls: Call[], outcome: ForkOutcome, extra: Partial<Fork> = {}): Fork {
  return { fork_id: 'f1', run_id: 'run-1', parent: null, edit_at: null, namespace: 'rewind-f1', mode: 'debug', auto_read: false, calls, outcome, ...extra }
}

export function run(run_id: string, extra: Partial<RunRow> = {}): RunRow {
  return { run_id, status: 'success', input: {}, started_at_ms: 0, duration_ms: 100, calls: 0, ...extra }
}

export function lostRun(run_id: string, extra: Partial<LostRun> = {}): LostRun {
  return { ...run(run_id, { status: 'stopped' }), lost_at: 2, mid_call: true, recovery: null, ...extra }
}

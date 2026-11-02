/**
 * Lines up two runs of the same request call by call, by seq, and says what
 * changed in each row. Inputs are compared the way Rewind matches them:
 * without `_caller_worker_id`, as canonical JSON.
 */
import type { Call } from '../client/types'
import { type Cases, caseOf } from './cases'
import { errorDetail } from './format'
import type { Line, LineOutcome } from './lines'

export type Change = 'same' | 'answer' | 'input' | 'call' | 'added' | 'removed'

export type CompareRow = { seq: number; left?: Call; right?: Call; change: Change }

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== '_caller_worker_id')
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }

  return JSON.stringify(value) ?? 'undefined'
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

function changeOf(left: Call | undefined, right: Call | undefined): Change {
  if (!left) {
    return 'added'
  }

  if (!right) {
    return 'removed'
  }

  if (left.function_id !== right.function_id) {
    return 'call'
  }

  if (!sameJson(left.input, right.input)) {
    return 'input'
  }

  return sameJson(left.answer, right.answer) ? 'same' : 'answer'
}

export function compareLines(left: Line, right: Line): CompareRow[] {
  const seqs = [...new Set([...left.calls, ...right.calls].map((c) => c.seq))].sort((a, b) => a - b)
  return seqs.map((seq) => {
    const l = left.calls.find((c) => c.seq === seq)
    const r = right.calls.find((c) => c.seq === seq)
    return { seq, left: l, right: r, change: changeOf(l, r) }
  })
}

/**
 * A line's ending as JSON, for the diff. A fork's crash comes back through the
 * SDK with the code in front of the message and the recording's does not, so
 * the message is compared without it.
 */
const OUTCOME_JSON: Cases<LineOutcome, unknown> = {
  done: ({ output }) => ({ returned: output }),
  crashed: ({ error }) => ({ threw: { code: error.code, message: errorDetail(error.message) } }),
  stopped: ({ error, output }) => ({ stopped: error ?? 'invocation_stopped', returned: output }),
  paused: ({ need }) => ({ paused_at: need }),
}

export function outcomeJson(outcome: LineOutcome): unknown {
  return caseOf(outcome, 'state', OUTCOME_JSON)
}

export function countChanges(rows: CompareRow[]): number {
  return rows.filter((r) => r.change !== 'same').length
}

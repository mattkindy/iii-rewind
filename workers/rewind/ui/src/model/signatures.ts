/**
 * How a run failed, for grouping the run list. Two runs share a signature when
 * they failed the same way, so a group's count says how often a bug happens.
 *
 * A thrown error and a stopped worker show on the run row. A tool that failed
 * or a call sent twice only show in the run's calls, so the page reads the
 * calls of runs the `failed` filter matched and keeps them as `notable`.
 */
import type { Call, ErrorValue, RunRow } from '../client/types'
import { errorLabel, errorName, isError, isRepeatedCall } from './answers'
import { returnedFailed } from './appOutput'
import { errorDetail, truncate } from './format'

export type NotableCall = { seq: number; function_id: string; error?: ErrorValue; repeated?: boolean }

/** A run row with what the page learned from its calls, when it looked. */
export type TriageRow = RunRow & { notable?: NotableCall[] }

export type SignatureKind = 'stopped' | 'crash' | 'repeat' | 'tool' | 'failed' | 'ok'

export type Signature = { kind: SignatureKind; key: string; label: string }

export type Tone = 'alert' | 'warn' | 'ink' | 'ok'

type KindInfo = { rank: number; tone: Tone; attention: boolean }

export const KINDS: Record<SignatureKind, KindInfo> = {
  crash: { rank: 0, tone: 'alert', attention: true },
  repeat: { rank: 1, tone: 'warn', attention: true },
  tool: { rank: 2, tone: 'warn', attention: true },
  failed: { rank: 3, tone: 'warn', attention: true },
  stopped: { rank: 4, tone: 'ink', attention: true },
  ok: { rank: 5, tone: 'ok', attention: false },
}

const STOPPED_MARK = 'invocation_stopped'

export function isStopped(run: RunRow): boolean {
  return run.status === 'stopped' || Boolean(run.error?.message.includes(STOPPED_MARK))
}

export function succeeded(run: RunRow): boolean {
  return run.status === 'success'
}

export function notableCalls(calls: Call[]): NotableCall[] {
  return calls.flatMap((call): NotableCall[] => {
    if (isRepeatedCall(call)) {
      return [{ seq: call.seq, function_id: call.function_id, repeated: true }]
    }

    return isError(call.answer) ? [{ seq: call.seq, function_id: call.function_id, error: call.answer.error }] : []
  })
}

function toolSignature(call: NotableCall & { error: ErrorValue }): Signature {
  const name = errorName(call.error)
  // Without a class name, the message itself tells two failures apart.
  const key = `tool:${call.function_id}:${name ?? truncate(errorDetail(call.error.message), 40)}`
  return { kind: 'tool', key, label: name ? `${name} in ${call.function_id}` : `${call.function_id} failed` }
}

/**
 * How a run failed, worst reason first: a stopped worker, a thrown error by
 * its class, a call the caller sent twice, a tool error by function and
 * class, or the sample app's `failed` status. The key groups runs that failed
 * the same way, and the label names the group on the landing.
 */
export function signatureOf(run: TriageRow): Signature {
  if (isStopped(run)) {
    return { kind: 'stopped', key: 'stopped', label: 'Stopped when a worker died' }
  }

  if (run.status === 'error') {
    const name = run.error ? errorLabel(run.error) : 'an error'
    return { kind: 'crash', key: `crash:${name}`, label: `Threw ${name}` }
  }

  const repeated = run.notable?.find((n) => n.repeated)
  if (repeated) {
    return { kind: 'repeat', key: `repeat:${repeated.function_id}`, label: `${repeated.function_id} ran twice` }
  }

  const toolError = run.notable?.find((n): n is NotableCall & { error: ErrorValue } => Boolean(n.error))
  if (toolError) {
    return toolSignature(toolError)
  }

  if (returnedFailed(run.output)) {
    return { kind: 'failed', key: 'failed', label: 'Returned failed' }
  }

  return { kind: 'ok', key: 'ok', label: 'Succeeded' }
}

export type RunGroup = { signature: Signature; runs: TriageRow[] }

const EXPLAIN: Record<SignatureKind, (newest: TriageRow) => string | undefined> = {
  crash: (run) => (run.error ? `“${truncate(errorDetail(run.error.message), 80)}”` : 'No message'),
  repeat: () => 'Caller timed out and retried',
  tool: (run) => {
    const failed = run.notable?.find((n) => n.error)
    return failed?.error ? `${failed.function_id} · “${truncate(errorDetail(failed.error.message), 72)}”` : 'Tool call failed'
  },
  failed: () => 'Returned failed · no call errors',
  stopped: () => 'Worker died mid-run',
  ok: () => undefined,
}

/** One short line about a group, from its newest run, or undefined when the label says it all. */
export function explainGroup(group: RunGroup): string | undefined {
  return EXPLAIN[group.signature.kind](group.runs[0])
}

/** Groups in order of how bad they are, then how often they happen; runs newest first. */
export function groupRuns(runs: TriageRow[]): RunGroup[] {
  const groups = new Map<string, RunGroup>()
  for (const run of runs) {
    const signature = signatureOf(run)
    const group = groups.get(signature.key) ?? { signature, runs: [] }
    group.runs.push(run)
    groups.set(signature.key, group)
  }

  for (const group of groups.values()) {
    group.runs.sort((a, b) => b.started_at_ms - a.started_at_ms)
  }

  return [...groups.values()].sort(
    (a, b) => KINDS[a.signature.kind].rank - KINDS[b.signature.kind].rank || b.runs.length - a.runs.length,
  )
}

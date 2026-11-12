/**
 * Durable runs that wait on a pending step, grouped by what they wait for, so the landing has one
 * row per question a person may have to answer. Waits group by their name, calls a crash cut off
 * by their function, and every sleep goes in one group, since a sleep wakes on its own. Calls cut
 * off come first, because nothing else will ever move them.
 */
import type { Pending, PendingKind, ResolveRequest, Settled, WaitingRun } from '../client/journalClient'
import { outputReply, outputStatus } from './appOutput'
import { plural, truncate } from './format'

export type WaitGroup = { key: string; kind: PendingKind; title: string; runs: WaitingRun[] }

/** One way a person can resolve a pending step. A typed answer asks for its value first. */
export type Answer = { label: string; request: Omit<ResolveRequest, 'workflow_id' | 'step'>; primary: boolean; typed: boolean }

const RANK: Record<PendingKind, number> = { lost: 0, wait: 1, sleep: 2 }

const KEY: Record<PendingKind, (pending: Pending) => string> = {
  wait: (pending) => `wait:${pending.name}`,
  sleep: () => 'sleep',
  lost: (pending) => `lost:${pending.function_id}`,
}

const TITLE: Record<PendingKind, (pending: Pending) => string> = {
  wait: (pending) => `Waiting for ${pending.name}`,
  sleep: () => 'Sleeping',
  lost: (pending) => `Cut off mid-call · ${pending.function_id}`,
}

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** "40s", "26m" or "3h 05m": precise enough for a deadline, without the seconds past a minute. */
export function roughDuration(ms: number): string {
  if (ms < MINUTE) {
    return `${Math.max(0, Math.round(ms / SECOND))}s`
  }

  if (ms < HOUR) {
    return `${Math.round(ms / MINUTE)}m`
  }

  const minutes = Math.round((ms % HOUR) / MINUTE)
  return `${Math.floor(ms / HOUR)}h ${String(minutes).padStart(2, '0')}m`
}

/** "in 26m" for a time ahead, "26m ago" for one behind. */
export function fromNow(at: number, now: number): string {
  return at >= now ? `in ${roughDuration(at - now)}` : `${roughDuration(now - at)} ago`
}

export function groupKey(pending: Pending): string {
  return KEY[pending.kind](pending)
}

export function pendingTitle(pending: Pending): string {
  return TITLE[pending.kind](pending)
}

/** Waiting runs by what they wait for, cut-off calls first, then the group that has waited longest. Oldest run first in each. */
export function waitGroups(runs: WaitingRun[]): WaitGroup[] {
  const groups = new Map<string, WaitGroup>()
  for (const run of [...runs].sort((a, b) => a.pending.since_ms - b.pending.since_ms)) {
    const key = groupKey(run.pending)
    const group = groups.get(key) ?? { key, kind: run.pending.kind, title: pendingTitle(run.pending), runs: [] }
    group.runs.push(run)
    groups.set(key, group)
  }

  return [...groups.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.runs[0].pending.since_ms - b.runs[0].pending.since_ms)
}

function soonest(times: (number | undefined)[]): number | undefined {
  const known = times.filter((time): time is number => time !== undefined)
  return known.length > 0 ? Math.min(...known) : undefined
}

const GROUP_DETAIL: Record<PendingKind, (group: WaitGroup, now: number) => string> = {
  wait: (group, now) => {
    const timeout = soonest(group.runs.map((run) => run.pending.timeout_at_ms))
    const oldest = `oldest ${fromNow(group.runs[0].pending.since_ms, now)}`
    return [plural(group.runs.length, 'run'), oldest, timeout === undefined ? '' : `first times out ${fromNow(timeout, now)}`].filter(Boolean).join(' · ')
  },
  sleep: (group, now) => {
    const wake = soonest(group.runs.map((run) => run.pending.wake_at_ms))
    return [plural(group.runs.length, 'run'), wake === undefined ? '' : `next wakes ${fromNow(wake, now)}`].filter(Boolean).join(' · ')
  },
  lost: (group) => `${plural(group.runs.length, 'run')} · may have done its work`,
}

/** The landing row's second line, such as "3 runs · oldest 4m ago · first times out in 26m". */
export function groupDetail(group: WaitGroup, now: number): string {
  return GROUP_DETAIL[group.kind](group, now)
}

const RUN_LINE: Record<PendingKind, (pending: Pending, now: number) => string> = {
  wait: (pending, now) => [`Since ${fromNow(pending.since_ms, now)}`, pending.timeout_at_ms === undefined ? 'no timeout' : `times out ${fromNow(pending.timeout_at_ms, now)}`].join(' · '),
  sleep: (pending, now) => `Wakes ${pending.wake_at_ms === undefined ? 'soon' : fromNow(pending.wake_at_ms, now)}`,
  lost: (pending, now) => `Cut off ${fromNow(pending.since_ms, now)} · may have done its work`,
}

/** One run's line in its group, such as "Since 4m ago · times out in 26m". */
export function runLine(run: WaitingRun, now: number): string {
  return RUN_LINE[run.pending.kind](run.pending, now)
}

/** The call a wait is about, when its detail is one: `{ function_id, input }`. */
export function aboutCall(detail: unknown): { functionId: string; input: unknown } | undefined {
  const record = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : undefined
  return typeof record?.function_id === 'string' ? { functionId: record.function_id, input: record.input } : undefined
}

const ANSWERS: Record<PendingKind, (pending: Pending) => Answer[]> = {
  wait: (pending) =>
    pending.choices && pending.choices.length > 0
      ? pending.choices.map((choice, index) => ({ label: choice.label, request: { value: choice.value }, primary: index === 0, typed: false }))
      : [{ label: 'Resolve', request: {}, primary: true, typed: true }],
  sleep: () => [{ label: 'Wake now', request: {}, primary: true, typed: false }],
  lost: () => [
    { label: 'Send again', request: { action: 'execute' }, primary: false, typed: false },
    { label: 'Enter its result', request: {}, primary: false, typed: true },
  ],
}

/** What a person can resolve a pending step with: the wait's choices, a value of their own, waking a sleep, or deciding about a cut-off call. */
export function answersFor(pending: Pending): Answer[] {
  return ANSWERS[pending.kind](pending)
}

const AFTER: Record<Settled['status'], (settled: Settled) => string> = {
  running: () => 'Running',
  waiting: (settled) => (settled.pending ? `Waiting again · ${pendingTitle(settled.pending).replace(/^Waiting for /, '')}` : 'Waiting again'),
  done: (settled) => {
    const status = outputStatus(settled.output)
    const reply = outputReply(settled.output)
    return [status ? `Run ${status}` : 'Run done', reply ? truncate(reply, 90) : ''].filter(Boolean).join(' · ')
  },
  failed: (settled) => `Run failed · ${settled.error?.message ?? 'no message'}`,
}

/** How the run went on after a person resolved it, or "Resumed" while the journal has nothing newer. */
export function afterLine(settled: Settled | null): string {
  return settled ? AFTER[settled.status](settled) : 'Resumed'
}

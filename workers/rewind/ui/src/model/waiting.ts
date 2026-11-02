/**
 * Recoveries paused at an irreversible call, grouped so a person decides once
 * per group instead of once per run. A run paused at a call its worker died
 * while running may already have reached the provider, so nobody knows
 * whether it went out. Any other pause is a call that never went out: one
 * the recovery reached afterwards, or one that failed with function_not_found
 * because its worker was already gone. Each group has one function, so its
 * effects decide what the page offers and whether it preselects anything.
 */
import type { Choice, LostRun, PausedNeed } from '../client/types'
import { blockedReason, pauseReason } from './choices'

export type WaitingKind = 'lost' | 'unsent'

export type WaitingRun = { run: LostRun; forkId: string; need: PausedNeed }

export type WaitingGroup = { key: string; kind: WaitingKind; functionId: string; effects: string[]; runs: WaitingRun[] }

/** One decision for every run in a group, or `per-run` to answer each run on its own. */
export type GroupChoice = 'mark-sent' | 'resend' | 'send' | 'skip' | 'per-run'

/** How a choice is applied to each run in turn. */
export type GroupApply = {
  /** What `rewind::answer` gets for each run. */
  answer: Choice
  /** Progress, as in "Marking sent 2/3". */
  doing: string
  /** The result, as in "3/3 marked sent". */
  done: string
  /** The button that applies it, as in "Mark 3 sent". */
  button: (count: number) => string
  /** What one run's turn does with the group's call, as in "Sending email::send again, then running the rest". */
  step: (call: string) => string
}

/** `apply` is null for the choice that sends each run to its own page instead. */
export const GROUP_CHOICES: Record<GroupChoice, { title: string; apply: GroupApply | null }> = {
  'mark-sent': {
    title: 'Mark all sent',
    apply: { answer: 'typed', doing: 'Marking sent', done: 'marked sent', button: (n) => `Mark ${n} sent`, step: (call) => `Giving ${call} its recorded result, then running the rest` },
  },
  resend: { title: 'Resend all', apply: { answer: 'live', doing: 'Resending', done: 'resent', button: (n) => `Resend ${n}`, step: (call) => `Sending ${call} again, then running the rest` } },
  send: { title: 'Send all', apply: { answer: 'live', doing: 'Sending', done: 'sent', button: (n) => `Send ${n}`, step: (call) => `Sending ${call}, then running the rest` } },
  skip: { title: 'Skip all', apply: { answer: 'stop', doing: 'Skipping', done: 'skipped', button: (n) => `Skip ${n}`, step: () => 'Discarding the recovery' } },
  'per-run': { title: 'Choose per run', apply: null },
}

type KindInfo = { title: string; note: string; choices: GroupChoice[]; preset: GroupChoice }

export const WAITING_KINDS: Record<WaitingKind, KindInfo> = {
  lost: { title: 'Interrupted mid-send', note: 'the provider may have it', choices: ['mark-sent', 'resend', 'skip', 'per-run'], preset: 'mark-sent' },
  unsent: { title: 'Not sent yet', note: 'reached during recovery', choices: ['send', 'skip', 'per-run'], preset: 'send' },
}

const KIND_ORDER: WaitingKind[] = ['lost', 'unsent']

/** A lost call that can't be undone was a send; one that writes, or declares nothing, was cut off mid-call. */
export function groupTitle(group: Pick<WaitingGroup, 'kind' | 'effects'>): string {
  if (group.kind === 'lost' && !group.effects.includes('irreversible')) {
    return 'Interrupted mid-call'
  }

  return WAITING_KINDS[group.kind].title
}

export function waitingKind(need: PausedNeed, lostAt: number): WaitingKind {
  return pauseReason(need, need.seq === lostAt) === 'lost' ? 'lost' : 'unsent'
}

function waitingRun(run: LostRun): WaitingRun | null {
  const recovery = run.recovery
  if (!recovery || recovery.outcome.state !== 'paused') {
    return null
  }

  return { run, forkId: recovery.fork_id, need: recovery.outcome.need }
}

export function groupKey(kind: WaitingKind, functionId: string): string {
  return `${kind}:${functionId}`
}

/** Lost sends before unsent ones, for sorting groups. */
export function byKind(a: Pick<WaitingGroup, 'kind'>, b: Pick<WaitingGroup, 'kind'>): number {
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
}

/** The paused recoveries among these runs, lost sends first, keeping the runs' order. */
export function waitingGroups(runs: LostRun[]): WaitingGroup[] {
  const groups = new Map<string, WaitingGroup>()
  for (const waiting of runs.map(waitingRun)) {
    if (!waiting) {
      continue
    }

    const kind = waitingKind(waiting.need, waiting.run.lost_at)
    const key = groupKey(kind, waiting.need.function_id)
    const group = groups.get(key) ?? { key, kind, functionId: waiting.need.function_id, effects: waiting.need.effects, runs: [] }
    group.runs.push(waiting)
    groups.set(key, group)
  }

  return [...groups.values()].sort(byKind)
}

/** What the group starts on. Nothing, when its function declares no effects. */
export function presetChoice(group: Pick<WaitingGroup, 'kind' | 'effects'>): GroupChoice | null {
  if (group.effects.length === 0) {
    return null
  }

  return WAITING_KINDS[group.kind].preset
}

/** Why a choice can't apply to every run in the group, or undefined when it can. */
export function groupBlockedReason(choice: GroupChoice, group: WaitingGroup): string | undefined {
  const apply = GROUP_CHOICES[choice].apply
  if (!apply) {
    return undefined
  }

  return group.runs.map((w) => blockedReason(apply.answer, w.need)).find(Boolean)
}

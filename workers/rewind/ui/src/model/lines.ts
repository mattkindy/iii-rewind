/**
 * A line is one way the run went: the recording (fork zero), a replay of it, a
 * fork with a changed answer, or a recovery. The page draws every line the same
 * way, so they share one model here, built from `rewind::run` and
 * `rewind::fork-get`. Seq numbers come from the core and may start at 0, so
 * anything shown to a person uses a call's position in its line instead.
 */
import type { Call, ErrorValue, Fork, PausedNeed, RunDetail } from '../client/types'
import { isError, isRepeatedCall } from './answers'
import type { LostMark } from './lost'
import { isRequestId } from './requests'
import { isStopped, succeeded } from './signatures'

export type LineOutcome =
  | { state: 'done'; output: unknown }
  | { state: 'crashed'; error: ErrorValue }
  | { state: 'paused'; need: PausedNeed }
  | { state: 'stopped'; error?: ErrorValue; output?: unknown }

export type LineKind = 'original' | 'replay' | 'fork' | 'recovery'

export type Line = {
  id: string
  kind: LineKind
  label: string
  parent: string | null
  /** The first seq that differs from the parent line; null when the line differs nowhere. */
  branchAt: number | null
  namespace: string
  calls: Call[]
  outcome: LineOutcome
  /** On a stopped original, where the lost call would have been and how it was lost. */
  lost: LostMark | null
  fork?: Fork
}

/** Where the cursor can be: one call by seq, or the run's ending. */
export type Cursor = 'end' | number

export const ORIGINAL = 'original'

function originalOutcome(detail: RunDetail): LineOutcome {
  const { run } = detail
  if (isStopped(run)) {
    return { state: 'stopped', error: run.error, output: run.output }
  }

  if (!succeeded(run)) {
    return { state: 'crashed', error: run.error ?? { message: `Ended with status ${run.status}` } }
  }

  return { state: 'done', output: run.output }
}

/**
 * The seq where a fork leaves the line it came from: its edit, or for a replay
 * or a recovery, which have no edit, its first answer that did not come from
 * the recording, then the call it paused at, or null when it differs nowhere.
 */
export function branchOf(fork: Fork): number | null {
  if (fork.edit_at !== null) {
    return fork.edit_at
  }

  const firstNew = fork.calls.find((c) => c.source !== 'recorded')
  if (firstNew) {
    return firstNew.seq
  }

  return fork.outcome.state === 'paused' ? fork.outcome.need.seq : null
}

const KIND_LABEL: Record<Exclude<LineKind, 'original'>, string> = { replay: 'Replay', fork: 'Fork', recovery: 'Recovery' }

function kindOf(fork: Fork): Exclude<LineKind, 'original'> {
  if (fork.mode === 'recover') {
    return 'recovery'
  }

  return fork.edit_at === null ? 'replay' : 'fork'
}

/**
 * The recording first, then each fork in the order it was made, with calls
 * sorted by seq. Forks are numbered per kind: "Fork 1", "Fork 2", while a lone
 * replay or recovery is "Replay" or "Recovery". `lost` marks where a dead
 * worker cost the recording its call, for a stopped run.
 */
export function buildLines(detail: RunDetail, forks: Fork[], lost: LostMark | null = null): Line[] {
  const original: Line = {
    id: ORIGINAL,
    kind: 'original',
    label: 'Original',
    parent: null,
    branchAt: null,
    namespace: 'default',
    calls: [...detail.calls].sort((a, b) => a.seq - b.seq),
    outcome: originalOutcome(detail),
    lost,
  }
  const created = new Map(detail.forks.map((f) => [f.fork_id, f.created_at_ms ?? 0]))
  const ordered = [...forks].sort((a, b) => (created.get(a.fork_id) ?? 0) - (created.get(b.fork_id) ?? 0))
  const counts: Record<string, number> = {}
  const forkLines = ordered.map((fork): Line => {
    const kind = kindOf(fork)
    counts[kind] = (counts[kind] ?? 0) + 1
    const number = counts[kind]
    return {
      id: fork.fork_id,
      kind,
      label: kind === 'fork' || number > 1 ? `${KIND_LABEL[kind]} ${number}` : KIND_LABEL[kind],
      parent: fork.parent ?? ORIGINAL,
      branchAt: branchOf(fork),
      namespace: fork.namespace,
      calls: [...fork.calls].sort((a, b) => a.seq - b.seq),
      outcome: fork.outcome,
      lost: null,
      fork,
    }
  })
  return [original, ...forkLines]
}

/** The cursor positions of a line, top to bottom. */
export function positions(line: Line): Cursor[] {
  const seqs: Cursor[] = line.calls.map((c) => c.seq)
  if (line.outcome.state === 'paused') {
    return [...seqs, line.outcome.need.seq]
  }

  return [...seqs, 'end']
}

/** The lines a person made or needs: a replay with no edit is an action on the original, not a branch. */
export function branchLines(lines: Line[]): Line[] {
  return lines.filter((l) => l.kind !== 'replay')
}

export function latestReplay(lines: Line[]): Line | undefined {
  return lines.filter((l) => l.kind === 'replay').at(-1)
}

export function step(line: Line, cursor: Cursor, by: 1 | -1): Cursor {
  const all = positions(line)
  const index = Math.max(0, all.indexOf(cursor))
  return all[Math.min(all.length - 1, Math.max(0, index + by))]
}

export function clampCursor(line: Line, cursor: Cursor | null): Cursor | null {
  if (cursor === null) {
    return null
  }

  return positions(line).includes(cursor) ? cursor : null
}

/** A call's place in its line, counting from 1, for anything a person reads. */
export function ordinal(line: Line, seq: number): number {
  const index = line.calls.findIndex((c) => c.seq === seq)
  return index >= 0 ? index + 1 : line.calls.filter((c) => c.seq < seq).length + 1
}

/**
 * The call right before the failure, which is where a person should look
 * first. A repeated call is its own cause, because the timeout the caller saw
 * is what made it send the call again.
 */
export function likelyCause(line: Line): Cursor {
  if (line.outcome.state === 'paused') {
    return line.outcome.need.seq
  }

  // A stopped run has no cause in its calls; its ending says where to go next.
  if (line.kind !== 'original' || line.outcome.state === 'stopped') {
    return 'end'
  }

  const repeated = line.calls.find(isRepeatedCall)
  if (repeated) {
    return repeated.seq
  }

  // A request around iii, such as the agent's fetch, doesn't decide what the next call is sent.
  const failedIndex = line.calls.findIndex((c) => isError(c.answer))
  const before = line.calls.slice(0, Math.max(0, failedIndex)).filter((c) => !isRequestId(c.function_id))
  if (failedIndex > 0 && before.length > 0) {
    return before[before.length - 1].seq
  }

  if (failedIndex === 0 || line.outcome.state !== 'done') {
    return line.calls.at(-1)?.seq ?? 'end'
  }

  return 'end'
}

export function callAt(line: Line, seq: number): Call | undefined {
  return line.calls.find((c) => c.seq === seq)
}

/** The next iii call after this one, passing over requests around iii, which the agent makes on its own. */
export function nextCall(line: Line, call: Call): Call | undefined {
  return line.calls.find((c) => c.seq > call.seq && !isRequestId(c.function_id))
}

export function lineById(lines: Line[], id: string): Line {
  return lines.find((l) => l.id === id) ?? lines[0]
}

export function pausedNeed(line: Line): PausedNeed | undefined {
  return line.outcome.state === 'paused' ? line.outcome.need : undefined
}

export function answersFromRecording(line: Line): number {
  return line.calls.filter((c) => c.source === 'recorded').length
}

export type CalledFunction = { functionId: string; effects: string[] }

/** Every function the run's lines call or paused at, in the order they first come up. */
export function functionsCalled(lines: Line[]): CalledFunction[] {
  const seen = new Map<string, CalledFunction>()
  const add = (functionId: string, effects: string[]) => {
    if (!seen.has(functionId)) {
      seen.set(functionId, { functionId, effects })
    }
  }

  for (const line of lines) {
    for (const call of line.calls) {
      add(call.function_id, call.effects)
    }

    const need = pausedNeed(line)
    if (need) {
      add(need.function_id, need.effects)
    }
  }

  return [...seen.values()]
}

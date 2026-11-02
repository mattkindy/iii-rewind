/**
 * Which call a dead worker took with it. Observers never report that call, but
 * the run's output usually mentions it: the agent passes the tool's error to
 * the model and often returns it, as in "calendar::find-slot failed:
 * invocation_stopped". A call made while compose was restarting the worker
 * fails with function_not_found, and the engine's message after that code says
 * which function it was. The page reads the function from that text, and the
 * worker from the function list, so the landing can say which worker stopped.
 */
import type { ForkSummary, FunctionRow, LostRun, RunRow } from '../client/types'
import { clockTime, dayAndTime, plural } from './format'

/** What recovering a run does, under the incident's heading and on every Recover button. */
export const RECOVER_LINE = 'Replays calls that finished · runs read-only calls live · asks before the rest'

const NEAR_STOPPED =/([a-z0-9_.-]+::[a-z0-9_.:-]+?)\W{1,12}(?:failed:\s*)?(?:\w+:\s*)?(?:invocation_stopped|function_not_found)/i

// A run that threw the error has only the engine's message, with nothing before the code.
const NOT_FOUND_MESSAGE = /function_not_found:\s*Function\s+([a-z0-9_.-]+::[a-z0-9_.:-]+)\s+not found/i

/**
 * How a run lost its call: the worker died while it ran the call, which may
 * have reached its provider, or the worker was already gone, so the call
 * failed with function_not_found and never ran.
 */
export type LostKind = 'mid-call' | 'not-found'

/** Where a stopped run lost its call, and how. */
export type LostMark = { at: number; kind: LostKind }

// An older core sends no mid_call, and its recoveries treat every lost call as cut off mid-call.
export function lostMark(run: Pick<LostRun, 'lost_at' | 'mid_call'>): LostMark {
  return { at: run.lost_at, kind: run.mid_call === false ? 'not-found' : 'mid-call' }
}

/** What the run view says about a lost call: a headline, and the marker in the call list with its label. */
export const LOST_CALL: Record<LostKind, { headline: string; marker: string; markerLabel: string }> = {
  'mid-call': { headline: 'Worker stopped mid-call', marker: 'Interrupted call · worker stopped', markerLabel: 'A call was interrupted here when its worker stopped' },
  'not-found': { headline: 'Call not found · worker was down', marker: 'Call not found · worker was down', markerLabel: 'A call failed here because its worker was down' },
}

/**
 * How far a lost run's recovery got: paused at a call and waiting for
 * someone, finished, not started yet, or skipped. The core deletes a recovery
 * someone skips, which makes the run look unrecovered again, so the page keeps
 * which runs were skipped while it is open and passes them in.
 */
export type LostState = 'waiting' | 'open' | 'done' | 'skipped'

const NO_SKIPS: ReadonlySet<string> = new Set()

export function recoveryState(recovery: Pick<ForkSummary, 'outcome'> | null | undefined, skipped: boolean): LostState {
  if (!recovery) {
    return skipped ? 'skipped' : 'open'
  }

  return recovery.outcome.state === 'paused' ? 'waiting' : 'done'
}

export function lostState(lost: LostRun, skipped: ReadonlySet<string> = NO_SKIPS): LostState {
  return recoveryState(lost.recovery, skipped.has(lost.run_id))
}

/** Finished or deliberately skipped, so nothing about the run waits on anyone. */
export function settled(lost: LostRun, skipped?: ReadonlySet<string>): boolean {
  const state = lostState(lost, skipped)
  return state === 'done' || state === 'skipped'
}

/**
 * The function whose call the run lost, read from its output or error, such
 * as `calendar::find-slot` from "calendar::find-slot failed:
 * invocation_stopped". Undefined when neither mentions one.
 */
export function stoppedFunction(run: Pick<RunRow, 'output' | 'error'>): string | undefined {
  const text = JSON.stringify([run.error ?? null, run.output ?? null])
  return NEAR_STOPPED.exec(text)?.[1] ?? NOT_FOUND_MESSAGE.exec(text)?.[1]
}

function workerLost(run: Pick<RunRow, 'output' | 'error'>, functions: FunctionRow[]): string | undefined {
  const fn = stoppedFunction(run)
  return fn ? functions.find((f) => f.function_id === fn)?.worker : undefined
}

/** The one worker every one of these runs lost a call to, or undefined when it differs or is unknown. */
export function stoppedWorker(runs: Pick<RunRow, 'output' | 'error'>[], functions: FunctionRow[]): string | undefined {
  const workers = new Set(runs.map((run) => workerLost(run, functions)))
  const [only] = [...workers]
  return workers.size === 1 ? only : undefined
}

/**
 * Runs one dead worker cut off at one time. Runs end a moment after their lost
 * call, so runs that lost a call to the same worker and ended within a few
 * seconds of each other count as one incident. The key is the incident's
 * oldest run, which stays the same while newer runs join it.
 */
export type Incident = { key: string; worker: string | undefined; runs: LostRun[]; at: number }

const INCIDENT_GAP_MS = 5_000

function endedAt(run: { started_at_ms: number; duration_ms: number }): number {
  return run.started_at_ms + run.duration_ms
}

/** Lost runs as incidents, newest first, with each incident's runs newest first. */
export function lostIncidents(lost: LostRun[], functions: FunctionRow[]): Incident[] {
  const byWorker = new Map<string, LostRun[]>()
  for (const run of lost) {
    const worker = workerLost(run, functions) ?? ''
    byWorker.set(worker, [...(byWorker.get(worker) ?? []), run])
  }

  const incidents: Incident[] = []
  for (const [worker, runs] of byWorker) {
    const ordered = [...runs].sort((a, b) => endedAt(a) - endedAt(b))
    let current: LostRun[] = []
    for (const run of ordered) {
      const last = current.at(-1)
      if (last && endedAt(run) - endedAt(last) > INCIDENT_GAP_MS) {
        incidents.push(incidentOf(worker, current))
        current = []
      }

      current.push(run)
    }

    if (current.length > 0) {
      incidents.push(incidentOf(worker, current))
    }
  }

  return incidents.sort((a, b) => b.at - a.at)
}

function incidentOf(worker: string, oldestFirst: LostRun[]): Incident {
  return { key: oldestFirst[0].run_id, worker: worker || undefined, runs: [...oldestFirst].reverse(), at: endedAt(oldestFirst.at(-1)!) }
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

/** "tools stopped 15:04", with the day when it was not today. */
function stoppedAt(incident: Incident, now: number): string {
  const when = sameDay(incident.at, now) ? clockTime(incident.at) : dayAndTime(incident.at)
  return `${incident.worker ?? 'a worker'} stopped ${when}`
}

/** "12 runs interrupted · tools stopped 15:04". `count` is the number to show. */
export function incidentHeadline(incident: Incident, count = incident.runs.length, now = Date.now()): string {
  return `${plural(count, 'run')} interrupted · ${stoppedAt(incident, now)}`
}

/** "12 runs · tools stopped 15:04", for a row under a heading that already says interrupted. */
export function incidentRowLabel(incident: Incident, count = incident.runs.length, now = Date.now()): string {
  return `${plural(count, 'run')} · ${stoppedAt(incident, now)}`
}

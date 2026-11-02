/**
 * One action applied to several runs in turn: Recover all, or one group's
 * decision. The page keeps an entry per run, so it can show each run waiting,
 * running and how it ended while the rest go on. Rewind sends nothing until a
 * run is done, so a running entry says what the page knew before it started:
 * the recorded calls a recovery replays and the call it picks up at, or the
 * call a decision gives a result to.
 */
import { type ForkOutcome, type LostRun, STOPPED_FORK_CODE } from '../client/types'
import { plural } from './format'
import { stoppedFunction } from './lost'
import { callName } from './requests'

export type BatchStep =
  | { state: 'waiting' }
  | { state: 'running'; startedAt: number }
  | { state: 'landed'; outcome: ForkOutcome }
  | { state: 'failed'; error: string }

/** `doing` is what this run's turn does, as in "Replaying 3 calls, then picking up at calendar::find-slot". */
export type BatchEntry = { runId: string; request: string; doing: string } & BatchStep

/** `verb` leads the progress, as in "Recovering 2/5". */
export type Batch = { verb: string; entries: BatchEntry[] }

/**
 * How many runs a batch works on at once. Each one starts its own copy of the agent, and the
 * rest of its calls land live on a worker that compose restarted moments ago, so the batch stays small.
 */
export const BATCH_PARALLEL = 4

export function newBatch(verb: string, entries: Omit<BatchEntry, keyof BatchStep>[]): Batch {
  return { verb, entries: entries.map((entry) => ({ ...entry, state: 'waiting' })) }
}

/** The batch with one run moved on to `step`. */
export function withStep(batch: Batch, runId: string, step: BatchStep): Batch {
  const entries = batch.entries.map((entry) => (entry.runId === runId ? { runId, request: entry.request, doing: entry.doing, ...step } : entry))
  return { ...batch, entries }
}

/** A run Skip all ended. It has no outcome of its own to count. */
export function skippedOutcome(outcome: ForkOutcome): boolean {
  return outcome.state === 'crashed' && outcome.error.code === STOPPED_FORK_CODE
}

export function finishedCount(batch: Batch): number {
  return batch.entries.filter((entry) => entry.state === 'landed' || entry.state === 'failed').length
}

/** "Recovering 2/5", counting the runs that have finished. */
export function batchHeadline(batch: Batch): string {
  return `${batch.verb} ${finishedCount(batch)}/${batch.entries.length}`
}

/** What the run's turn in Recover all does, from where its worker stopped. */
export function recoveryStep(run: Pick<LostRun, 'lost_at' | 'output' | 'error'>): string {
  const stopped = stoppedFunction(run)
  if (run.lost_at === 0) {
    return stopped ? `Picking up at ${callName(stopped)}` : 'Running from the start'
  }

  const replay = `Replaying ${plural(run.lost_at, 'call')}`
  return stopped ? `${replay}, then picking up at ${callName(stopped)}` : `${replay}, then picking up where it stopped`
}

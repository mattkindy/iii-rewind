/**
 * A batch while it runs: how far it has got, a bar with one segment per run
 * that fills as each run finishes, a tally of how the finished runs ended, and
 * each run with what it is doing now or how it ended. A run that finishes
 * lands with a short animation, and nothing moves with reduced motion.
 */
import { List, ListItem, StatusPanel, uiClasses } from '@iii-dev/console-ui'
import type { LucideIcon } from 'lucide-react'
import { Circle, CircleAlert, CircleCheck, CircleMinus, CirclePause, CircleX, LoaderCircle } from 'lucide-react'
import type { ForkOutcome } from '../client/types'
import { returnedFailed } from '../model/appOutput'
import { type Batch, type BatchEntry, batchHeadline, finishedCount, skippedOutcome } from '../model/batch'
import { type Cases, caseOf } from '../model/cases'
import { outcomeTally, tallyWord } from '../model/outcomes'
import { useNow } from './motion'

type Tone = 'ink' | 'accent' | 'ok' | 'warn' | 'alert'

type Look = { icon: LucideIcon; tone: Tone; note: string }

const TICK_MS = 100

const LANDED: Cases<ForkOutcome, Look> = {
  done: (o) => ({ icon: CircleCheck, tone: returnedFailed(o.output) ? 'warn' : 'ok', note: tallyWord(o) }),
  paused: (o) => ({ icon: CirclePause, tone: 'warn', note: tallyWord(o) }),
  crashed: (o) => (skippedOutcome(o) ? { icon: CircleMinus, tone: 'ink', note: 'skipped' } : { icon: CircleAlert, tone: 'alert', note: tallyWord(o) }),
}

const LOOKS: Cases<BatchEntry, Look> = {
  waiting: () => ({ icon: Circle, tone: 'ink', note: 'Waiting' }),
  running: (entry) => ({ icon: LoaderCircle, tone: 'accent', note: entry.doing }),
  landed: (entry) => caseOf(entry.outcome, 'state', LANDED),
  failed: (entry) => ({ icon: CircleX, tone: 'alert', note: entry.error }),
}

function lookOf(entry: BatchEntry): Look {
  return caseOf(entry, 'state', LOOKS)
}

/** Seconds since the running entry started, ticking. */
function Elapsed({ since }: { since: number }) {
  const now = useNow(TICK_MS)
  return (
    <span className="rw-progress-detail rw-mono" aria-hidden>
      {Math.max(0, (now - since) / 1000).toFixed(1)}s
    </span>
  )
}

function BatchBar({ batch }: { batch: Batch }) {
  const total = batch.entries.length
  const finished = finishedCount(batch)
  return (
    <div
      className="rw-batch-bar"
      role="progressbar"
      aria-label="Runs finished"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={finished}
      aria-valuetext={`${finished} of ${total} finished`}
    >
      {batch.entries.map((entry) => (
        <span key={entry.runId} data-step={entry.state} data-tone={lookOf(entry).tone} />
      ))}
    </div>
  )
}

function EntryRow({ entry }: { entry: BatchEntry }) {
  const look = lookOf(entry)
  const Icon = look.icon
  return (
    <ListItem
      as="div"
      className="rw-batch-row"
      data-step={entry.state}
      data-tone={look.tone}
      leading={<Icon aria-hidden className={entry.state === 'running' ? uiClasses.spin : undefined} />}
      label={<span className="rw-run-label">{entry.request}</span>}
      description={<span className="rw-batch-note">{look.note}</span>}
      trailing={entry.state === 'running' ? <Elapsed since={entry.startedAt} /> : undefined}
    />
  )
}

export function BatchProgress({ batch, label }: { batch: Batch; label: string }) {
  const landed = batch.entries.flatMap((entry) => (entry.state === 'landed' ? [entry.outcome] : []))
  const tally = outcomeTally(landed.filter((o) => !skippedOutcome(o)))
  return (
    <section className="rw-batch" aria-label={label}>
      <StatusPanel
        variant="info"
        role="status"
        icon={<LoaderCircle aria-hidden className={uiClasses.spin} />}
        headline={batchHeadline(batch)}
        detail={
          <span className="rw-batch-detail">
            <BatchBar batch={batch} />
            {tally ? <span className="rw-batch-tally">{tally}</span> : null}
          </span>
        }
      />
      <List aria-label={label} className="rw-batch-runs">
        {batch.entries.map((entry) => (
          <EntryRow key={entry.runId} entry={entry} />
        ))}
      </List>
    </section>
  )
}

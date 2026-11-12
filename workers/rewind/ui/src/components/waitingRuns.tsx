/**
 * The durable runs waiting on one thing, such as everyone waiting for approval, oldest first.
 * Each row is the request in the person's words with how long it has waited and when it times
 * out or wakes, and opens that run's question. The runs come from the journal, not the recording.
 */
import { List, ListItem, StatusDot, StatusPanel } from '@iii-dev/console-ui'
import { ChevronRight } from 'lucide-react'
import type { PendingKind } from '../client/journalClient'
import { requestText, shortId } from '../model/format'
import { runLine, type WaitGroup } from '../model/pending'
import { useNow } from './motion'

const TONE: Record<PendingKind, 'warn' | 'ink'> = { wait: 'warn', lost: 'warn', sleep: 'ink' }

const WHAT_RESOLVING_DOES: Record<PendingKind, string> = {
  wait: 'Each run goes on from where it waited once it gets its answer',
  sleep: 'Each run wakes on its own · Wake now starts it at once',
  lost: 'The worker died while each call was out · send it again or enter what it returned',
}

export function WaitingRuns({ group, onOpen }: { group: WaitGroup | undefined; onOpen: (workflowId: string) => void }) {
  const now = useNow(1_000)
  if (!group) {
    return (
      <div className="rw-error">
        <StatusPanel variant="info" headline="Nothing waiting" />
      </div>
    )
  }

  return (
    <div className="rw-scroll">
      <div className="rw-level">
        <header className="rw-level-head">
          <h2>{group.title}</h2>
          <p>{WHAT_RESOLVING_DOES[group.kind]}</p>
        </header>
        <List aria-label={`${group.runs.length} waiting runs`}>
          {group.runs.map((run) => (
            <ListItem
              key={run.workflow_id}
              className="rw-landing-row"
              leading={<StatusDot tone={TONE[group.kind]} />}
              label={<span className="rw-run-label">{requestText(run.input)}</span>}
              description={
                <span className="rw-run-meta">
                  {shortId(run.workflow_id)} · {runLine(run, now)}
                </span>
              }
              trailing={<ChevronRight aria-hidden />}
              onClick={() => onOpen(run.workflow_id)}
            />
          ))}
        </List>
      </div>
    </div>
  )
}

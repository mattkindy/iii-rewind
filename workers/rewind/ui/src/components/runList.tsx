/**
 * Every recorded run, newest first, for when the landing's groups are not the
 * way in. Search goes to Rewind, which matches a run id or any call's
 * invocation id by prefix, so an id copied from traces finds its run.
 */
import { EmptyState, List, ListItem, SearchField, StatusDot } from '@iii-dev/console-ui'
import { errorMessage } from '@iii-dev/console-ui/format'
import { useDebounce } from '@iii-dev/console-ui/hooks'
import { SearchX } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { RunRow } from '../client/types'
import { clockTime, duration, requestText, shortId } from '../model/format'
import { KINDS, signatureOf, type TriageRow } from '../model/signatures'

const SEARCH_LIMIT = 100

export function AllRuns({ client, runs, onOpen }: { client: RewindClient; runs: TriageRow[]; onOpen: (run: TriageRow) => void }) {
  const [query, setQuery] = useState('')
  const settled = useDebounce(query.trim(), 250)
  const [found, setFound] = useState<{ q: string; rows: RunRow[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    if (!settled) {
      setFound(null)
      return
    }

    let current = true
    client.runs({ filter: 'all', q: settled, limit: SEARCH_LIMIT }).then(
      (rows) => current && setFound({ q: settled, rows }),
      (e: unknown) => current && setError(errorMessage(e)),
    )
    return () => {
      current = false
    }
  }, [client, settled])

  // A search result is a plain row; the triage details come from the list the page already has.
  const known = new Map(runs.map((r) => [r.run_id, r]))
  const shown: TriageRow[] = settled && found?.q === settled ? found.rows.map((r) => known.get(r.run_id) ?? r) : runs

  return (
    <div className="rw-scroll">
      <div className="rw-level">
        <SearchField value={query} onChange={setQuery} aria-label="Search runs" placeholder="Search by request, run id or invocation id" autoFocus />
        {error ? <p className="rw-side-note">Search failed · {error}</p> : null}
        {shown.length === 0 ? (
          <EmptyState compact icon={SearchX} title="No matches" description={`“${settled}”`} action={{ label: 'Clear search', onClick: () => setQuery('') }} />
        ) : (
          <List aria-label="Recorded runs" className="rw-run-list">
            {shown.map((run) => {
              const signature = signatureOf(run)
              return (
                <ListItem
                  key={run.run_id}
                  className="rw-run-row"
                  data-run={run.run_id}
                  leading={<StatusDot tone={KINDS[signature.kind].tone} />}
                  label={<span className="rw-run-label">{requestText(run.input)}</span>}
                  description={
                    <span className="rw-run-meta">
                      {signature.label} · {shortId(run.run_id)} · {clockTime(run.started_at_ms)} · {duration(run.duration_ms)}
                    </span>
                  }
                  onClick={() => onOpen(run)}
                />
              )
            })}
          </List>
        )}
      </div>
    </div>
  )
}

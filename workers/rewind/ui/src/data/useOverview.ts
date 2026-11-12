/**
 * Everything the landing lists: Rewind's status, the recorded functions, the
 * runs and the lost runs. It reads every run once, a page at a time, then
 * keeps them current from `rewind::changed`. A new run is read on its own and
 * added, so the counts on the landing only grow while traffic runs. Lost runs
 * and the status are read again when their events arrive. Events are gathered
 * for 250 ms before a read, so a burst becomes a few reads. When the feed says
 * events may have been missed, it asks for the runs newer than the newest it
 * has, and reads the lost runs and the status again.
 *
 * A run row says whether the run threw or stopped, but not whether one of its
 * tools failed or a call went out twice, so the page reads the calls of runs
 * that could have one. A recording never changes, so each is read once.
 */
import { errorMessage } from '@iii-dev/console-ui/format'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { Call, ChangedEvent, FunctionRow, LostRun, RunRow, Status } from '../client/types'
import { isStopped, notableCalls, type TriageRow } from '../model/signatures'
import { BoundedCache } from './boundedCache'
import type { ChangedFeed } from './useChangedFeed'

/** `capped` when the page stopped paging before the oldest run, so older runs are not counted. */
export type Overview = { status: Status; functions: FunctionRow[]; runs: TriageRow[]; lost: LostRun[]; capped: boolean }

type Store = Omit<Overview, 'runs'> & { runs: Map<string, TriageRow> }

// The most `rewind::runs` returns in one call.
const RUN_LIMIT = 500
// Opening the page reads at most this many pages, so a huge recording can't keep the landing loading.
const MAX_PAGES = 40
export const MOST_RUNS = RUN_LIMIT * MAX_PAGES
// More missed runs than this are added as rows, without reading each one's calls.
const CATCH_UP = 50
const SETTLE_MS = 250
const READS_AT_ONCE = 4

// The calls of each run that could have a failed tool or a repeated call, since only those runs are read.
const recordedCalls = new BoundedCache<string, Call[]>(MOST_RUNS)

type ReadKind = 'runs' | 'lost' | 'status'

/**
 * Hands out a number per kind of read, so a reply can tell whether a newer
 * read of the same kind started after it, and drop itself if one did.
 */
function useReadTokens() {
  const tokens = useRef(new Map<ReadKind, number>())
  return useCallback((kind: ReadKind) => {
    const mine = (tokens.current.get(kind) ?? 0) + 1
    tokens.current.set(kind, mine)
    return () => tokens.current.get(kind) === mine
  }, [])
}

function triage(run: RunRow): TriageRow {
  const calls = recordedCalls.get(run.run_id)
  return calls ? { ...run, notable: notableCalls(calls) } : run
}

/** Reads runs a few at a time, keeping each one's calls, and returns the rows of those that could be read. */
async function readDetails(client: RewindClient, runIds: string[]): Promise<RunRow[]> {
  const rows: RunRow[] = []
  for (let start = 0; start < runIds.length; start += READS_AT_ONCE) {
    await Promise.all(
      runIds.slice(start, start + READS_AT_ONCE).map(async (id) => {
        const detail = await client.run(id).catch(() => null)
        if (detail) {
          recordedCalls.set(id, detail.calls)
          rows.push(detail.run)
        }
      }),
    )
  }

  return rows
}

type EveryRun = { all: RunRow[]; failedIds: Set<string>; capped: boolean }

/**
 * Every recorded run, newest first, a page at a time. The `failed` list is
 * read over each page's own window, because a filtered page looks at a limited
 * number of runs and can't say on its own whether older ones match.
 */
async function everyRun(client: RewindClient): Promise<EveryRun> {
  const all: RunRow[] = []
  const failedIds = new Set<string>()
  let before: number | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await client.runs({ filter: 'all', limit: RUN_LIMIT, before_ms: before })
    if (rows.length === 0) {
      return { all, failedIds, capped: false }
    }

    const oldest = Math.min(...rows.map((r) => r.started_at_ms))
    const failed = await client.runs({ filter: 'failed', limit: RUN_LIMIT, since_ms: oldest, before_ms: before })
    all.push(...rows)
    for (const row of failed) {
      failedIds.add(row.run_id)
    }

    if (rows.length < RUN_LIMIT) {
      return { all, failedIds, capped: false }
    }

    before = oldest
  }

  return { all, failedIds, capped: true }
}

/**
 * The landing's data, kept current from `feed`. `live` is the feed's: true
 * while events arrive. `pulse` goes up whenever something a detail view could
 * show changed (every load, and every read of the lost runs, which a fork or a
 * recovery changes), so a view that depends on it reads again.
 */
export function useOverview(feed: ChangedFeed, client: RewindClient) {
  const [store, setStore] = useState<Store | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pulse, setPulse] = useState(0)
  const storeRef = useRef(store)
  storeRef.current = store
  const loadToken = useRef(0)
  const claim = useReadTokens()
  const queued = useRef(new Set<string>())
  const timers = useRef<Partial<Record<'runs' | 'lost', number>>>({})

  const loadAll = useCallback(async () => {
    const mine = ++loadToken.current
    try {
      const [status, functions, { all, failedIds, capped }, lost] = await Promise.all([client.status(), client.functions(), everyRun(client), client.lost()])
      await readDetails(client, all.filter((r) => r.status === 'success' && failedIds.has(r.run_id) && !recordedCalls.has(r.run_id)).map((r) => r.run_id))
      if (mine !== loadToken.current) {
        return
      }

      setStore({ status, functions, lost, runs: new Map(all.map((r) => [r.run_id, triage(r)])), capped })
      setError(null)
      setPulse((p) => p + 1)
    } catch (e) {
      if (mine === loadToken.current) {
        setError(errorMessage(e))
      }
    }
  }, [client])

  const upsert = useCallback((rows: TriageRow[]) => {
    if (rows.length === 0) {
      return
    }

    setStore((current) => {
      if (!current) {
        return current
      }

      const runs = new Map(current.runs)
      for (const row of rows) {
        runs.set(row.run_id, row)
      }

      return { ...current, runs }
    })
  }, [])

  const refreshLost = useCallback(async () => {
    const isLatest = claim('lost')
    const lost = await client.lost().catch(() => null)
    if (lost && isLatest()) {
      setStore((current) => (current ? { ...current, lost } : current))
      setPulse((p) => p + 1)
    }
  }, [claim, client])

  const refreshStatus = useCallback(async () => {
    const isLatest = claim('status')
    const [status, functions] = await Promise.all([client.status(), client.functions()]).catch(() => [null, null] as const)
    if (status && functions && isLatest()) {
      setStore((current) => (current ? { ...current, status, functions } : current))
    }
  }, [claim, client])

  // The first event starts a short wait; the ones after it join the same read.
  const soon = useCallback((key: 'runs' | 'lost', work: () => void) => {
    if (timers.current[key] !== undefined) {
      return
    }

    timers.current[key] = window.setTimeout(() => {
      timers.current[key] = undefined
      work()
    }, SETTLE_MS)
  }, [])

  const addRuns = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        queued.current.add(id)
      }

      soon('runs', () => {
        const batch = [...queued.current]
        queued.current.clear()
        void readDetails(client, batch).then((rows) => {
          upsert(rows.map(triage))
          if (rows.some(isStopped)) {
            soon('lost', () => void refreshLost())
          }
        })
      })
    },
    [client, refreshLost, soon, upsert],
  )

  const catchUp = useCallback(async () => {
    const known = storeRef.current?.runs
    if (!known) {
      return
    }

    const isLatest = claim('runs')
    const newest = Math.max(0, ...[...known.values()].map((r) => r.started_at_ms))
    const since = await client.runs({ filter: 'all', limit: RUN_LIMIT, since_ms: newest }).catch(() => [])
    if (!isLatest()) {
      return
    }

    const missed = since.filter((r) => !known.has(r.run_id))
    if (missed.length <= CATCH_UP) {
      addRuns(missed.map((r) => r.run_id))
      return
    }

    upsert(missed.map(triage))
  }, [addRuns, claim, client, upsert])

  const refresh = useCallback(() => {
    if (!storeRef.current) {
      void loadAll()
      return
    }

    void catchUp()
    void refreshLost()
    void refreshStatus()
  }, [catchUp, loadAll, refreshLost, refreshStatus])

  const onEvent = useRef<(event: ChangedEvent) => void>(() => undefined)
  onEvent.current = (event) => {
    const handlers: Record<ChangedEvent['kind'], () => void> = {
      run: () => addRuns([event.id]),
      lost: () => soon('lost', () => void refreshLost()),
      // A recovery is a fork, and it changes what is still lost.
      fork: () => soon('lost', () => void refreshLost()),
      code: () => void refreshStatus(),
      check: () => undefined,
      recorder: () => void refreshStatus(),
    }
    handlers[event?.kind]?.()
  }

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => feed.subscribe((event) => onEvent.current(event)), [feed])

  useEffect(() => feed.onCatchUp(refresh), [feed, refresh])

  useEffect(
    () => () => {
      for (const timer of Object.values(timers.current)) {
        window.clearTimeout(timer)
      }
    },
    [],
  )

  const data = useMemo<Overview | null>(() => {
    if (!store) {
      return null
    }

    const runs = [...store.runs.values()].sort((a, b) => b.started_at_ms - a.started_at_ms)
    return { ...store, runs }
  }, [store])

  return { data, error, live: feed.live, refresh, pulse }
}

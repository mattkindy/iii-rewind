/**
 * The durable runs waiting on a pending step, from the journal. The journal sends no events of
 * its own, but a run that parks or goes on after a resolve ends an execution, and Rewind sends a
 * `run` event when it records one. So the page reads the list again a moment after each run
 * event, when the feed says events may have been missed, and after it resolves a step itself.
 * `available` is false when the journal isn't there to ask.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JournalClient, WaitingRun } from '../client/journalClient'
import type { ChangedFeed } from './useChangedFeed'

const SETTLE_MS = 250

export type Waiting = { runs: WaitingRun[]; available: boolean; refresh: () => void }

export function useWaitingRuns(feed: ChangedFeed, journal: JournalClient): Waiting {
  const [runs, setRuns] = useState<WaitingRun[]>([])
  const [available, setAvailable] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const reads = useRef(0)

  const refresh = useCallback(() => {
    const mine = ++reads.current
    journal
      .waiting()
      .then((listed) => {
        if (mine === reads.current) {
          setRuns(listed)
          setAvailable(true)
        }
      })
      .catch(() => {
        if (mine === reads.current) {
          setAvailable(false)
        }
      })
  }, [journal])

  useEffect(() => {
    refresh()
    // The first event starts a short wait, and the ones after it join the same read.
    const soon = () => {
      if (timer.current !== undefined) {
        return
      }

      timer.current = window.setTimeout(() => {
        timer.current = undefined
        refresh()
      }, SETTLE_MS)
    }
    const offEvents = feed.subscribe((event) => {
      if (event.kind === 'run') {
        soon()
      }
    })
    const offCatchUp = feed.onCatchUp(refresh)
    return () => {
      window.clearTimeout(timer.current)
      offEvents()
      offCatchUp()
    }
  }, [feed, refresh])

  return { runs, available, refresh }
}

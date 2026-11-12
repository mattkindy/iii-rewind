/**
 * The page's one observer of `rewind::changed`, shared by everything that
 * listens: the landing's data and a running check. An observer waits while
 * Rewind is not connected, and events are lost while the
 * tab is disconnected or asleep, so the feed also says when to catch up: when
 * the connection comes back and when the tab is shown again. The page reads
 * again at those moments instead of polling, the way the console's
 * `useWorkerLive` does.
 */
import type { ExtensionIii } from '@iii-dev/console-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedEvent } from '../client/types'

export type ChangedFeed = {
  /** True while events arrive through the binding. */
  live: boolean
  /** Calls `listener` with every event until the returned function is called. */
  subscribe: (listener: (event: ChangedEvent) => void) => () => void
  /** Calls `listener` whenever events may have been missed, until the returned function is called. */
  onCatchUp: (listener: () => void) => () => void
}

// The `iii::` prefix keeps the page's own handlers out of the traces feed.
const HANDLER = 'iii::rewind-ui::changed'

function addTo<T>(set: Set<T>, item: T): () => void {
  set.add(item)
  return () => {
    set.delete(item)
  }
}

function runAll(offs: (() => void)[]): void {
  for (const off of offs) {
    try {
      off()
    } catch {
      // already gone
    }
  }
}

export function useChangedFeed(iii: ExtensionIii): ChangedFeed {
  const [live, setLive] = useState(false)
  const listeners = useRef(new Set<(event: ChangedEvent) => void>())
  const catchUps = useRef(new Set<() => void>())

  useEffect(() => {
    const offs: (() => void)[] = []
    const catchUp = () => {
      for (const listener of catchUps.current) {
        listener()
      }
    }

    try {
      offs.push(iii.on<ChangedEvent>(HANDLER, (event) => listeners.current.forEach((listener) => listener(event))))
      offs.push(iii.observe('rewind::changed', `${HANDLER}::${iii.browserId}`))
      setLive(true)
    } catch {
      setLive(false)
    }

    let connected = true
    offs.push(
      iii.addConnectionStateListener((state) => {
        const back = state === 'connected' && !connected
        connected = state === 'connected'
        if (back) {
          catchUp()
        }
      }),
    )

    const onVisible = () => {
      if (!document.hidden) {
        catchUp()
      }
    }

    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    offs.push(() => document.removeEventListener('visibilitychange', onVisible))
    offs.push(() => window.removeEventListener('focus', onVisible))
    return () => {
      setLive(false)
      runAll(offs)
    }
  }, [iii])

  return useMemo(
    () => ({ live, subscribe: (listener) => addTo(listeners.current, listener), onCatchUp: (listener) => addTo(catchUps.current, listener) }),
    [live],
  )
}

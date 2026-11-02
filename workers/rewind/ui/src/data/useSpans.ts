/**
 * The traced functions that ran inside one iii call, from `rewind::spans`. The
 * page asks only for a call someone opened, never for a list. A recorded
 * call's spans never change once they are in, so a call that has spans keeps
 * them while the page is open. A worker sends its spans a moment after the
 * call ends, so a call with none yet is asked again a few times while it
 * stays open.
 */
import { useEffect, useState } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { FunctionSpan } from '../client/types'
import { BoundedCache } from './boundedCache'

const KEPT = 500
const RETRY_MS = 2_000
const TRIES = 3

const read = new BoundedCache<string, FunctionSpan[]>(KEPT)

/**
 * The spans of every call in `invocationIds`, in the order given, with ids
 * left out that are undefined. It returns what it has at once and renders
 * again as more arrive. A failed read counts as no spans.
 */
export function useSpans(client: RewindClient, invocationIds: (string | undefined)[]): FunctionSpan[] {
  const ids = [...new Set(invocationIds.filter((id): id is string => Boolean(id)))]
  const key = ids.join(' ')
  const [, setVersion] = useState(0)

  useEffect(() => {
    let current = true
    let timer: number | undefined
    const fetchMissing = (triesLeft: number) => {
      const missing = key.split(' ').filter((id) => id && !read.has(id))
      if (missing.length === 0 || triesLeft === 0) {
        return
      }

      void Promise.all(missing.map((id) => client.spans(id).then((spans) => ({ id, spans }), () => ({ id, spans: [] })))).then((found) => {
        for (const { id, spans } of found.filter((f) => f.spans.length > 0)) {
          read.set(id, spans)
        }

        if (!current) {
          return
        }

        setVersion((v) => v + 1)
        timer = window.setTimeout(() => fetchMissing(triesLeft - 1), RETRY_MS)
      })
    }

    fetchMissing(TRIES)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [client, key])

  return ids.flatMap((id) => read.get(id) ?? [])
}

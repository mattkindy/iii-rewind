/**
 * One run with every fork of it. It re-reads on each overview pulse, and a
 * fork the page has created or answered is applied at once, before the
 * re-read confirms it. Request ids keep a slow, older response from
 * overwriting a newer one.
 */
import { errorMessage } from '@iii-dev/console-ui/format'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { Fork, RunDetail } from '../client/types'

export type LoadedRun = { runId: string; detail: RunDetail; forks: Fork[] }

type State = { data: LoadedRun | null; error: string | null }

async function fetchRun(client: RewindClient, runId: string): Promise<LoadedRun> {
  const detail = await client.run(runId)
  const forks = await Promise.all(detail.forks.map((f) => client.forkGet(f.fork_id)))
  return { runId, detail, forks }
}

/**
 * The run `runId` with each of its forks in full, read again whenever `pulse`
 * goes up. Every read takes a number from `request`, and a reply is kept only
 * if no read or local change started after it, so a slow reply can't put back
 * a fork the page has since changed.
 *
 * `applyFork` puts a fork the page has created or answered on screen at
 * once, as a new line or in place of its old self, then reads the run again
 * to confirm it. `dropFork` takes a discarded fork off screen the same way.
 * Both are optimistic: the page shows the change before the core's run says
 * so. On a failed read, a run that was on screen stays with the error beside
 * it.
 */
export function useRunDetail(client: RewindClient, runId: string | null, pulse: number) {
  const [state, setState] = useState<State>({ data: null, error: null })
  const request = useRef(0)

  const load = useCallback(() => {
    const mine = ++request.current
    if (!runId) {
      setState({ data: null, error: null })
      return
    }

    fetchRun(client, runId).then(
      (data) => {
        if (mine === request.current) {
          setState({ data, error: null })
        }
      },
      (error: unknown) => {
        if (mine === request.current) {
          setState((prev) => ({ data: prev.data?.runId === runId ? prev.data : null, error: errorMessage(error) }))
        }
      },
    )
  }, [client, runId])

  useEffect(() => {
    load()
  }, [load, pulse])

  const applyFork = useCallback(
    (fork: Fork) => {
      request.current += 1
      setState((prev) => {
        if (!prev.data || prev.data.runId !== fork.run_id) {
          return prev
        }

        const known = prev.data.forks.some((f) => f.fork_id === fork.fork_id)
        const forks = known ? prev.data.forks.map((f) => (f.fork_id === fork.fork_id ? fork : f)) : [...prev.data.forks, fork]
        const { calls: _calls, ...summary } = fork
        const summaries = known ? prev.data.detail.forks : [...prev.data.detail.forks, { ...summary, created_at_ms: Date.now() }]
        return { data: { ...prev.data, forks, detail: { ...prev.data.detail, forks: summaries } }, error: null }
      })
      load()
    },
    [load],
  )

  const dropFork = useCallback(
    (forkId: string) => {
      request.current += 1
      setState((prev) => {
        if (!prev.data) {
          return prev
        }

        const forks = prev.data.forks.filter((f) => f.fork_id !== forkId)
        const summaries = prev.data.detail.forks.filter((f) => f.fork_id !== forkId)
        return { data: { ...prev.data, forks, detail: { ...prev.data.detail, forks: summaries } }, error: null }
      })
      load()
    },
    [load],
  )

  const current = state.data?.runId === runId ? state.data : null
  return { data: current, error: state.error, reload: load, applyFork, dropFork }
}

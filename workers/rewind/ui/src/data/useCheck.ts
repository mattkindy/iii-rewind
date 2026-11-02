/**
 * Replays a set of runs against the current code with `rewind::check`, in up
 * to two passes. The first gives every call its recorded answer and stops a
 * run at the first call the recording lacks. The second, which the person
 * starts, runs those new calls live where their effects allow.
 *
 * Each pass is one call to the core, which replays the runs one after another
 * on one copy of the agent. Progress comes from the `check` events it sends on
 * `rewind::changed` as each run finishes; the call's return value is the final
 * word. The results stay while the person opens a run and comes back, and
 * starting another check drops the one before.
 */
import { errorMessage } from '@iii-dev/console-ui/format'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { CheckResult, CodeVersion } from '../client/types'
import type { CheckPassKind } from '../model/nav'
import type { ChangedFeed } from './useChangedFeed'

export type CheckItem = { run_id: string; state: 'waiting' | 'done' | 'failed'; result?: CheckResult; error?: string }

export type PassKind = CheckPassKind

export type CheckPass = { items: CheckItem[]; finished: boolean; error: string | null }

export type CheckRun = {
  key: string
  title: string
  group?: string
  code?: CodeVersion | null
  runIds: string[]
  recorded: CheckPass
  live: CheckPass | null
}

export type CheckRequest = Omit<CheckRun, 'recorded' | 'live'>

/** The pass waiting on the core, with the runs it has no result for yet. */
type InFlight = { token: number; kind: PassKind; code: CodeVersion | null | undefined; waiting: Set<string> }

function newPass(runIds: string[]): CheckPass {
  return { items: runIds.map((run_id) => ({ run_id, state: 'waiting' })), finished: false, error: null }
}

function markItem(pass: CheckPass, runId: string, patch: Partial<CheckItem>): CheckPass {
  return { ...pass, items: pass.items.map((item) => (item.run_id === runId ? { ...item, ...patch } : item)) }
}

function finishPass(results: CheckResult[], runIds: string[]): CheckPass {
  const byRun = new Map(results.map((r) => [r.run_id, r]))
  const items = runIds.map((run_id): CheckItem => {
    const result = byRun.get(run_id)
    return result ? { run_id, state: 'done', result } : { run_id, state: 'failed', error: 'No result' }
  })
  return { items, finished: true, error: null }
}

function failPass(pass: CheckPass, error: string): CheckPass {
  return {
    items: pass.items.map((item) => (item.state === 'waiting' ? { ...item, state: 'failed', error } : item)),
    finished: true,
    error,
  }
}

/**
 * Whether a check event's result belongs to the pass in flight. The event says
 * only which run it is, and another check, from this tab or another one, may
 * replay the same run, so the result also has to fit the pass: a run it is
 * still waiting on, the code it was started against, and no live calls in a
 * pass that makes none.
 */
function belongsTo(pass: InFlight, runId: string, result: CheckResult): boolean {
  const sameCode = !pass.code || !result.code || pass.code.version === result.code.version
  const ranLive = (result.live_calls ?? 0) > 0 || (result.filled?.length ?? 0) > 0
  return pass.waiting.has(runId) && sameCode && (pass.kind === 'live' || !ranLive)
}

/**
 * The check on screen and the two ways to run it. `start` begins a new check
 * with its recorded pass, dropping any check before it. `startLive` runs the
 * live pass of the check on screen, once its recorded pass has finished.
 */
export function useCheck(feed: ChangedFeed, client: RewindClient) {
  const [check, setCheck] = useState<CheckRun | null>(null)
  const token = useRef(0)
  const inFlight = useRef<InFlight | null>(null)

  const update = useCallback((kind: PassKind, change: (pass: CheckPass) => CheckPass) => {
    setCheck((current) => {
      const pass = current?.[kind]
      return current && pass ? { ...current, [kind]: change(pass) } : current
    })
  }, [])

  // Results arrive one run at a time while the pass runs. Without events the pass still finishes, with no progress on the way.
  useEffect(
    () =>
      feed.subscribe((event) => {
        const pass = inFlight.current
        if (!pass || event.kind !== 'check' || !event.check || !belongsTo(pass, event.id, event.check)) {
          return
        }

        const result = event.check
        pass.waiting.delete(event.id)
        update(pass.kind, (current) => markItem(current, event.id, { state: 'done', result }))
      }),
    [feed, update],
  )

  const runPass = useCallback(
    async (kind: PassKind, request: CheckRequest) => {
      const mine = ++token.current
      inFlight.current = { token: mine, kind, code: request.code, waiting: new Set(request.runIds) }
      try {
        const results = await client.check(request.runIds, { live: kind === 'live' })
        if (token.current === mine) {
          update(kind, () => finishPass(results, request.runIds))
        }
      } catch (error) {
        if (token.current === mine) {
          update(kind, (pass) => failPass(pass, errorMessage(error)))
        }
      } finally {
        if (inFlight.current?.token === mine) {
          inFlight.current = null
        }
      }
    },
    [client, update],
  )

  const start = useCallback(
    async (request: CheckRequest) => {
      setCheck({ ...request, recorded: newPass(request.runIds), live: null })
      await runPass('recorded', request)
    },
    [runPass],
  )

  const startLive = useCallback(async () => {
    if (!check || inFlight.current) {
      return
    }

    setCheck({ ...check, live: newPass(check.runIds) })
    await runPass('live', check)
  }, [check, runPass])

  return { check, start, startLive }
}

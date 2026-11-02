/**
 * One call at a time that starts or reruns a fork, with the progress line and
 * the error the view shows for it. A fork, a replay, an answer at a pause and
 * a recovery each take from one to several seconds, because the core starts a
 * copy of the worker, so the view shows what is running and for how long. The
 * run view and the recovery view both go through this hook.
 */
import { errorMessage } from '@iii-dev/console-ui/format'
import { useCallback, useState } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { Fork } from '../client/types'
import { type DecisionState, decisionValue } from '../model/decision'

/** What is running, for the progress line, and when it started, for the seconds beside it. */
export type Running = { headline: string; startedAt: number }

export function useForkActions(client: RewindClient) {
  const [running, setRunning] = useState<Running | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** Runs `work`, showing `headline` until it returns, and keeps the error it throws for the view. */
  const perform = useCallback(async (headline: string, work: () => Promise<void>) => {
    setRunning({ headline, startedAt: Date.now() })
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRunning(null)
    }
  }, [])

  /** Sends what the person decided at a paused call. `autoRead` is left as the fork has it when undefined. */
  const answer = useCallback(
    (fork: Pick<Fork, 'fork_id'>, decision: DecisionState, autoRead?: boolean) =>
      client.answer({ fork_id: fork.fork_id, choice: decision.choice, value: decisionValue(decision), auto_read: autoRead }),
    [client],
  )

  return { running, busy: running !== null, error, setError, perform, answer }
}

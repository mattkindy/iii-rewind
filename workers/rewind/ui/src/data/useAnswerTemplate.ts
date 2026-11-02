/**
 * A starting point for typing a call's answer: the most recent answer that
 * function gave, from the lines on screen or else from a recent successful run,
 * and when there is none, an empty answer that fits the function's schema.
 * "Mark all sent" gives every run in a group that recent run's answer, so a
 * run gets the same answer from it as from "Already sent".
 */
import { useEffect, useState } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { RunRow } from '../client/types'
import { answerText, isError } from '../model/answers'
import { prettyJson, shortId } from '../model/format'
import type { Line } from '../model/lines'
import { type AnswerCheck, skeleton } from '../model/schema'
import { succeeded } from '../model/signatures'
import { BoundedCache } from './boundedCache'

export type Template = { text: string; from: string | null }

const RUNS_TO_SEARCH = 4
const RETRY_MS = 3_000
const fetched = new BoundedCache<string, Template>(100)

function fromLines(lines: Line[], functionId: string): Template | null {
  for (const line of [...lines].reverse()) {
    const call = [...line.calls].reverse().find((c) => c.function_id === functionId && !isError(c.answer))
    if (call) {
      return { text: answerText(call.answer), from: line.label.toLowerCase() }
    }
  }

  return null
}

function fromSchema(check: AnswerCheck | undefined): Template {
  return check ? { text: prettyJson(skeleton(check.schema, check.tools)), from: 'schema' } : { text: '{}', from: null }
}

// A run with no calls, such as an inbound request a core lists with every root, has no answer to find.
const mayHaveAnswer = (run: RunRow): boolean => succeeded(run) && run.calls > 0

/** The newest few runs worth searching, as a key that changes only when they do. */
function candidateKey(runs: RunRow[]): string {
  return runs
    .filter(mayHaveAnswer)
    .slice(0, RUNS_TO_SEARCH)
    .map((run) => run.run_id)
    .join(' ')
}

/** A hit, null when every run read had no answer, or undefined when a read failed and the search should try again. */
async function searchRuns(client: RewindClient, functionId: string, runIds: string[]): Promise<Template | null | undefined> {
  let readAll = true
  for (const runId of runIds) {
    const detail = await client.run(runId).catch(() => null)
    readAll = readAll && detail !== null
    const call = detail?.calls.find((c) => c.function_id === functionId && !isError(c.answer))
    if (call) {
      return { text: answerText(call.answer), from: `run ${shortId(runId)}` }
    }
  }

  return readAll ? null : undefined
}

/**
 * The newest successful answer `functionId` gave in a recent recorded run:
 * undefined while it looks, null when none of them has one. Pass no function
 * to skip the search.
 */
export function useRecordedAnswer(client: RewindClient, functionId: string | undefined, runs: RunRow[]): Template | null | undefined {
  const [found, setFound] = useState<{ functionId: string; template: Template | null } | null>(null)
  const [attempt, setAttempt] = useState(0)
  // The landing passes a new list on every update, so the search runs again only when the runs it would read change.
  const candidates = candidateKey(runs)

  useEffect(() => {
    if (!functionId) {
      return
    }

    const cached = fetched.get(functionId)
    if (cached) {
      setFound({ functionId, template: cached })
      return
    }

    let cancelled = false
    let retry: number | undefined
    void searchRuns(client, functionId, candidates ? candidates.split(' ') : []).then((template) => {
      // Only a hit is cached, so a miss is searched again when new runs arrive.
      if (template) {
        fetched.set(functionId, template)
      }

      if (cancelled) {
        return
      }

      // A read fails while the core is busy, such as during Recover all, which says nothing about the runs.
      if (template === undefined) {
        retry = window.setTimeout(() => setAttempt((n) => n + 1), RETRY_MS)
        return
      }

      setFound({ functionId, template })
    })
    return () => {
      cancelled = true
      window.clearTimeout(retry)
    }
  }, [client, functionId, candidates, attempt])

  if (!functionId || found?.functionId !== functionId) {
    return undefined
  }

  return found.template
}

export function useAnswerTemplate(client: RewindClient, functionId: string | undefined, lines: Line[], runs: RunRow[], check?: AnswerCheck): Template {
  const local = functionId ? fromLines(lines, functionId) : null
  const recorded = useRecordedAnswer(client, local ? undefined : functionId, runs)
  return local ?? recorded ?? fromSchema(check)
}

/**
 * Wakes sleeps and times out waits when their time comes. The times are in SQLite, so the first
 * check after the journal restarts finds whatever came due while it was down. One timer is set for
 * the next time due, and set again after anything parks or resolves. A time far off is read again
 * every MAX_DELAY_MS, which also keeps a clock change from leaving a timer set for the wrong moment.
 */
import type { Journal } from './store.js'

const MAX_DELAY_MS = 60_000

export function startDeadlines(journal: Journal, onResumed: (workflowId: string) => void) {
  let timer: NodeJS.Timeout | undefined

  function schedule(): void {
    clearTimeout(timer)
    const next = journal.nextDue()
    if (next === null) {
      return
    }

    timer = setTimeout(check, Math.max(0, Math.min(next - Date.now(), MAX_DELAY_MS)))
  }

  function check(): void {
    for (const workflowId of journal.due()) {
      onResumed(workflowId)
    }

    schedule()
  }

  check()
  return { schedule }
}

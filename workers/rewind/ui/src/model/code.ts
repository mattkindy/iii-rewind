/**
 * The worker under test's code: whether it changed since a run was recorded,
 * and how to say which version and when. The core reports the code on disk as
 * `status.target_code` and the code a run ran as its `code_version`. An older
 * core sends neither, and then nothing counts as changed, so the page offers
 * no replay with current code and no check.
 */
import type { CodeVersion, RunRow, Status } from '../client/types'
import { clockTime, dayAndTime } from './format'

/** True when the worker's code on disk is not the code a run was recorded with. Unknown counts as unchanged. */
export function codeChangedSince(run: Pick<RunRow, 'code_version'>, status: Status): boolean {
  return Boolean(status.target_code && run.code_version && run.code_version !== status.target_code.version)
}

export function versionLabel(code: CodeVersion | undefined): string {
  return code ? code.version.slice(0, 7) : 'the current code'
}

/** When the code changed, to follow the word "changed": `at 22:04:30`, or `on Oct 29, 17:40:00`. */
export function changedAtLabel(code: CodeVersion): string {
  const sameDay = new Date(code.changed_at_ms).toDateString() === new Date().toDateString()
  return sameDay ? `at ${clockTime(code.changed_at_ms)}` : `on ${dayAndTime(code.changed_at_ms)}`
}

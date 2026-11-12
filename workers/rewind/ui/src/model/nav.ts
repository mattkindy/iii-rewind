/**
 * Where the page is. Each level answers one question and each click goes one
 * level down: what needs attention, then one run or the lost work or a check,
 * then one lost run. The level is kept per pane, so a reload comes back to it.
 */

import type { CheckVerdict } from '../client/types'

/** Which pass of a check a run was opened from: with recorded answers only, or with new calls run live. */
export type CheckPassKind = 'recorded' | 'live'

/** What the run shows once a replay returns: the original still, the replay against it, or the replay as the line on screen. */
export type ReplayThen = 'stay' | 'compare' | 'open'

/**
 * A run opened from the recorded pass of a check replays at once. One that
 * ended differently opens in compare, and one that took a new path opens
 * paused at the new call, with its choices.
 */
export const REPLAY_ON_OPEN: Record<CheckVerdict, ReplayThen | undefined> = {
  same: undefined,
  different: 'compare',
  stopped: 'open',
}

/**
 * `incident` is the key of one incident of lost work; without it, the newest one shows. `wait` is
 * the key of a group of durable runs waiting on the same thing, and `workflowId` one of them.
 */
export type Nav =
  | { level: 'home' }
  | { level: 'runs' }
  | { level: 'run'; runId: string; group?: string; fromCheck?: CheckPassKind; line?: string }
  | { level: 'lost'; incident?: string }
  | { level: 'lost-run'; runId: string; incident?: string }
  | { level: 'check'; key: string }
  | { level: 'waiting'; wait: string }
  | { level: 'waiting-run'; workflowId: string; wait: string }

export const HOME: Nav = { level: 'home' }

/** Which level is on screen and for which run, so anything kept per level can start over when it changes. */
export function levelKey(nav: Nav): string {
  if ('runId' in nav) {
    return `${nav.level}:${nav.runId}`
  }

  return 'workflowId' in nav ? `${nav.level}:${nav.workflowId}` : nav.level
}

/** The level above, for the back button. */
export function parentOf(nav: Nav, checkOpen: string | null): Nav {
  const up: Record<Nav['level'], () => Nav> = {
    home: () => HOME,
    runs: () => HOME,
    run: () => (nav.level === 'run' && nav.fromCheck && checkOpen ? { level: 'check', key: checkOpen } : HOME),
    lost: () => HOME,
    'lost-run': () => ({ level: 'lost', incident: nav.level === 'lost-run' ? nav.incident : undefined }),
    check: () => HOME,
    waiting: () => HOME,
    'waiting-run': () => (nav.level === 'waiting-run' ? { level: 'waiting', wait: nav.wait } : HOME),
  }
  return up[nav.level]()
}

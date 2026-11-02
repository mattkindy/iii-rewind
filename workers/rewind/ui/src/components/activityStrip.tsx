/**
 * The last minute of recorded runs as dots on a line, newest on the right,
 * each in the colour of how the run ended, drifting left as time passes. It is
 * the one thing on the landing that moves, and it only moves while it has
 * dots. With reduced motion the dots are placed again every few seconds
 * instead of drifting.
 */
import { useMemo } from 'react'
import { ago } from '../model/format'
import { KINDS, signatureOf, type TriageRow } from '../model/signatures'
import { useNow, useReducedMotion } from './motion'

const WINDOW_MS = 60_000
const REDUCED_EVERY_MS = 5_000
const IDLE_EVERY_MS = 15_000

function endedAt(run: TriageRow): number {
  return run.started_at_ms + run.duration_ms
}

function countText(recording: boolean, count: number): string {
  if (!recording) {
    return 'Not recording'
  }

  return `Recording · ${count}/min`
}

export function ActivityStrip({ runs, recording }: { runs: TriageRow[]; recording: boolean }) {
  const reduced = useReducedMotion()
  // A run that ended before the window opened never comes back into it, so each frame filters only these.
  const inWindow = useMemo(() => {
    const opened = Date.now() - WINDOW_MS
    return runs.filter((run) => endedAt(run) > opened)
  }, [runs])
  const moving = inWindow.some((run) => Date.now() - endedAt(run) < WINDOW_MS)
  const now = useNow(moving ? (reduced ? REDUCED_EVERY_MS : 'frame') : IDLE_EVERY_MS)
  const recent = inWindow.filter((run) => now - endedAt(run) < WINDOW_MS)

  return (
    <div className="rw-activity" data-quiet={recent.length === 0 || undefined}>
      <span className="rw-activity-track" aria-hidden>
        {recent.map((run) => {
          const signature = signatureOf(run)
          const share = Math.min(1, Math.max(0, 1 - (now - endedAt(run)) / WINDOW_MS))
          return (
            <span
              key={run.run_id}
              className="rw-activity-dot"
              data-tone={KINDS[signature.kind].tone}
              title={`${signature.label} · ${ago(endedAt(run))}`}
              style={{ left: `${share * 100}%` }}
            />
          )
        })}
      </span>
      <span className="rw-activity-text">{countText(recording, recent.length)}</span>
    </div>
  )
}

/**
 * The progress line while a fork, a replay, an answer or a recovery runs:
 * what is running and the seconds so far, ticking every tenth of a second.
 * Each of those takes seconds, since the core starts a copy of the worker
 * first, so the count shows the page is still waiting rather than stuck.
 */
import { StatusPanel, uiClasses } from '@iii-dev/console-ui'
import { LoaderCircle } from 'lucide-react'
import type { Running } from '../data/useForkActions'
import { useNow } from './motion'

const TICK_MS = 100

export function RunProgress({ running }: { running: Running }) {
  const now = useNow(TICK_MS)
  const seconds = Math.max(0, (now - running.startedAt) / 1000).toFixed(1)
  return (
    <div className="rw-banner">
      <StatusPanel
        variant="info"
        role="status"
        icon={<LoaderCircle aria-hidden className={uiClasses.spin} />}
        headline={running.headline}
        detail={<span className="rw-progress-detail rw-mono">{seconds}s</span>}
      />
    </div>
  )
}

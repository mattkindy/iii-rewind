/**
 * Loading, empty and error states, each shaped like what replaces it.
 */
import { Button, EmptyState, Skeleton, StatusPanel, TerminalCommandLine } from '@iii-dev/console-ui'
import { History } from 'lucide-react'

export const TRAFFIC_COMMAND = `npx tsx scripts/trigger.ts traffic::burst '{"count":20}'`

const LIST_WIDTHS = [72, 54, 80, 62, 48, 76, 58, 66]
const ROW_WIDTHS = [38, 64, 52, 70, 44]

export function RunListSkeleton() {
  return (
    <div className="rw-skeleton-list" aria-hidden>
      <Skeleton className="rw-skel rw-skel-field" />
      <Skeleton className="rw-skel rw-skel-field" />
      {LIST_WIDTHS.map((width, index) => (
        <div key={index} className="rw-skel-row">
          <Skeleton className="rw-skel rw-skel-dot" />
          <span className="rw-skel-lines">
            <Skeleton className="rw-skel" style={{ width: `${width}%` }} />
            <Skeleton className="rw-skel rw-skel-thin" style={{ width: `${width / 2}%` }} />
          </span>
        </div>
      ))}
    </div>
  )
}

export function WorkspaceSkeleton() {
  return (
    <div className="rw-skeleton-work" aria-busy="true" aria-label="Loading the run">
      <div className="rw-skel-mast">
        <Skeleton className="rw-skel rw-skel-title" />
        <Skeleton className="rw-skel rw-skel-thin" style={{ width: '32%' }} />
      </div>
      <Skeleton className="rw-skel rw-skel-bar" />
      <div className="rw-skel-seq">
        {ROW_WIDTHS.map((width, index) => (
          <div key={index} className="rw-skel-seqrow">
            <Skeleton className="rw-skel rw-skel-num" />
            <span className="rw-skel-lines">
              <Skeleton className="rw-skel" style={{ width: `${width}%` }} />
              <Skeleton className="rw-skel rw-skel-thin" style={{ width: `${width - 14}%` }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function NoRunsYet() {
  return (
    <div className="rw-empty">
      <div className="rw-empty-column">
        <EmptyState
          icon={History}
          title="No runs yet"
          description="Send a burst:"
          className="rw-empty-state"
        />
        <div className="rw-empty-command">
          <TerminalCommandLine command={TRAFFIC_COMMAND} copy />
        </div>
      </div>
    </div>
  )
}

export function LoadError({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  return (
    <div className="rw-error">
      <StatusPanel
        variant="alert"
        role="alert"
        headline={`Failed to load ${what}`}
        detail={error}
        action={
          <Button variant="pill" size="sm" onClick={onRetry}>
            Retry
          </Button>
        }
      />
    </div>
  )
}

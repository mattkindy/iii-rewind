/**
 * Stops for one run: the functions where a fork of it pauses, like
 * breakpoints. Without a stop, a fork runs a call live when its effects allow
 * it and fills it from another run when they don't, and each row says which.
 * The menu stays open across toggles, the same as the recording menu.
 */
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  IconButton,
} from '@iii-dev/console-ui'
import { OctagonPause } from 'lucide-react'
import { notLiveReason } from '../model/choices'
import type { CalledFunction } from '../model/lines'
import { callName, callUrl } from '../model/requests'

function meta(target: CalledFunction): string {
  const effects = target.effects.join(', ') || 'no effects declared'
  return `${effects} · ${notLiveReason(target.effects) ? 'filled' : 'live'}`
}

export function stopsLabel(stops: string[]): string {
  return stops.length > 0 ? `Stops · ${stops.length}` : 'Stops'
}

export function StopsMenu({
  targets,
  stops,
  onToggle,
  disabled,
}: {
  targets: CalledFunction[]
  stops: string[]
  onToggle: (functionId: string) => void
  disabled: boolean
}) {
  const set = targets.filter((t) => stops.includes(t.functionId)).length
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={stopsLabel(stops)} className="rw-stops-trigger" data-on={stops.length > 0 || undefined}>
          <OctagonPause aria-hidden />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="rw-menu">
        <DropdownMenuLabel>
          Stops {set}/{targets.length} functions
        </DropdownMenuLabel>
        {targets.map((target) => (
          <DropdownMenuCheckboxItem
            key={target.functionId}
            checked={stops.includes(target.functionId)}
            disabled={disabled}
            onCheckedChange={() => onToggle(target.functionId)}
            onSelect={(event) => event.preventDefault()}
          >
            <span className="rw-menu-row">
              <span className="rw-mono" title={callUrl(target.functionId)}>
                {callName(target.functionId)}
              </span>
              <span className="rw-menu-meta">{meta(target)}</span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

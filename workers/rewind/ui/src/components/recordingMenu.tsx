/**
 * Which functions Rewind records, switched on and off per function. The menu
 * stays open across toggles so several can change at once, and its rows keep
 * their places while it is open.
 */
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  IconButton,
} from '@iii-dev/console-ui'
import { errorMessage } from '@iii-dev/console-ui/format'
import { Radio } from 'lucide-react'
import { useState } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { FunctionRow } from '../client/types'

export function RecordingMenu({
  client,
  functions,
  recording,
  onChanged,
}: {
  client: RewindClient
  functions: FunctionRow[]
  recording: number
  onChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  // Recording functions come first, in the order they had when the menu opened, so a toggle never moves the row under the pointer.
  const [order, setOrder] = useState<string[]>([])
  const rank = (row: FunctionRow) => {
    const at = order.indexOf(row.function_id)
    return at < 0 ? order.length : at
  }
  const rows = [...functions].sort((a, b) => rank(a) - rank(b))

  const toggle = (row: FunctionRow, enabled: boolean) => {
    setError(null)
    client.recordToggle(row.function_id, enabled).then(onChanged, (e: unknown) => setError(errorMessage(e)))
  }

  const onOpenChange = (open: boolean) => {
    if (open) {
      setOrder([...functions].sort((a, b) => Number(b.recording) - Number(a.recording)).map((row) => row.function_id))
    }
  }

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <IconButton label="Choose what Rewind records" tooltip={false}>
          <Radio aria-hidden />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="rw-menu">
        <DropdownMenuLabel>
          Recording {recording}/{functions.length} functions
        </DropdownMenuLabel>
        {rows.map((row) => (
          <DropdownMenuCheckboxItem
            key={row.function_id}
            checked={row.recording}
            onCheckedChange={(checked) => toggle(row, checked)}
            onSelect={(event) => event.preventDefault()}
          >
            <span className="rw-menu-row">
              <span className="rw-mono">{row.function_id}</span>
              <span className="rw-menu-meta">{row.effects.join(', ') || 'no effects declared'}</span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        {error ? <p className="rw-menu-error">{error}</p> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

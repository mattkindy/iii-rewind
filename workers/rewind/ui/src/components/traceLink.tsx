/**
 * One click from a call to its span in Traces: the call's function name is a
 * link, and each row has a button that shows on hover and keyboard focus, as
 * DevTools does with "Reveal in Network panel". Both sit inside or beside a
 * row that opens the call when clicked anywhere else, so a click on either
 * stops there. A call Rewind has no trace id for shows its name as text, with
 * the reason in the tooltip.
 */
import { IconButton, KeyCombo, Tooltip } from '@iii-dev/console-ui'
import { Waypoints } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'
import type { TraceTarget } from '../model/traceTarget'
import { ButtonTip } from './bits'
import { NO_SPAN_SELECTION } from './traceSync'

export const NO_TRACE_ID = 'No trace id'

export const SHOW_IN_TRACES = 'Show in Traces'

/** Where each row's call is in Traces, and how to show it. With `available` false, a name is plain text and there is no button. */
export type TraceLinks = {
  targetAt: (cursor: 'end' | number) => TraceTarget | null
  available: boolean
  spanSelectable: boolean
  onShow: (target: TraceTarget) => void
}

// The tooltip lays its content out in a row, so the lines go in a column of their own.
function TipLines({ lines }: { lines: ReactNode[] }) {
  return (
    <span className="rw-tip-lines">
      {lines.map((line, index) => (
        <span key={index} className="rw-tip-line">
          {line}
        </span>
      ))}
    </span>
  )
}

function showTip(target: TraceTarget | null, spanSelectable: boolean, first: ReactNode): ReactNode[] {
  if (!target) {
    return [NO_TRACE_ID]
  }

  return spanSelectable ? [first] : [first, NO_SPAN_SELECTION]
}

/** The function's name; a link to its span when Rewind knows where that is. `title` is a longer name, such as a request's full URL. */
export function FnLink({ name, title, target, links, className }: { name: string; title?: string; target: TraceTarget | null; links: TraceLinks; className: string }) {
  if (!links.available) {
    return (
      <span className={className} title={title}>
        {name}
      </span>
    )
  }

  const show = (event: MouseEvent) => {
    event.stopPropagation()
    if (target) {
      links.onShow(target)
    }
  }

  const lines = [...(title ? [<code key="url">{title}</code>] : []), ...showTip(target, links.spanSelectable, SHOW_IN_TRACES)]
  return (
    <Tooltip label={<TipLines lines={lines} />}>
      <span className={className} data-link={target ? '' : undefined} onClick={target ? show : undefined}>
        {name}
      </span>
    </Tooltip>
  )
}

/** The row's own button to its span, hidden until the row is hovered or focused. */
export function TraceButton({ target, links, label, focusable }: { target: TraceTarget | null; links: TraceLinks; label: string; focusable: boolean }) {
  if (!links.available) {
    return null
  }

  const tip = <TipLines lines={showTip(target, links.spanSelectable, <>{SHOW_IN_TRACES} <KeyCombo binding="Alt+T" /></>)} />
  return (
    <span className="rw-seq-trace">
      <ButtonTip tip={tip} disabled={!target} focusable={focusable}>
        <IconButton
          label={label}
          tooltip={false}
          variant="ghost"
          disabled={!target}
          tabIndex={focusable ? 0 : -1}
          onClick={(event) => {
            event.stopPropagation()
            if (target) {
              links.onShow(target)
            }
          }}
        >
          <Waypoints aria-hidden />
        </IconButton>
      </ButtonTip>
    </span>
  )
}

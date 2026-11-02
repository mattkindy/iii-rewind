/**
 * Keeping the ADE's Traces screen on the call a person is looking at. A
 * console with `host.traces.focus` opens the trace and selects the span. An
 * older one has no way for a page to do that, so the page renders a hidden
 * `@trace` mention and clicks it, which opens the trace in Traces the way a
 * mention in chat does, without selecting a span. Clicking a hidden console
 * element is behind the `trace-mention-click` feature switch.
 */
import { type Host, Markdown } from '@iii-dev/console-ui'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { featureOn } from '../features'
import type { TraceTarget } from '../model/traceTarget'

type TraceFocus = TraceTarget & { relativeTo?: string; direction?: 'left' | 'right' }

/** The proposed console API, which released consoles do not have yet. */
type TracesHost = Host & { traces?: { focus(request: TraceFocus): void } }

export type TraceSync = {
  on: boolean
  /** False when this console gives the page no way to open a trace, so nothing about Traces is offered. */
  available: boolean
  /** False on a console that can open a trace but cannot select a span in it. */
  spanSelectable: boolean
  /** Shows the target in Traces while sync is on, once per target. */
  follow: (target: TraceTarget | null) => void
  /** Shows the target in Traces now, whether or not sync is on. */
  show: (target: TraceTarget) => void
}

export const NO_SPAN_SELECTION = 'Opens the trace · no span selection'

/** Traces opens a trace only when its filters let the trace through, and its default view hides traces without a session. */
export const FILTERS_HIDE = 'Clear Traces filters if nothing opens'

const MENTION_WAIT_MS = 3_000
const MENTION_POLL_MS = 50

type Mention = { traceId: string; seq: number }

/**
 * Traces sync for the page. `sync` is stable while `on` and the console stay
 * the same, so a view can pass it to an effect. `mention` is the hidden
 * `@trace` mention a console without span selection opens traces through,
 * and the page has to render it somewhere, or showing a trace does nothing
 * on such a console.
 */
export function useTraceSync(host: Host, on: boolean, screen: string): { sync: TraceSync; mention: ReactNode } {
  const focus = (host as TracesHost).traces?.focus
  const [mentionClick] = useState(() => featureOn('trace-mention-click'))
  const [mention, setMention] = useState<Mention | null>(null)
  const holder = useRef<HTMLDivElement>(null)
  const last = useRef('')

  const show = useCallback(
    (target: TraceTarget) => {
      if (focus) {
        focus({ ...target, relativeTo: screen, direction: 'left' })
        return
      }

      if (mentionClick) {
        setMention((current) => ({ traceId: target.traceId, seq: (current?.seq ?? 0) + 1 }))
      }
    },
    [focus, mentionClick, screen],
  )

  // The console looks the trace up before the mention can open it, and says
  // `missing` when it can't find it, so the page waits for `ready`.
  useEffect(() => {
    if (!mention) {
      return
    }

    const deadline = Date.now() + MENTION_WAIT_MS
    const timer = window.setInterval(() => {
      const pill = holder.current?.querySelector<HTMLElement>(`[data-worker-mention="trace"][data-mention-id="${CSS.escape(mention.traceId)}"]`)
      const state = pill?.getAttribute('data-mention-state')
      if (state !== 'ready' && state !== 'missing' && Date.now() < deadline) {
        return
      }

      window.clearInterval(timer)
      if (state === 'ready') {
        const focused = document.activeElement as HTMLElement | null
        pill?.click()
        focused?.focus({ preventScroll: true })
      }
    }, MENTION_POLL_MS)
    return () => window.clearInterval(timer)
  }, [mention])

  const follow = useCallback(
    (target: TraceTarget | null) => {
      if (!on || !target) {
        return
      }

      // Without span selection a new span in the same trace changes nothing in Traces.
      const key = focus ? `${target.traceId}:${target.spanId ?? ''}` : target.traceId
      if (key === last.current) {
        return
      }

      last.current = key
      show(target)
    },
    [on, focus, show],
  )

  useEffect(() => {
    if (!on) {
      last.current = ''
    }
  }, [on])

  const sync = useMemo<TraceSync>(
    () => ({ on, available: Boolean(focus) || mentionClick, spanSelectable: Boolean(focus), follow, show }),
    [on, focus, mentionClick, follow, show],
  )
  const node = (
    <div ref={holder} className="rw-trace-mention" aria-hidden>
      {mention ? <Markdown key={mention.seq}>{`@trace(id="${mention.traceId}")`}</Markdown> : null}
    </div>
  )
  return { sync, mention: node }
}

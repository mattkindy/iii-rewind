/**
 * The player's playhead as a slider across the run's whole duration, with a
 * tick where each call starts in its worker's tone, and a mark where a fork
 * stops following the line it came from. Playback stops while the thumb is
 * dragged and goes on when the pointer lets go. Arrow keys move by a hundredth of the run, Page Up and Page
 * Down go to the previous and next call, Home and End to either end.
 */
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useRef } from 'react'
import type { Lane } from '../model/lanes'
import { nextStop, previousStop, type Span, type Timeline } from '../model/timeline'

export type ScrubberProps = {
  timeline: Timeline
  t: number
  toneOf: (span: Span) => Lane['tone']
  label: string
  valueText: string
  onSeek: (t: number) => void
  onHold: (held: boolean) => void
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

// Calls that start this close together stack their ticks, so two read as two.
const CLOSE_SHARE = 0.012
const MAX_LEVEL = 2

function tickLevels(shares: number[]): number[] {
  const levels: number[] = []
  shares.forEach((share, index) => {
    let level = 0
    while (level < MAX_LEVEL && shares.slice(0, index).some((other, j) => levels[j] === level && Math.abs(other - share) < CLOSE_SHARE)) {
      level += 1
    }

    levels.push(level)
  })
  return levels
}

export function Scrubber({ timeline, t, toneOf, label, valueText, onSeek, onHold }: ScrubberProps) {
  const rail = useRef<HTMLSpanElement>(null)
  const duration = Math.max(1, timeline.duration)
  const pct = (ms: number) => `${(clamp(ms, 0, duration) / duration) * 100}%`
  const levels = tickLevels(timeline.spans.map((s) => s.start / duration))
  const tickStyle = (at: number, level: number): CSSProperties => ({ left: pct(at), ['--rw-level' as string]: level })

  const timeAt = (clientX: number) => {
    const box = rail.current?.getBoundingClientRect()
    if (!box || box.width === 0) {
      return t
    }

    return clamp((clientX - box.left) / box.width, 0, 1) * duration
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    onHold(true)
    onSeek(timeAt(event.clientX))
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      onSeek(timeAt(event.clientX))
    }
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    onHold(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nudge = duration / 100
    const moves: Record<string, () => number> = {
      ArrowLeft: () => t - nudge,
      ArrowDown: () => t - nudge,
      ArrowRight: () => t + nudge,
      ArrowUp: () => t + nudge,
      PageUp: () => previousStop(timeline, t),
      PageDown: () => nextStop(timeline, t),
      Home: () => 0,
      End: () => duration,
    }
    const move = moves[event.key]
    if (!move || event.altKey || event.metaKey || event.ctrlKey) {
      return
    }

    event.preventDefault()
    onSeek(clamp(move(), 0, duration))
  }

  return (
    <div
      className="rw-scrub"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(t)}
      aria-valuetext={valueText}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <span className="rw-scrub-rail" ref={rail}>
        <span className="rw-scrub-fill" style={{ width: pct(t) }} />
        {timeline.spans.map((span, index) => (
          <span key={span.seq} className="rw-scrub-tick" data-tone={toneOf(span)} style={tickStyle(span.start, levels[index])} />
        ))}
        {timeline.pause ? <span className="rw-scrub-tick" data-kind="paused" style={tickStyle(timeline.pause.at, 0)} /> : null}
        {timeline.divergeAt !== null ? <span className="rw-scrub-fork" style={{ left: pct(timeline.divergeAt) }} /> : null}
        <span className="rw-scrub-thumb" style={{ left: pct(t) }} />
      </span>
    </div>
  )
}

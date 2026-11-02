/**
 * Small hooks for things on the page that move or change over time: whether
 * the person asked for reduced motion, a clock that ticks, and which keys of a
 * set of counts grew or appeared a moment ago.
 */
import { useEffect, useRef, useState } from 'react'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.(REDUCED_MOTION).matches ?? false)
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED_MOTION)
    if (!query) {
      return
    }

    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

/** `Date.now()`, updated every animation frame for `'frame'`, or every `every` ms. */
export function useNow(every: number | 'frame'): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (every !== 'frame') {
      const timer = window.setInterval(() => setNow(Date.now()), every)
      return () => window.clearInterval(timer)
    }

    let frame = requestAnimationFrame(function tick() {
      setNow(Date.now())
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [every])
  return now
}

export type Changes = { changed: Set<string>; added: Set<string> }

/**
 * Which keys grew in the last `ms`, and which appeared after the first render.
 * The first render marks nothing, so a page that opens full does not flash.
 */
export function useRecentChanges(values: Map<string, number>, ms: number): Changes {
  const previous = useRef<Map<string, number> | null>(null)
  const added = useRef(new Set<string>())
  const [changed, setChanged] = useState<Map<string, number>>(new Map())

  useEffect(() => {
    const before = previous.current
    previous.current = values
    if (!before) {
      return
    }

    const grown = [...values].filter(([key, value]) => (before.get(key) ?? 0) < value).map(([key]) => key)
    for (const [key] of values) {
      if (!before.has(key)) {
        added.current.add(key)
      }
    }

    if (grown.length === 0) {
      return
    }

    const until = Date.now() + ms
    setChanged((current) => new Map([...current, ...grown.map((key): [string, number] => [key, until])]))
  }, [values, ms])

  useEffect(() => {
    if (changed.size === 0) {
      return
    }

    const next = Math.min(...changed.values())
    const timer = window.setTimeout(() => {
      const now = Date.now()
      setChanged((current) => new Map([...current].filter(([, until]) => until > now)))
    }, Math.max(0, next - Date.now()))
    return () => window.clearTimeout(timer)
  }, [changed])

  return { changed: new Set(changed.keys()), added: added.current }
}

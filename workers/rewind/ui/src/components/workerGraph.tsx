/**
 * The run's workers on a ring. The entry worker starts alone at the top, and
 * each other worker joins as the first call to it leaves, while the ring makes
 * room for it. Each call is a pulse that leaves the caller, waits at the callee
 * with a ring that fills for the call's duration, and travels back with the
 * answer, in alert when the answer was an error. A paused fork's last pulse
 * stops at the callee with a warn ring. On the recording, a worker that went
 * away is dimmed until a worker with its name connects again, and the ring of
 * a call it was running breaks. Everything is drawn from the playhead, so the
 * same moment always draws the same picture. With reduced motion nothing
 * travels or moves aside: a call stays at its callee while it runs, its answer
 * shows by the caller once it is back, and workers appear in place.
 */
import type { KeyboardEvent } from 'react'
import type { Lane } from '../model/lanes'
import { type PlayClock, playSpan, toPlay, TRAVEL_MS } from '../model/playClock'
import { callsSoFar, isDown, previousStop, type Span, type Timeline } from '../model/timeline'

export type GraphNode = { lane: Lane; language?: string; calls: number }

type Point = { x: number; y: number }
type Curve = { from: Point; control: Point; to: Point }
type PulseKind = 'out' | 'answer' | 'error'
type Pulse = { key: string; at: Point; kind: PulseKind; tone: string; worker: string }
type HoldKind = 'running' | 'after' | 'paused' | 'broken'
type Hold = { key: string; worker: string; kind: HoldKind; progress: number }

const WIDTH = 400
const HEIGHT = 300
const CENTER: Point = { x: 200, y: 150 }
const RING = 104
const NODE_R = 20
const HOLD_GAP = 5
// Edges thicken a little with each call, up to a point.
const EDGE_BASE = 1
const EDGE_STEP = 0.6
const EDGE_MAX_STEPS = 4
const RING_PATH = 2 * Math.PI
/** How long the ring takes to make room for a worker that joins, in the player's ms at 1x. */
export const JOIN_MS = 300

const ease = (f: number) => (f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2)

const clamp01 = (f: number) => Math.min(1, Math.max(0, f))

/**
 * Angles for nodes that are partway joined. Each node takes a share of the
 * ring as big as its weight, so a node with a small weight appears between
 * its neighbours and grows to an even share as its weight reaches one.
 */
function ringAngles(weights: number[]): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0) || 1
  let before = 0
  return weights.map((w) => {
    const angle = -Math.PI / 2 + (RING_PATH * (before + w / 2 - weights[0] / 2)) / total
    before += w
    return angle
  })
}

function pointAt(angle: number): Point {
  return { x: CENTER.x + RING * Math.cos(angle), y: CENTER.y + RING * Math.sin(angle) }
}

// Bowed towards the middle, so edges from one node fan out instead of overlapping.
function curve(from: Point, to: Point): Curve {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
  return { from, to, control: { x: mid.x + (CENTER.x - mid.x) * 0.4, y: mid.y + (CENTER.y - mid.y) * 0.4 } }
}

function along(c: Curve, f: number): Point {
  const g = 1 - f
  return {
    x: g * g * c.from.x + 2 * g * f * c.control.x + f * f * c.to.x,
    y: g * g * c.from.y + 2 * g * f * c.control.y + f * f * c.to.y,
  }
}

function pathOf(c: Curve): string {
  return `M ${c.from.x} ${c.from.y} Q ${c.control.x} ${c.control.y} ${c.to.x} ${c.to.y}`
}

/** When each worker other than the entry joins, on the player's clock: the first call to it, or the pause. */
function joinTimes(timeline: Timeline, clock: PlayClock, entryWorker: string, pausedWorker: string | undefined): Map<string, number> {
  const times = new Map<string, number>()
  const join = (worker: string, at: number) => {
    if (worker !== entryWorker) {
      times.set(worker, Math.min(times.get(worker) ?? Number.POSITIVE_INFINITY, at))
    }
  }

  for (const span of timeline.spans) {
    join(span.who, toPlay(clock, span.start))
  }

  if (pausedWorker && timeline.pause) {
    join(pausedWorker, toPlay(clock, timeline.pause.at))
  }

  return times
}

/** `lastStep` is where reduced motion stopped before this, so only answers since then show. */
type Moment = { t: number; p: number; clock: PlayClock; reduced: boolean; lastStep: number; down: (worker: string) => boolean }

type Drawn = { pulses: Pulse[]; holds: Hold[] }

function progressOf(t: number, start: number, end: number): number {
  return end > start ? clamp01((t - start) / (end - start)) : 1
}

function drawSpan(span: Span, edge: Curve, tone: string, m: Moment): Drawn {
  const pulses: Pulse[] = []
  const holds: Hold[] = []
  const worker = span.who
  const key = `c${span.seq}`
  const answerKind: PulseKind = span.error ? 'error' : 'answer'
  const running: HoldKind = m.down(worker) ? 'broken' : 'running'
  if (span.gaveUp && m.t >= span.end && m.t < span.calleeEnd) {
    holds.push({ key: `${key}-after`, worker, kind: 'after', progress: progressOf(m.t, span.start, span.calleeEnd) })
  }

  const { from: pStart, to: pEnd } = playSpan(m.clock, span)
  if (m.reduced) {
    if (m.p >= pStart && m.p < pEnd) {
      pulses.push({ key, at: edge.to, kind: 'out', tone, worker })
      holds.push({ key, worker, kind: running, progress: progressOf(m.t, span.start, span.end) })
    }

    if (m.p >= pEnd && span.end >= m.lastStep) {
      pulses.push({ key: `${key}-back`, at: along(edge, 0.2), kind: answerKind, tone, worker })
    }

    return { pulses, holds }
  }

  const outward = Math.min(TRAVEL_MS, (pEnd - pStart) * 0.6)
  if (m.p >= pStart && m.p < pStart + outward) {
    pulses.push({ key, at: along(edge, ease((m.p - pStart) / outward)), kind: 'out', tone, worker })
  }

  if (m.p >= pStart + outward && m.p < pEnd) {
    holds.push({ key, worker, kind: running, progress: progressOf(m.t, span.start, span.end) })
  }

  if (m.p >= pEnd && m.p < pEnd + TRAVEL_MS) {
    pulses.push({ key: `${key}-back`, at: along(edge, 1 - ease((m.p - pEnd) / TRAVEL_MS)), kind: answerKind, tone, worker })
  }

  return { pulses, holds }
}

function drawPause(timeline: Timeline, edge: Curve | undefined, worker: string, tone: string, m: Moment): Drawn {
  const pause = timeline.pause
  if (!pause || !edge || m.t < pause.at) {
    return { pulses: [], holds: [] }
  }

  const travelled = m.reduced ? 1 : clamp01((m.p - toPlay(m.clock, pause.at)) / TRAVEL_MS)
  const pulses: Pulse[] = [{ key: 'pause', at: along(edge, ease(travelled)), kind: 'out', tone, worker }]
  const holds: Hold[] = travelled >= 1 ? [{ key: 'pause', worker, kind: 'paused', progress: 1 }] : []
  return { pulses, holds }
}

const FILLED: Record<HoldKind, boolean> = { running: true, after: true, paused: false, broken: false }

function HoldRing({ hold, at, index, tone }: { hold: Hold; at: Point; index: number; tone: string }) {
  const r = NODE_R + HOLD_GAP + index * HOLD_GAP
  const length = RING_PATH * r
  return (
    <g className="rw-graph-hold" data-kind={hold.kind} data-tone={tone}>
      <circle className="rw-graph-hold-track" cx={at.x} cy={at.y} r={r} />
      {FILLED[hold.kind] ? (
        <circle
          className="rw-graph-hold-fill"
          cx={at.x}
          cy={at.y}
          r={r}
          strokeDasharray={`${hold.progress * length} ${length}`}
          transform={`rotate(-90 ${at.x} ${at.y})`}
        />
      ) : null}
    </g>
  )
}

type EdgeState = 'active' | 'used' | 'idle'

function edgeState(worker: string, calls: number, working: Set<string>): EdgeState {
  if (working.has(worker)) {
    return 'active'
  }

  return calls > 0 ? 'used' : 'idle'
}

// A worker that stopped, or a host outside iii, says so on a line of its own, further from the node.
const SECOND_LINE = 15

type LabelPlace = { x: number; y: number; anchor: 'start' | 'middle' | 'end'; above: boolean }

function labelPlacement(at: Point, under = false): LabelPlace {
  const dx = at.x - CENTER.x
  const dy = at.y - CENTER.y
  // Clear of the rings a busy node gets.
  const away = NODE_R + 18
  // A host's name is long, so it goes under the node, where it has the node's whole width.
  if (under) {
    return { x: at.x, y: at.y + away + 6, anchor: 'middle', above: false }
  }

  const length = Math.hypot(dx, dy) || 1
  const x = at.x + (dx / length) * away
  const y = at.y + (dy / length) * away
  if (Math.abs(dx) < 12) {
    return { x, y: dy < 0 ? y - 4 : y + 10, anchor: 'middle', above: dy < 0 }
  }

  return { x, y: y + 4, anchor: dx > 0 ? 'start' : 'end', above: false }
}

export type WorkerGraphProps = {
  nodes: GraphNode[]
  entryWorker: string
  timeline: Timeline
  clock: PlayClock
  /** The playhead on the player's clock, and the run's time there. */
  p: number
  t: number
  reduced: boolean
  pausedWorker?: string
  onSelectWorker: (worker: string) => void
}

export function WorkerGraph(props: WorkerGraphProps) {
  const { nodes, entryWorker, timeline, clock, p, t, reduced, pausedWorker, onSelectWorker } = props
  const m: Moment = { t, p, clock, reduced, lastStep: previousStop(timeline, t), down: (worker) => isDown(timeline, worker, t) }

  const joins = joinTimes(timeline, clock, entryWorker, pausedWorker)
  const weightOf = (worker: string): number => {
    if (worker === entryWorker) {
      return 1
    }

    const at = joins.get(worker)
    if (at === undefined || p < at) {
      return 0
    }

    return reduced ? 1 : ease(clamp01((p - at) / JOIN_MS))
  }
  const entryNode = nodes.find((n) => n.lane.worker === entryWorker)
  const joining = nodes
    .filter((n) => n.lane.worker !== entryWorker && weightOf(n.lane.worker) > 0)
    .sort((a, b) => (joins.get(a.lane.worker) ?? 0) - (joins.get(b.lane.worker) ?? 0))
  const onRing = entryNode ? [entryNode, ...joining] : joining
  const weights = onRing.map((n) => weightOf(n.lane.worker))
  const angles = ringAngles(weights)
  const points = new Map(onRing.map((n, i) => [n.lane.worker, pointAt(angles[i])]))
  const shown = new Map(onRing.map((n, i) => [n.lane.worker, weights[i]]))

  const origin = points.get(entryWorker) ?? pointAt(-Math.PI / 2)
  const edges = new Map(joining.map((n) => [n.lane.worker, curve(origin, points.get(n.lane.worker)!)]))
  const toneOf = new Map(nodes.map((n) => [n.lane.worker, n.lane.tone as string]))
  const outside = new Set(nodes.filter((n) => n.lane.outside).map((n) => n.lane.worker))
  const counts = callsSoFar(timeline, t)

  const drawn = timeline.spans.map((span) => {
    const edge = edges.get(span.who) ?? curve(origin, origin)
    return drawSpan(span, edge, toneOf.get(span.who) ?? 'blue', m)
  })
  const paused = pausedWorker ? drawPause(timeline, edges.get(pausedWorker), pausedWorker, toneOf.get(pausedWorker) ?? 'blue', m) : { pulses: [], holds: [] }
  const pulses = [...drawn.flatMap((d) => d.pulses), ...paused.pulses]
  const holds = [...drawn.flatMap((d) => d.holds), ...paused.holds]
  const busy = new Set(holds.filter((h) => h.kind !== 'after').map((h) => h.worker))
  const working = new Set([...busy, ...pulses.filter((pulse) => pulse.kind === 'out').map((pulse) => pulse.worker)])

  const onKey = (worker: string) => (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelectWorker(worker)
    }
  }

  return (
    // lint-allow no-inline-svg: the graph is data drawn from the playhead, not an icon.
    <svg className="rw-graph" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="group" aria-label="Workers and the calls between them">
      {[...edges].map(([worker, edge]) => {
        const count = counts.get(worker) ?? 0
        const width = EDGE_BASE + EDGE_STEP * Math.min(EDGE_MAX_STEPS, Math.max(0, count - 1))
        return (
          <path
            key={worker}
            className="rw-graph-edge"
            data-state={edgeState(worker, count, working)}
            data-down={m.down(worker) || undefined}
            data-outside={outside.has(worker) || undefined}
            d={pathOf(edge)}
            strokeWidth={width}
            style={{ ['--rw-shown' as string]: shown.get(worker) ?? 1 }}
          />
        )
      })}
      {pulses.map((pulse) => (
        <circle key={pulse.key} className="rw-graph-pulse" data-kind={pulse.kind} data-tone={pulse.tone} cx={pulse.at.x} cy={pulse.at.y} r={pulse.kind === 'out' ? 4.5 : 4} />
      ))}
      {onRing.map((node) => {
        const at = points.get(node.lane.worker)!
        const Icon = node.lane.icon
        const label = labelPlacement(at, node.lane.outside)
        const worker = node.lane.worker
        const entry = worker === entryWorker
        const down = m.down(worker)
        const calls = node.calls === 1 ? 'one' : String(node.calls)
        const name = entry ? `${worker}, where the run starts` : `${worker}${node.lane.outside ? ', outside iii,' : ''} gets ${calls} ${node.lane.outside ? 'request' : 'call'}${node.calls === 1 ? '' : 's'}`
        return (
          <g
            key={worker}
            className="rw-graph-node"
            data-tone={node.lane.tone}
            data-busy={busy.has(worker) || undefined}
            data-down={down || undefined}
            data-outside={node.lane.outside || undefined}
            style={{ ['--rw-shown' as string]: shown.get(worker) ?? 1 }}
            role={entry ? 'img' : 'button'}
            tabIndex={entry ? -1 : 0}
            aria-label={entry ? name : `${name}${down ? ' and has stopped' : ''}. Select to move the playhead to its next call.`}
            onClick={entry ? undefined : () => onSelectWorker(worker)}
            onKeyDown={entry ? undefined : onKey(worker)}
          >
            <circle className="rw-graph-disc" cx={at.x} cy={at.y} r={NODE_R} />
            <Icon className="rw-graph-icon" x={at.x - 8} y={at.y - 8} width={16} height={16} aria-hidden />
            <text className="rw-graph-label" x={label.x} y={label.y} textAnchor={label.anchor}>
              {worker}
              {node.language ? <tspan className="rw-graph-lang">{` ${node.language}`}</tspan> : null}
            </text>
          </g>
        )
      })}
      {onRing
        .filter((node) => node.lane.outside || m.down(node.lane.worker))
        .map((node) => {
          const label = labelPlacement(points.get(node.lane.worker)!, node.lane.outside)
          const stopped = m.down(node.lane.worker)
          return (
            <text
              key={`${node.lane.worker}-second-line`}
              className={stopped ? 'rw-graph-label rw-graph-second rw-graph-stopped' : 'rw-graph-label rw-graph-second rw-graph-lang'}
              x={label.x}
              y={label.y + (label.above ? -SECOND_LINE : SECOND_LINE)}
              textAnchor={label.anchor}
              style={{ ['--rw-shown' as string]: shown.get(node.lane.worker) ?? 1 }}
            >
              {stopped ? 'Stopped' : 'outside iii'}
            </text>
          )
        })}
      {holds.map((hold) => {
        const sameWorker = holds.filter((h) => h.worker === hold.worker)
        return <HoldRing key={hold.key} hold={hold} at={points.get(hold.worker) ?? CENTER} index={sameWorker.indexOf(hold)} tone={toneOf.get(hold.worker) ?? 'blue'} />
      })}
    </svg>
  )
}

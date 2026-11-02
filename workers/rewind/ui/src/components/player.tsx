/**
 * Plays one line back in time: a waterfall of its calls and a ring of its
 * workers, both drawn from one playhead. It opens in place of the call list
 * and starts playing; closing it hands back the call the playhead stopped on,
 * so the list opens there. The playhead moves on the player's own clock (see
 * playClock.ts), and everything on screen reads the run's time from it. With
 * reduced motion it steps from one call to the next instead of moving between
 * them. The run's keyboard commands reach it through `handle`.
 */
import { IconButton, KeyCombo, SegmentedControl, Toolbar, Tooltip } from '@iii-dev/console-ui'
import { Info, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react'
import { type RefObject, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { FunctionRow, RunRow, WorkerChange } from '../client/types'
import { useWorkerLanguages } from '../data/useWorkerLanguages'
import { iconFor, type Lane, laneOf, TONES, workerOf } from '../model/lanes'
import { type Cursor, type Line, ordinal } from '../model/lines'
import { stoppedFunction } from '../model/lost'
import { callName } from '../model/requests'
import { playClock, playLength, toPlay, toRun } from '../model/playClock'
import { buildTimeline, cursorAt, type LostCall, nextStop, previousStop, type Span, spanAt, type Timeline } from '../model/timeline'
import { useReducedMotion } from './motion'
import { Scrubber } from './scrubber'
import type { TraceLinks } from './traceLink'
import { Waterfall } from './waterfall'
import { type GraphNode, WorkerGraph } from './workerGraph'

export type PlayerHandle = {
  toggle: () => void
  step: (by: 1 | -1) => void
  faster: () => void
  slower: () => void
  close: () => void
}

const SPEEDS = ['0.5', '1', '2', '4'] as const
type Speed = (typeof SPEEDS)[number]

// With reduced motion each call is shown for this long at 1x before the next.
const STEP_MS = 900

const SPEED_OPTIONS = SPEEDS.map((speed) => ({ value: speed, label: `${speed}x`, icon: false as const }))

const ESTIMATED = 'Estimated timings'

const ESTIMATED_WHY = 'No timing recorded'

const msFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

function ms(value: number): string {
  return `${msFormat.format(Math.round(value))} ms`
}

function where(timeline: Timeline, t: number): string {
  if (timeline.pause && t >= timeline.pause.at) {
    return `Paused at ${callName(timeline.pause.functionId)}`
  }

  if (t >= timeline.ends) {
    return 'Ended'
  }

  const span = spanAt(timeline, t)
  if (!span) {
    return 'No calls'
  }

  return span.lost ? span.summary : `Call ${span.number}/${timeline.spans.filter((s) => !s.lost).length} · ${callName(span.call.function_id)}`
}

function divergeLabel(line: Line, timeline: Timeline): string | undefined {
  if (timeline.divergeAt === null || line.branchAt === null) {
    return undefined
  }

  return `${line.label} diverges at call ${ordinal(line, line.branchAt)} · ${ms(timeline.divergeAt)}`
}

/** The workers this line reaches, in the order the run's lanes give them, so tones match the call list. */
function graphNodes(timeline: Timeline, lanes: Lane[], reached: string[], languages: Record<string, string>): GraphNode[] {
  const counts = new Map<string, number>()
  for (const span of timeline.spans) {
    counts.set(span.who, (counts.get(span.who) ?? 0) + 1)
  }

  return lanes.filter((l) => reached.includes(l.worker)).map((lane) => ({ lane, language: languages[lane.worker], calls: counts.get(lane.worker) ?? 0 }))
}

/** The call a dead worker took with it, from the run's output, or from the worker that went away. */
function lostCallOf(line: Line, run: RunRow, functions: FunctionRow[], changes: WorkerChange[] | undefined): LostCall | null {
  if (!line.lost) {
    return null
  }

  const functionId = stoppedFunction(run)
  if (functionId) {
    return { functionId, worker: workerOf(functionId, functions) }
  }

  const gone = changes?.find((c) => c.event === 'disconnected')?.worker
  return gone ? { worker: gone } : null
}

/** The run's lanes, with one more for a worker that only the lost call reached. */
function withWorker(lanes: Lane[], worker: string | undefined): Lane[] {
  if (!worker || lanes.some((l) => l.worker === worker)) {
    return lanes
  }

  return [...lanes, { worker, tone: TONES[lanes.length % TONES.length], icon: iconFor(worker) }]
}

export type PlayerProps = {
  client: RewindClient
  line: Line
  original: Line
  run: RunRow
  entry: string
  functions: FunctionRow[]
  /** Only for the recording; forks run against stubs and copies, not the workers that came and went. */
  workerChanges?: WorkerChange[]
  lanes: Lane[]
  handle: RefObject<PlayerHandle | null>
  /** Called when the call under the playhead changes. */
  onCursor?: (cursor: Cursor) => void
  onClose: (cursor: Cursor) => void
  links: TraceLinks
}

export function Player(props: PlayerProps) {
  const { client, line, original, run, entry, functions, workerChanges, handle, onCursor, onClose } = props
  const lost = useMemo(() => lostCallOf(line, run, functions, workerChanges), [line, run, functions, workerChanges])
  const lanes = withWorker(props.lanes, lost?.worker)
  const laneFor = (functionId: string, worker?: string): Lane => laneOf(lanes, functionId, worker, functions)
  const timeline = useMemo(() => buildTimeline(line, original, run, { lost, workerChanges }), [line, original, run, lost, workerChanges])
  const clock = useMemo(() => playClock(timeline), [timeline])
  const reduced = useReducedMotion()
  const languages = useWorkerLanguages(client)
  const length = playLength(clock)
  const [p, setP] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState<Speed>('1')
  const [held, setHeld] = useState(false)
  const rate = Number(speed)
  const t = toRun(clock, p)
  const ended = p >= length

  // Smooth playback: each frame moves the player's clock by the time that passed.
  useEffect(() => {
    if (!playing || held || reduced) {
      return
    }

    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const passed = now - last
      last = now
      setP((prev) => Math.min(length, prev + passed * rate))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, held, reduced, length, rate])

  // Reduced motion: one call at a time, no frames in between.
  useEffect(() => {
    if (!playing || held || !reduced || ended) {
      return
    }

    const timer = window.setTimeout(() => setP((prev) => toPlay(clock, nextStop(timeline, toRun(clock, prev)))), STEP_MS / rate)
    return () => window.clearTimeout(timer)
  }, [playing, held, reduced, ended, rate, p, clock, timeline])

  useEffect(() => {
    if (ended && playing) {
      setPlaying(false)
    }
  }, [ended, playing])

  const playheadCursor = cursorAt(timeline, t)
  useEffect(() => {
    onCursor?.(playheadCursor)
  }, [onCursor, playheadCursor])

  const seek = (next: number) => setP(toPlay(clock, Math.min(timeline.duration, Math.max(0, next))))

  const toggle = () => {
    if (playing) {
      setPlaying(false)
      return
    }

    if (ended) {
      setP(0)
    }

    setPlaying(true)
  }

  const stepCall = (by: 1 | -1) => {
    setPlaying(false)
    seek(by === 1 ? nextStop(timeline, t) : previousStop(timeline, t))
  }

  const changeSpeed = (by: 1 | -1) => {
    const index = SPEEDS.indexOf(speed)
    setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, index + by))])
  }

  const close = () => onClose(cursorAt(timeline, t))

  const select = (span: Span) => {
    setPlaying(false)
    seek(span.start)
  }

  const selectWorker = (worker: string) => {
    const calls = timeline.spans.filter((s) => s.who === worker)
    const next = calls.find((s) => s.start > t + 0.01) ?? calls[0]
    if (next) {
      select(next)
    }
  }

  const latest = useRef({ toggle, stepCall, changeSpeed, close })
  latest.current = { toggle, stepCall, changeSpeed, close }
  useImperativeHandle(
    handle,
    () => ({
      toggle: () => latest.current.toggle(),
      step: (by) => latest.current.stepCall(by),
      faster: () => latest.current.changeSpeed(1),
      slower: () => latest.current.changeSpeed(-1),
      close: () => latest.current.close(),
    }),
    [],
  )

  const current = spanAt(timeline, t)
  const entryLane = laneFor(entry)
  const pausedWorker = timeline.pause ? laneFor(timeline.pause.functionId).worker : undefined
  const reached = [entryLane.worker, ...timeline.spans.map((s) => s.who), ...(pausedWorker ? [pausedWorker] : [])]
  const nodes = graphNodes(timeline, lanes, reached, languages)
  const fork = divergeLabel(line, timeline)
  const position = where(timeline, t)

  return (
    <section className="rw-player" aria-label={`Playback of ${line.label.toLowerCase()}`}>
      <Toolbar
        aria-label="Playback"
        className="rw-player-bar"
        end={
          <>
            <SegmentedControl variant="radio" aria-label="Speed" options={SPEED_OPTIONS} value={speed} onChange={(next) => setSpeed(next)} className="rw-speed" />
            <IconButton label="Close the player" tooltip={<>Close the player <KeyCombo binding="Escape" /></>} onClick={close}>
              <X aria-hidden />
            </IconButton>
          </>
        }
      >
        <IconButton label={playing ? 'Pause' : 'Play'} tooltip={<>{playing ? 'Pause' : 'Play'} <KeyCombo binding="Alt+K" /></>} onClick={toggle} className="rw-play">
          {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        </IconButton>
        <IconButton label="Previous call" tooltip={<>Previous call <KeyCombo binding="Alt+ArrowUp" /></>} onClick={() => stepCall(-1)} disabled={p <= 0}>
          <SkipBack aria-hidden />
        </IconButton>
        <IconButton label="Next call" tooltip={<>Next call <KeyCombo binding="Alt+ArrowDown" /></>} onClick={() => stepCall(1)} disabled={ended}>
          <SkipForward aria-hidden />
        </IconButton>
        <span className="rw-player-time" aria-live="off">
          <span className="rw-player-now">{ms(t)}</span>
          <span className="rw-player-total">of {ms(timeline.duration)}</span>
        </span>
        <span className="rw-player-where">{position}</span>
        {timeline.placed ? (
          <Tooltip label={ESTIMATED_WHY}>
            <span className="rw-player-estimated" tabIndex={0}>
              <Info aria-hidden />
              <span className="rw-player-estimated-text">{ESTIMATED}</span>
            </span>
          </Tooltip>
        ) : null}
      </Toolbar>
      <div className="rw-player-body">
        <Waterfall
          line={line}
          timeline={timeline}
          clock={clock}
          p={p}
          t={t}
          entry={entry}
          entryLane={entryLane}
          laneFor={laneFor}
          current={current}
          onSelect={select}
          divergeLabel={fork}
          links={props.links}
          scrubber={
            <Scrubber
              timeline={timeline}
              t={t}
              toneOf={(span) => laneFor(span.call.function_id, span.call.worker).tone}
              label={fork ? `Playhead. ${fork}` : 'Playhead'}
              valueText={`${ms(t)}, ${position}`}
              onSeek={seek}
              onHold={setHeld}
            />
          }
        />
        <div className="rw-player-graph">
          <WorkerGraph
            nodes={nodes}
            entryWorker={entryLane.worker}
            timeline={timeline}
            clock={clock}
            p={p}
            t={t}
            reduced={reduced}
            pausedWorker={pausedWorker}
            onSelectWorker={selectWorker}
          />
        </div>
      </div>
    </section>
  )
}

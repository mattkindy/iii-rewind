/**
 * Who takes part in a run, for the call list, the lanes and the player: one
 * lane per worker, each with a glyph and a glyph tone, plus one per host that a
 * request went to around iii. Tones go out to workers in order of first
 * appearance, so the entry's worker is always blue and the colours stay put
 * while you step. A host gets no worker's tone and an icon no worker gets.
 */
import type { LucideIcon } from 'lucide-react'
import { Bot, Box, Clock, Globe, Mail, Sparkles, Wrench } from 'lucide-react'
import type { Call } from '../client/types'
import type { Line } from './lines'
import { hostOf, parseRequestId, participantOf } from './requests'

export const TONES = ['blue', 'teal', 'purple', 'amber', 'green', 'rose'] as const

export type ToneName = (typeof TONES)[number]

/** `outside` is a host a request went to, outside iii. */
export type Lane = { worker: string; tone: ToneName | 'outside'; icon: LucideIcon; outside?: boolean }

export type Participant = { name: string; outside: boolean }

const ICON_HINTS: { match: RegExp; icon: LucideIcon }[] = [
  { match: /agent|bot|assistant/, icon: Bot },
  { match: /clock|time|cron/, icon: Clock },
  { match: /model|llm|ai\b/, icon: Sparkles },
  { match: /mail|email|smtp/, icon: Mail },
  { match: /tool|calendar/, icon: Wrench },
]

export function iconFor(worker: string): LucideIcon {
  return ICON_HINTS.find((h) => h.match.test(worker.toLowerCase()))?.icon ?? Box
}

export function hostLane(host: string): Lane {
  return { worker: host, tone: 'outside', icon: Globe, outside: true }
}

/** Lanes for the entry worker and everyone after it, in order of first appearance. */
export function lanesFor(entryWorker: string, participants: Participant[]): Lane[] {
  const unique = [{ name: entryWorker, outside: false }, ...participants].filter((p, i, all) => all.findIndex((q) => q.name === p.name) === i)
  let toned = 0
  return unique.map((p) => {
    if (p.outside) {
      return hostLane(p.name)
    }

    const lane: Lane = { worker: p.name, tone: TONES[toned % TONES.length], icon: iconFor(p.name) }
    toned += 1
    return lane
  })
}

type FunctionWorker = { function_id: string; worker: string }

/** The worker that owns a function, from `rewind::functions`, else the id's namespace. */
export function workerOf(functionId: string, functions: FunctionWorker[]): string {
  const request = parseRequestId(functionId)
  if (request) {
    return hostOf(request.url)
  }

  return functions.find((f) => f.function_id === functionId)?.worker ?? functionId.split('::')[0]
}

/** Everyone a set of calls reaches, including a paused call's callee, in call order. */
export function workersIn(calls: Call[], pausedFunctions: string[], functions: FunctionWorker[]): Participant[] {
  return [
    ...calls.map((c) => participantOf(c.function_id, c.worker)),
    ...pausedFunctions.map((fn) => participantOf(fn, workerOf(fn, functions))),
  ]
}

/** Lanes for the entry's worker and everyone a run's lines reach, including the callee of a paused call. */
export function lanesOfLines(lines: Line[], entry: string, functions: FunctionWorker[]): Lane[] {
  const paused = lines.flatMap((line) => (line.outcome.state === 'paused' ? [line.outcome.need.function_id] : []))
  return lanesFor(workerOf(entry, functions), workersIn(lines.flatMap((line) => line.calls), paused, functions))
}

/** The lane a call belongs to: its host for a request, else its worker's, else the first lane. */
export function laneOf(lanes: Lane[], functionId: string, worker: string | undefined, functions: FunctionWorker[]): Lane {
  const request = parseRequestId(functionId)
  const name = request ? hostOf(request.url) : (worker ?? workerOf(functionId, functions))
  return lanes.find((l) => l.worker === name) ?? (request ? hostLane(name) : lanes[0])
}

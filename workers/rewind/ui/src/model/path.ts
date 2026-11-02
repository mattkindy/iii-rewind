/**
 * The path a fork took, said in a few parts for the line above its calls:
 * how many calls ran live or got a person's answer, and each call filled from
 * another run, with that run. The ending is said by the caller, which knows
 * how a line's outcome reads.
 */
import type { AnswerSource, Call } from '../client/types'
import { shortId } from './format'
import type { Line } from './lines'
import { callName } from './requests'

// Edited is left out: the fork exists because of the edit, and its row says so.
const COUNTED: { source: AnswerSource; label: string }[] = [
  { source: 'live', label: 'live' },
  { source: 'typed', label: 'typed' },
  { source: 'injected', label: 'injected' },
]

type FilledGroup = { functionId: string; from?: string; count: number }

function filledGroups(calls: Call[]): FilledGroup[] {
  const groups = new Map<string, FilledGroup>()
  for (const call of calls.filter((c) => c.source === 'filled')) {
    const key = `${call.function_id} ${call.filled_from ?? ''}`
    const group = groups.get(key) ?? { functionId: call.function_id, from: call.filled_from, count: 0 }
    groups.set(key, { ...group, count: group.count + 1 })
  }

  return [...groups.values()]
}

function filledPart(group: FilledGroup): string {
  const times = group.count > 1 ? ` ×${group.count}` : ''
  const from = group.from ? `run ${shortId(group.from)}` : 'another run'
  return `${callName(group.functionId)}${times} filled from ${from}`
}

/** Such as ["3 live", "email::send filled from run 849b62e"]. */
export function pathParts(line: Line): string[] {
  const counts = COUNTED.map(({ source, label }) => ({ label, count: line.calls.filter((c) => c.source === source).length }))
    .filter((c) => c.count > 0)
    .map((c) => `${c.count} ${c.label}`)
  return [...counts, ...filledGroups(line.calls).map(filledPart)]
}

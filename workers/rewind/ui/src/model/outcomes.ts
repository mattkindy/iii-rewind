/**
 * How a line's ending reads: a short label for chips and endings ("Threw
 * SyntaxError"), a phrase to follow a line's name ("Fork 1 returned booked"),
 * and a tone. A run that returned the sample app's `failed` reads as a
 * warning, since the agent finished but could not do what was asked.
 */
import type { ChipTone } from '@iii-dev/console-ui'
import type { ForkOutcome } from '../client/types'
import { errorLabel, summarizeValue } from './answers'
import { outputStatus, returnedFailed } from './appOutput'
import { type Cases, caseOf } from './cases'
import type { LineOutcome } from './lines'
import { callName } from './requests'

export type OutcomeLook = { tone: ChipTone; short: string; phrase: string }

const OUTCOMES: Cases<LineOutcome, OutcomeLook> = {
  done: ({ output }) => {
    const status = outputStatus(output) ?? summarizeValue(output)
    return { tone: returnedFailed(output) ? 'warning' : 'success', short: `Returned ${status}`, phrase: `returned ${status}` }
  },
  crashed: ({ error }) => {
    const name = errorLabel(error)
    return { tone: 'danger', short: `Threw ${name}`, phrase: `threw ${name}` }
  },
  paused: ({ need }) => {
    const fn = callName(need.function_id)
    return { tone: 'warning', short: `Paused at ${fn}`, phrase: `paused at ${fn}` }
  },
  stopped: () => ({ tone: 'neutral', short: 'Stopped', phrase: 'cut off' }),
}

export function outcomeLook(outcome: LineOutcome): OutcomeLook {
  return caseOf(outcome, 'state', OUTCOMES)
}

/** How a run ended, as one entry of a tally: "booked", "threw TypeError", "paused at email::send". */
export function tallyWord(outcome: ForkOutcome): string {
  if (outcome.state === 'paused') {
    return `paused at ${outcome.need.function_id}`
  }

  const status = outcome.state === 'done' ? outputStatus(outcome.output) : undefined
  return status ?? outcomeLook(outcome).phrase
}

/** "19 booked, 4 threw TypeError", most common first. */
export function outcomeTally(outcomes: ForkOutcome[]): string {
  const counts = new Map<string, number>()
  for (const outcome of outcomes) {
    const word = tallyWord(outcome)
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word, n]) => `${n} ${word}`)
    .join(', ')
}

/**
 * What a person has picked at a paused call, and whether it can be sent. Only
 * a typed answer can be wrong: text that is not JSON can't be sent at all,
 * and an answer that breaks the function's schema can, with a warning, to see
 * how the code copes with it.
 */
import type { Choice } from '../client/types'
import { parseTypedText } from './answers'
import { type AnswerCheck, problemsText, textProblems } from './schema'

export type DecisionState = { choice: Choice; typed: string; autoRead: boolean }

/** Why the typed answer can't be sent yet, or null when it can. */
export function typedProblem(state: DecisionState): string | null {
  if (state.choice !== 'typed') {
    return null
  }

  return parseTypedText(state.typed).ok ? null : 'Invalid JSON'
}

/** How the typed answer breaks the function's schema, or null when it fits or isn't typed. */
export function typedWarning(state: DecisionState, check?: AnswerCheck): string | null {
  if (state.choice !== 'typed' || typedProblem(state) !== null) {
    return null
  }

  const problems = textProblems(state.typed, check)
  return problems.length > 0 ? problemsText(problems) : null
}

export function typedIsValid(state: DecisionState): boolean {
  return typedProblem(state) === null
}

/** What `rewind::answer` gets as `value`: the typed answer's JSON, or nothing for any other choice. */
export function decisionValue(state: DecisionState): unknown {
  const parsed = state.choice === 'typed' ? parseTypedText(state.typed) : undefined
  return parsed?.ok ? parsed.value : undefined
}

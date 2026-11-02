/**
 * The four things a person can do at a paused call, with the copy for each and
 * the reason a choice is ruled out. Which choices are allowed comes from the
 * core (`need.choices`); the reasons follow the core's table of what each
 * choice does.
 */
import type { Choice, Fork, ForkMode, PausedNeed, PauseReason } from '../client/types'
import { bodyWasCut } from './requests'

export type ChoiceInfo = {
  title: string
  /** The title in a recovery, where the fork is the person's attempt to finish the run. */
  recoverTitle?: string
  shortcut?: string
  /** A short status line under the title, or undefined when the title says it all. */
  describe: (need: PausedNeed, mode: Fork['mode']) => string | undefined
}

export const EFFECTS_UNKNOWN = 'Effects unknown'

/** Sending a call whose function declares no effects, in a recovery. */
export const MAY_REPEAT = `${EFFECTS_UNKNOWN} · may repeat a side effect`

/** Why the fork paused. An older core sends no reason, so whether this is the run's lost call decides. */
export function pauseReason(need: PausedNeed, lostHere: boolean): PauseReason {
  return need.reason ?? (lostHere ? 'lost' : 'no_answer')
}

// Only a call its worker died while running may have reached the provider.
const mayHaveReachedProvider = (need: PausedNeed): boolean => need.reason === 'lost'

const describeLive = (need: PausedNeed, mode: Fork['mode']): string => {
  if (mode === 'recover' && need.effects.length === 0) {
    return MAY_REPEAT
  }

  if (need.effects.includes('irreversible') && mode === 'recover') {
    return mayHaveReachedProvider(need) ? 'Check the provider first' : 'Not sent yet'
  }

  if (need.effects.some((e) => e === 'read-only' || e === 'pure')) {
    return 'Read-only'
  }

  return 'External · not irreversible'
}

export const CHOICES: Record<Choice, ChoiceInfo> = {
  live: { title: 'Run live', recoverTitle: 'Send now', shortcut: 'Alt+L', describe: describeLive },
  typed: {
    title: 'Type answer',
    recoverTitle: 'Already sent',
    shortcut: 'Alt+A',
    describe: (need, mode) => {
      if (mode !== 'recover') {
        return undefined
      }

      return mayHaveReachedProvider(need) ? 'If it went through, enter its result' : 'Enter its result without sending'
    },
  },
  inject: {
    title: 'Inject error',
    shortcut: 'Alt+I',
    describe: () => 'Returns UNAVAILABLE',
  },
  stop: {
    title: 'Discard fork',
    recoverTitle: 'Skip run',
    describe: (_need, mode) => (mode === 'recover' ? 'Discard the recovery' : undefined),
  },
}

/** What the person is answering for: a fork they made, or a replay that took a new path. */
export type PausedLine = 'fork' | 'replay'

export function choiceTitle(choice: Choice, mode: Fork['mode'], line: PausedLine = 'fork'): string {
  const info = CHOICES[choice]
  if (mode === 'recover') {
    return info.recoverTitle ?? info.title
  }

  return info.title.replace('fork', line)
}

export function choiceDescription(choice: Choice, need: PausedNeed, mode: Fork['mode'], line: PausedLine = 'fork'): string | undefined {
  return CHOICES[choice].describe(need, mode)?.replace(/\bfork\b/, line)
}

export const CHOICE_ORDER: Choice[] = ['live', 'typed', 'inject', 'stop']

/** The button that applies the picked choice, in each mode. */
export const CONTINUE_LABEL: Record<ForkMode, Record<Choice, string>> = {
  debug: { live: 'Continue', typed: 'Continue', inject: 'Continue', stop: 'Discard fork' },
  recover: { live: 'Send', typed: 'Continue', inject: 'Continue', stop: 'Skip run' },
}

type Rule = { when: (effects: string[]) => boolean; reason: string }

// Why a debug fork doesn't run a call live, first match wins. Only `live` depends on effects.
const LIVE_BLOCKED: Rule[] = [
  { when: (e) => e.includes('irreversible'), reason: 'Irreversible' },
  { when: (e) => e.includes('writes'), reason: 'Writes iii state' },
  { when: (e) => e.length === 0, reason: 'No effects declared · treated as irreversible' },
]

/** Why a request can't run live when the preload cut its body: only the start of it would go out. */
export const BODY_CUT = 'Body cut off · never sent live'

/** Why these effects keep a call from running live in a debug fork, or undefined when nothing does. */
export function notLiveReason(effects: string[]): string | undefined {
  return LIVE_BLOCKED.find((r) => r.when(effects))?.reason
}

export function blockedReason(choice: Choice, need: PausedNeed): string | undefined {
  if (need.choices.includes(choice)) {
    return undefined
  }

  if (choice !== 'live') {
    return 'Not available'
  }

  if (bodyWasCut(need.input)) {
    return BODY_CUT
  }

  return notLiveReason(need.effects) ?? 'Not run live in this fork'
}

/** What each declared effect means for a fork, for the paused call's details. */
export const EFFECT_MEANING: Record<string, string> = {
  pure: 'Same input, same output · may run live',
  'read-only': 'No side effects · may run live',
  external: 'Calls outside iii · live unless irreversible',
  irreversible: "Can't be undone · never live in a debug fork",
  writes: 'Writes iii state · never live',
}

export const NO_EFFECTS = 'No effects declared · treated as irreversible'

const SAFE_LIVE = ['pure', 'read-only', 'external']

/**
 * What a person most likely wants: live when it is allowed, otherwise typing
 * the answer. In a recovery a call the core would not run by itself, such as
 * an irreversible one, a write, or one whose effects nobody declared, starts
 * on Skip, so nothing is sent until a person picks Send now.
 */
export function defaultChoice(need: PausedNeed, mode: Fork['mode'] = 'debug'): Choice {
  const safe = need.effects.length > 0 && need.effects.every((effect) => SAFE_LIVE.includes(effect))
  if (mode === 'recover' && !safe) {
    return 'stop'
  }

  return need.choices.includes('live') ? 'live' : 'typed'
}

export function isChoice(value: string): value is Choice {
  return (CHOICE_ORDER as string[]).includes(value)
}

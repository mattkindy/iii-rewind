/**
 * What a re-execution does with a step that was in flight when its worker died: the journal has
 * its intent and no result, so nobody knows whether the callee did the work. The answer comes
 * from what the callee's function declares in its metadata: its `effects`, the same vocabulary
 * Rewind uses, and `idempotency_key: true` when it drops a call whose key it has seen before.
 */

/** `again` sends the step once more, `keyed` sends it with the same idempotency key, `pause` waits for a person. */
export type Resume = 'again' | 'keyed' | 'pause'

export type Callee = { effects: string[]; takesKey: boolean }

// A step whose effects are all in this set changes nothing a second call could break: reading,
// or asking an outside service a question, the way a model completion does.
const REPEATABLE = new Set(['pure', 'read-only', 'external'])

type Kind = 'repeatable' | 'deduplicated' | 'other'

const RESUME_BY_KIND: Record<Kind, Resume> = {
  repeatable: 'again',
  deduplicated: 'keyed',
  other: 'pause',
}

function kindOf({ effects, takesKey }: Callee): Kind {
  if (effects.includes('irreversible')) {
    return takesKey ? 'deduplicated' : 'other'
  }

  if (effects.length > 0 && effects.every((effect) => REPEATABLE.has(effect))) {
    return 'repeatable'
  }

  return 'other'
}

export function resumeOf(callee: Callee): Resume {
  return RESUME_BY_KIND[kindOf(callee)]
}

/**
 * The key an irreversible step is sent with, the same in every execution of the run. Every
 * irreversible step gets one, so a callee that starts honoring keys covers runs already in flight.
 */
export function idempotencyKey(workflowId: string, step: number, callee: Callee): string | null {
  return callee.effects.includes('irreversible') ? `${workflowId}:${step}` : null
}

/**
 * What each function declares about itself, read from the engine's function list, so the journal
 * can tell what a step's callee does without the preload sending it. A function that registers
 * again after a restart usually declares the same thing, so the list is read again only when a
 * function is missing from it or every REFRESH_MS.
 */
import type { IIIClient } from 'iii-sdk'
import type { Callee } from './resume.js'

const REFRESH_MS = 30_000
const MISS_REFRESH_MS = 1_000

type FunctionRow = { function_id: string; namespace?: string; metadata?: { effects?: unknown; idempotency_key?: unknown } | null }

function calleeOf(row: FunctionRow): Callee {
  const effects = Array.isArray(row.metadata?.effects) ? row.metadata.effects.filter((effect): effect is string => typeof effect === 'string') : []
  return { effects, takesKey: row.metadata?.idempotency_key === true }
}

export function callees(iii: IIIClient) {
  let known = new Map<string, Callee>()
  let readAt = 0

  async function read(): Promise<void> {
    const { functions } = await iii.call<unknown, { functions: FunctionRow[] }>({
      function_id: 'engine::functions::list',
      payload: { include_internal: true },
      timeoutMs: 10_000,
    })
    known = new Map(functions.filter((row) => (row.namespace ?? 'default') === 'default').map((row) => [row.function_id, calleeOf(row)]))
    readAt = Date.now()
  }

  return {
    /** The callee's declarations, or none for a function the engine doesn't list, which then pauses if it was lost. */
    async of(functionId: string): Promise<Callee> {
      const stale = Date.now() - readAt > REFRESH_MS
      const missing = !known.has(functionId) && Date.now() - readAt > MISS_REFRESH_MS
      if (stale || missing) {
        await read()
      }

      return known.get(functionId) ?? { effects: [], takesKey: false }
    },
  }
}

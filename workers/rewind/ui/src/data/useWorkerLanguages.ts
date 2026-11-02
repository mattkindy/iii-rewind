/**
 * The language each worker is written in, from the runtime the engine reports
 * for its connection. iii's Node SDK is its TypeScript SDK, so node shows as
 * ts. A worker the engine does not list, or a runtime without a short name,
 * gets no mark.
 */
import { useEffect, useState } from 'react'
import type { RewindClient } from '../client/rewindClient'

const LANGUAGE: Record<string, string> = { node: 'ts', python: 'py', rust: 'rs' }

export function useWorkerLanguages(client: RewindClient): Record<string, string> {
  const [languages, setLanguages] = useState<Record<string, string>>({})

  useEffect(() => {
    let current = true
    client.workers().then(
      (result) => {
        if (!current) {
          return
        }

        const found: Record<string, string> = {}
        for (const worker of result.workers ?? []) {
          const language = LANGUAGE[worker.runtime ?? '']
          if (language && !found[worker.name]) {
            found[worker.name] = language
          }
        }

        setLanguages(found)
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [client])

  return languages
}

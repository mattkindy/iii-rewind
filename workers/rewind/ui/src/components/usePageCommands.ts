/**
 * A view's keyboard commands, registered once and run against the view's
 * latest state. The console keeps a command until it is unregistered, so the
 * table of commands stays fixed, and each command looks up its handler and its
 * enabled flag by key in `state`, which the view passes fresh on every render.
 * Declaring the table `as const` makes `state` need exactly the keys the table
 * uses, so a handler that is missing or misspelled fails to build.
 */
import type { PageCommandsApi } from '@iii-dev/console-ui'
import { useEffect, useRef } from 'react'

export type CommandSpec = {
  id: string
  title: string
  shortcut?: string
  /** The key of the handler in `state.act`. */
  act: string
  /** The key of the flag in `state.can` that enables the command; always enabled without one. */
  can?: string
  keywords?: readonly string[]
  firesWhileTyping?: boolean
}

export type CommandState<T extends readonly CommandSpec[]> = {
  act: Record<T[number]['act'], () => void>
  can: Record<NonNullable<T[number]['can']>, boolean>
}

export function usePageCommands<const T extends readonly CommandSpec[]>(commands: PageCommandsApi | undefined, specs: T, state: CommandState<T>): void {
  const latest = useRef<CommandState<readonly CommandSpec[]>>(state)
  latest.current = state

  useEffect(() => {
    if (!commands) {
      return
    }

    return commands.register(
      specs.map(({ act, can, ...spec }) => ({
        ...spec,
        enabled: can ? () => latest.current.can[can] : undefined,
        run: () => latest.current.act[act](),
      })),
    )
  }, [commands, specs])
}

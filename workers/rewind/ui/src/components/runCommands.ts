/**
 * The run view's keyboard commands, as the palette lists them. `act` and
 * `can` are keys into the handlers and flags the run view passes on each
 * render, so the view can't register a command without its handler.
 */
import type { CommandSpec } from './usePageCommands'

export const RUN_COMMANDS = [
  { id: 'next-call', title: 'Next call', shortcut: 'Alt+ArrowDown', act: 'next' },
  { id: 'previous-call', title: 'Previous call', shortcut: 'Alt+ArrowUp', act: 'previous' },
  { id: 'likely-cause', title: 'Go to the likely cause', shortcut: 'Alt+G', act: 'cause' },
  { id: 'edit-answer', title: 'Edit this answer', shortcut: 'Alt+E', act: 'edit', can: 'edit' },
  { id: 'inject', title: 'Fork with error', shortcut: 'Alt+I', act: 'inject', can: 'inject' },
  { id: 'choose-live', title: 'Run the paused call live', shortcut: 'Alt+L', act: 'live', can: 'live' },
  { id: 'choose-typed', title: 'Type the paused call’s answer', shortcut: 'Alt+A', act: 'typed', can: 'paused' },
  { id: 'submit', title: 'Fork, or continue the fork', shortcut: 'Mod+Enter', act: 'submit', can: 'submit', firesWhileTyping: true },
  { id: 'cancel-edit', title: 'Cancel editing, or close the player', shortcut: 'Escape', act: 'cancel', can: 'cancel', firesWhileTyping: true },
  { id: 'stop-fork', title: 'Discard fork', act: 'stop', can: 'paused' },
  { id: 'compare', title: 'Compare with the original', shortcut: 'Alt+C', act: 'compare', can: 'compare' },
  { id: 'save-test', title: 'Save this fork as a test', shortcut: 'Alt+S', act: 'save', can: 'save' },
  { id: 'replay', title: 'Replay this run', shortcut: 'Alt+R', act: 'replay', can: 'replay', keywords: ['reproduce', 'current code'] },
  { id: 'workers', title: 'Show or hide workers', shortcut: 'Alt+W', act: 'workers', keywords: ['lanes', 'sequence'] },
  { id: 'next-run', title: 'Next run in this group', shortcut: 'Alt+N', act: 'nextRun', can: 'nextRun' },
  { id: 'previous-run', title: 'Previous run in this group', shortcut: 'Alt+P', act: 'previousRun', can: 'previousRun' },
  { id: 'toggle-stop', title: 'Toggle a stop on this call’s function', shortcut: 'Alt+B', act: 'toggleStop', can: 'toggleStop', keywords: ['breakpoint', 'pause'] },
  { id: 'show-in-traces', title: 'Show this call in Traces', shortcut: 'Alt+T', act: 'trace', can: 'trace', keywords: ['traces', 'span', 'reveal'] },
  { id: 'player', title: 'Play back this run, or close the player', shortcut: 'Alt+V', act: 'player', keywords: ['player', 'timeline', 'waterfall', 'animate'] },
  { id: 'play-pause', title: 'Play or pause the player', shortcut: 'Alt+K', act: 'playPause', can: 'playerOpen' },
  { id: 'faster', title: 'Play back faster', shortcut: 'Alt+=', act: 'faster', can: 'playerOpen' },
  { id: 'slower', title: 'Play back slower', shortcut: 'Alt+-', act: 'slower', can: 'playerOpen' },
] as const satisfies readonly CommandSpec[]

/** The recovery view's commands. Mod+Enter recovers the run before it has a recovery, and continues it after. */
export const RECOVERY_COMMANDS = [
  { id: 'recover', title: 'Recover run', shortcut: 'Mod+Enter', act: 'recover', can: 'recover' },
  { id: 'recovery-continue', title: 'Continue recovery', shortcut: 'Mod+Enter', act: 'answer', can: 'answer', firesWhileTyping: true },
  { id: 'recovery-live', title: 'Run the waiting call live', shortcut: 'Alt+L', act: 'live', can: 'live' },
  { id: 'recovery-typed', title: 'Type the waiting call’s answer', shortcut: 'Alt+A', act: 'typed', can: 'answer' },
  { id: 'recovery-inject', title: 'Inject an error at the waiting call', shortcut: 'Alt+I', act: 'inject', can: 'answer' },
] as const satisfies readonly CommandSpec[]

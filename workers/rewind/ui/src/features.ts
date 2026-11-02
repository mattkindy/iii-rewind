/**
 * Switches for page behaviour that leans on the console's internals. Each one
 * can be turned off in a running console without a new build, by setting the
 * localStorage key `rewind:feature:<name>` to `off` (or back `on`), so a
 * console change that breaks one can be worked around at once.
 *
 * `trace-mention-click`: on a console without `host.traces.focus`, Traces sync
 * renders a hidden `@trace` mention and clicks it to open the trace. With it
 * off there, the page offers no Traces sync at all.
 */
const DEFAULTS = { 'trace-mention-click': true }

export type Feature = keyof typeof DEFAULTS

const STORED: Record<string, boolean> = { on: true, off: false }

export function featureOn(name: Feature): boolean {
  try {
    return STORED[window.localStorage.getItem(`rewind:feature:${name}`) ?? ''] ?? DEFAULTS[name]
  } catch {
    return DEFAULTS[name]
  }
}

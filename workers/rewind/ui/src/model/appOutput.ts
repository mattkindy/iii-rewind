/**
 * What the sample app's agent returns: `{ status, reply }`, where `status` is
 * a word such as `booked` or `failed` and `reply` is what the agent told the
 * person. The page reads both to say how a run ended in the person's terms.
 * Any other app's output has neither field, and every reader here returns
 * undefined or false for it, so the page falls back to showing the output.
 */

function field(output: unknown, key: string): unknown {
  return output && typeof output === 'object' ? (output as Record<string, unknown>)[key] : undefined
}

/** The run's `status`, such as `booked`, when it returned one as text. */
export function outputStatus(output: unknown): string | undefined {
  const status = field(output, 'status')
  return typeof status === 'string' ? status : undefined
}

/** The agent finished and said it could not do what was asked. */
export function returnedFailed(output: unknown): boolean {
  return outputStatus(output) === 'failed'
}

/** What the agent told the person, when it returned a reply. */
export function outputReply(output: unknown): string | undefined {
  const reply = field(output, 'reply')
  return typeof reply === 'string' ? reply : undefined
}

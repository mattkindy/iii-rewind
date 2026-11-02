/**
 * Rewind's preload for Node workers, loaded with `node --import`. It captures
 * what a worker does around iii, so Rewind can show it among the iii calls and
 * replay it: fetch calls, requests to the worker's own HTTP server, and calls
 * of the functions listed in rewind.json or REWIND_TRACE_FUNCTIONS.
 *
 * REWIND_CAPTURE=record, the default, appends each capture to the capture
 * file for Rewind to read. Rewind starts its copies with REWIND_CAPTURE=replay,
 * where each fetch gets its response from Rewind. REWIND_CAPTURE=off turns the
 * preload off, and then it loads none of its modules and changes nothing.
 */
const MODE = process.env.REWIND_CAPTURE ?? 'record'

if (MODE !== 'off') {
  const [{ trackInvocations }, { installFetchHook }, { flushBeforeExit }, { installInbound }, { installSpans }] = await Promise.all([
    import('./capture.mjs'),
    import('./fetch.mjs'),
    import('./flush.mjs'),
    import('./inbound.mjs'),
    import('./spans.mjs'),
  ])
  trackInvocations()
  await installFetchHook(MODE)
  installSpans()
  installInbound(MODE)
  if (MODE === 'replay') {
    flushBeforeExit()
  }
}

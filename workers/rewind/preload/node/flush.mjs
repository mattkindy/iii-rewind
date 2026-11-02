/**
 * Rewind stops a copy with SIGTERM as soon as its run is over. Node exits on
 * SIGTERM at once, and the SDK sends spans in batches every 100 ms, so the
 * copy's spans for the run were usually lost. In a copy the preload sends what
 * is left first, for at most FLUSH_CAP_MS, and then exits.
 *
 * The copy gets SIGTERM twice, from Rewind's signal to its process group and
 * from the wrapper shell passing it on, so a repeat is ignored instead of
 * falling back to Node's default and exiting mid-flush.
 */
import { setTimeout as sleep } from 'node:timers/promises'

const OTEL_API = Symbol.for('opentelemetry.js.api.1')
const FLUSH_CAP_MS = 1_500
// The exporter hands spans to a WebSocket, which needs a moment to write them out.
const SEND_MS = 150

export function flushBeforeExit() {
  let stopping = false
  process.on('SIGTERM', () => {
    if (stopping) {
      return
    }

    stopping = true
    const provider = globalThis[OTEL_API]?.trace
    const tracing = provider?.getDelegate?.() ?? provider
    const flushed = Promise.resolve(tracing?.forceFlush?.()).catch(() => {})
    void Promise.race([flushed, sleep(FLUSH_CAP_MS)])
      .then(() => sleep(SEND_MS))
      .then(() => process.exit(0))
  })
}

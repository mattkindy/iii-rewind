/**
 * The way a copy started by Rewind asks Rewind what a call around iii should
 * return. Rewind registers rewind::outside in the copy's namespace, and the
 * answer comes from the same place a stub's does: the fork's own answers, the
 * recording at that position, a live call, or a pause.
 *
 * The preload opens its own connection, with the worker's iii-sdk, the first
 * time a copy needs one. OpenTelemetry stays off on it, so the worker's own
 * tracing setup is left alone.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { currentCall } from './capture.mjs'

const OUTSIDE_FUNCTION = 'rewind::outside'
// A live call can take as long as the request it makes.
const ASK_TIMEOUT_MS = 120_000

/** The file the worker's own `import 'iii-sdk'` loads, so both share one module and one invocation context. */
function sdkEntry() {
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'node_modules', 'iii-sdk', 'package.json')
    if (existsSync(manifest)) {
      const entry = JSON.parse(readFileSync(manifest, 'utf8')).exports['.'].import
      return pathToFileURL(realpathSync(path.join(path.dirname(manifest), entry))).href
    }

    if (path.dirname(dir) === dir) {
      throw new Error(`rewind preload: no iii-sdk under ${process.cwd()}`)
    }
  }
}

let connection

async function rewind() {
  connection ??= import(sdkEntry()).then(({ registerWorker }) =>
    registerWorker(process.env.III_URL ?? 'ws://127.0.0.1:49334', {
      workerName: 'rewind-preload',
      otel: { enabled: false },
    }),
  )
  return connection
}

/**
 * What Rewind says the call returns. A pause or an injected error rejects, with Rewind's code in the message.
 * The request says which call it ran in, so Rewind matches it under that call when the fork copies more than one worker.
 */
export async function askRewind(request) {
  const payload = { ...request, invocation: currentCall() ?? null }
  const worker = await rewind()
  try {
    return await worker.trigger({ function_id: OUTSIDE_FUNCTION, payload, timeoutMs: ASK_TIMEOUT_MS })
  } catch (error) {
    throw new Error(`${error.code ?? 'REWIND'}: ${error.message}`)
  }
}

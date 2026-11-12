/**
 * Shared pieces for the durable-execution probes: an engine of their own on 49738, the queue
 * worker, worker processes a probe can kill, and a timeline printer.
 *
 * Each probe starts its own engine in .run/<probe>/ and stops it at the end, so nothing it
 * leaves behind reaches the next probe. III_BIN picks the engine binary and QUEUE_BIN the queue
 * worker; both default to what the repo and iii's package cache have.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { connect as tcpConnect, createServer, type Server, type Socket } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { type IIIClient, registerWorker } from 'iii-sdk'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ENGINE_PORT = 49738
export const ENGINE_URL = `ws://127.0.0.1:${ENGINE_PORT}`
export const III_BIN = process.env.III_BIN ?? path.resolve(HERE, '../../.tools/iii-0.26.0/iii')

const started = Date.now()
// Every child process adds an exit listener, so it is stopped when the probe ends.
process.setMaxListeners(100)

export function elapsed(): number {
  return Date.now() - started
}

/** Prints one line of the timeline, with the time since the probe started. */
export function log(...parts: unknown[]): void {
  const text = parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
  console.log(`t+${String(elapsed()).padStart(6)}ms ${text}`)
}

export { sleep }

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tcpConnect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

/** The newest queue worker in iii's compose package cache, unless QUEUE_BIN names one. */
function queueBinary(): string {
  if (process.env.QUEUE_BIN) {
    return process.env.QUEUE_BIN
  }

  const cache = path.join(homedir(), '.iii', 'compose', 'packages')
  const versions = readdirSync(cache)
    .filter((entry) => entry.startsWith('queue-') && !entry.endsWith('.lock') && existsSync(path.join(cache, entry, 'queue')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const newest = versions.at(-1)
  if (!newest) {
    throw new Error(`no queue worker under ${cache}; set QUEUE_BIN`)
  }

  return path.join(cache, newest, 'queue')
}

export type Child = { stop: (signal?: NodeJS.Signals) => Promise<void>; pid: number | undefined; lines: string[] }

function spawnLogged(command: string, args: string[], cwd: string, logFile: string, env: Record<string, string> = {}): ChildProcess {
  const out = createWriteStream(path.join(cwd, logFile))
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.pipe(out)
  child.stderr?.pipe(out)
  process.on('exit', () => child.kill('SIGKILL'))
  return child
}

function stopper(child: ChildProcess) {
  return async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }

    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill(signal)
    await exited
  }
}

export type Probe = {
  dir: string
  engine: Child
  startQueue: (config: string) => Promise<Child & { binary: string }>
}

/** A fresh engine in .run/<name>, with the worker manager on ENGINE_PORT and nothing else. */
export async function startProbe(name: string): Promise<Probe> {
  if (await portOpen(ENGINE_PORT)) {
    throw new Error(`port ${ENGINE_PORT} is already taken; stop the earlier probe engine first`)
  }

  const dir = path.join(HERE, '.run', name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'config.yaml'),
    ['workers:', '  - name: iii-worker-manager', '    config:', '      host: 127.0.0.1', `      port: ${ENGINE_PORT}`, ''].join('\n'),
  )
  const engine = spawnLogged(III_BIN, ['--no-update-check', '-c', 'config.yaml'], dir, 'engine.log')
  for (let attempt = 0; attempt < 100 && !(await portOpen(ENGINE_PORT)); attempt++) {
    await sleep(100)
  }

  log(`engine ${III_BIN} up on ${ENGINE_PORT}, pid ${engine.pid}`)
  return {
    dir,
    engine: { stop: stopper(engine), pid: engine.pid, lines: [] },
    startQueue: async (config) => {
      const binary = queueBinary()
      writeFileSync(path.join(dir, 'queue.yaml'), config)
      const queue = spawnLogged(binary, ['--url', ENGINE_URL, '--config', 'queue.yaml'], dir, 'queue.log')
      log(`queue worker ${binary} started, pid ${queue.pid}`)
      return { binary, stop: stopper(queue), pid: queue.pid, lines: [] }
    },
  }
}

export type Role = Child & {
  name: string
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<string>
  kill: (signal?: NodeJS.Signals) => void
}

export const PRELOAD = path.resolve(HERE, '../../workers/rewind/preload/node/index.mjs')
export const JOURNAL_WORKER = path.resolve(HERE, '../../workers/journal/src/worker.ts')

/**
 * Starts `roles/<file>`, or a script at an absolute path, as its own process, and prints each
 * line it writes, prefixed with its name. `preload` loads Rewind's Node preload first.
 */
export function startRole(name: string, file: string, env: Record<string, string> = {}, preload = false): Role {
  const script = path.isAbsolute(file) ? file : path.join(HERE, 'roles', file)
  const args = ['--import', 'tsx', ...(preload ? ['--import', PRELOAD] : []), script]
  const child = spawn(process.execPath, args, {
    cwd: HERE,
    env: { ...process.env, III_URL: ENGINE_URL, ROLE_NAME: name, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  process.on('exit', () => child.kill('SIGKILL'))
  const lines: string[] = []
  const waiters: { pattern: RegExp; resolve: (line: string) => void }[] = []
  const onLine = (line: string) => {
    if (!line.trim()) {
      return
    }

    lines.push(line)
    if (/^(ROLE|HANDLER|STEP|journal:|rewind preload)/.test(line)) {
      log(`[${name}] ${line}`)
    }

    for (const waiter of [...waiters]) {
      if (waiter.pattern.test(line)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(line)
      }
    }
  }
  let pending = ''
  const read = (chunk: Buffer) => {
    pending += chunk.toString()
    const parts = pending.split('\n')
    pending = parts.pop() ?? ''
    parts.forEach(onLine)
  }
  child.stdout?.on('data', read)
  child.stderr?.on('data', read)
  return {
    name,
    pid: child.pid,
    lines,
    stop: stopper(child),
    waitFor: (pattern, timeoutMs = 20_000) => {
      const seen = lines.find((line) => pattern.test(line))
      if (seen) {
        return Promise.resolve(seen)
      }

      return new Promise((resolve, reject) => {
        const waiter = { pattern, resolve }
        waiters.push(waiter)
        setTimeout(() => reject(new Error(`${name} never printed ${pattern}`)), timeoutMs)
      })
    },
    kill: (signal = 'SIGKILL') => {
      log(`${signal} ${name} (pid ${child.pid})`)
      child.kill(signal)
    },
  }
}

export function connect(name: string, url = ENGINE_URL): IIIClient {
  return registerWorker(url, { workerName: name, otel: { enabled: false } })
}

/** Waits until the engine lists every one of `functionIds`, since registration returns early. */
export async function waitForFunctions(iii: IIIClient, functionIds: string[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let missing = functionIds
  while (Date.now() < deadline) {
    const listed = await iii.call<unknown, { functions: { function_id: string }[] }>({ function_id: 'engine::functions::list', payload: { include_internal: true } })
    missing = functionIds.filter((id) => !listed.functions.some((row) => row.function_id === id))
    if (missing.length === 0) {
      return
    }

    await sleep(100)
  }

  throw new Error(`never listed: ${missing.join(', ')}`)
}

/** An error without its stack, for the timeline. */
export function brief(error: unknown): unknown {
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown }
    return { code, message }
  }

  return error
}

/**
 * A TCP proxy in front of an engine. `cut(ms)` drops every connection through it and refuses new
 * ones for that long, which looks to the engine like the worker went away and came back, while
 * the worker's process keeps running.
 */
export async function startProxy(port: number, upstreamPort: number): Promise<{ url: string; cut: (ms: number) => Promise<void>; close: () => void }> {
  const sockets = new Set<Socket>()
  let refusing = false
  const server: Server = createServer((client) => {
    if (refusing) {
      client.destroy()
      return
    }

    const upstream = tcpConnect(upstreamPort, '127.0.0.1')
    sockets.add(client)
    sockets.add(upstream)
    client.pipe(upstream)
    upstream.pipe(client)
    const drop = () => {
      client.destroy()
      upstream.destroy()
      sockets.delete(client)
      sockets.delete(upstream)
    }
    client.on('error', drop)
    upstream.on('error', drop)
    client.on('close', drop)
    upstream.on('close', drop)
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `ws://127.0.0.1:${port}`,
    cut: async (ms) => {
      refusing = true
      for (const socket of sockets) {
        socket.destroy()
      }

      log(`proxy ${port}: cut every connection, refusing new ones for ${ms} ms`)
      await sleep(ms)
      refusing = false
      log(`proxy ${port}: accepting again`)
    },
    close: () => {
      for (const socket of sockets) {
        socket.destroy()
      }

      server.close()
    },
  }
}

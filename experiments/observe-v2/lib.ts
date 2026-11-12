/**
 * Shared pieces for the 0.26 observer probes: the probes' own engine on 49834, worker
 * processes that a probe can kill, a TCP proxy that can cut a worker off from the engine,
 * and a timeline printer.
 *
 * Every probe starts its own engine from config.yaml in .run/ and stops it at the end.
 * III_BIN picks the binary; it defaults to the 0.26.0 binary in the repo's .tools folder.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { copyFileSync, createWriteStream, mkdirSync } from 'node:fs'
import { connect as tcpConnect, createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { type IIIClient, registerWorker } from 'iii-sdk'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const RUN_DIR = path.join(HERE, '.run')
export const ENGINE_PORT = 49834
export const ENGINE_URL = `ws://127.0.0.1:${ENGINE_PORT}`
export const III_BIN = process.env.III_BIN ?? path.resolve(HERE, '../../.tools/iii-0.26.0/iii')

const started = Date.now()

/** Prints one line of the timeline, with the time since the probe started. */
export function log(...parts: unknown[]): void {
  const text = parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
  console.log(`t+${String(Date.now() - started).padStart(5)}ms ${text}`)
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

export type Engine = { stop: () => Promise<void> }

export async function startEngine(logName: string, configFile = 'config.yaml'): Promise<Engine> {
  if (await portOpen(ENGINE_PORT)) {
    throw new Error(`port ${ENGINE_PORT} is already taken; stop the earlier probe engine first`)
  }

  mkdirSync(RUN_DIR, { recursive: true })
  copyFileSync(path.join(HERE, configFile), path.join(RUN_DIR, 'config.yaml'))
  const out = createWriteStream(path.join(RUN_DIR, `${logName}-engine.log`))
  const child = spawn(III_BIN, ['--no-update-check', '-c', 'config.yaml'], { cwd: RUN_DIR, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  // A probe that throws still leaves the port free for the next one.
  process.on('exit', () => child.kill('SIGTERM'))
  for (let attempt = 0; attempt < 100 && !(await portOpen(ENGINE_PORT)); attempt++) {
    await sleep(100)
  }

  // The log is committed, so the binary's path is relative to the repo.
  log(`engine ${path.relative(path.resolve(HERE, '../..'), III_BIN)} up on ${ENGINE_PORT}, pid ${child.pid}`)
  return {
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

export type Role = {
  name: string
  child: ChildProcess
  lines: string[]
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<string>
  kill: (signal?: NodeJS.Signals) => void
}

/** Starts `roles/<file>` as its own process, and prints each line it writes, prefixed with its name. */
export function startRole(name: string, file: string, env: Record<string, string> = {}): Role {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(HERE, 'roles', file)], {
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
    if (/^(ROLE|EVENT|HANDLER|HOOK|STATE)/.test(line)) {
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
    child,
    lines,
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
export async function waitForFunctions(iii: IIIClient, functionIds: string[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const listed = await iii.call<unknown, { functions: { function_id: string }[] }>({ function_id: 'engine::functions::list', payload: {} })
    if (functionIds.every((id) => listed.functions.some((row) => row.function_id === id))) {
      return
    }

    await sleep(100)
  }

  throw new Error(`never listed: ${functionIds.join(', ')}`)
}

type ObserverRow = { id?: string; observer_id?: string; function_id: string; target?: unknown; state: string; fires: number; dropped?: unknown; reason?: unknown }

export async function observerRows(iii: IIIClient, functionId: string): Promise<Record<string, unknown>[]> {
  const listed = await iii.call<unknown, { observers: ObserverRow[] }>({ function_id: 'engine::observers::list', payload: {} })
  return listed.observers
    .filter((row) => row.function_id === functionId)
    .map(({ id, observer_id, target, state, fires, dropped, reason }) => ({ id: (id ?? observer_id ?? '').slice(0, 8), target, state, fires, dropped, reason }))
}

/** Closes the probe's connections and its engine, then exits. */
export async function finish(engine: Engine, clients: IIIClient[]): Promise<never> {
  const closed = await Promise.allSettled(clients.map((client) => client.shutdown()))
  for (const result of closed) {
    if (result.status === 'rejected') {
      log('a connection did not close cleanly', brief(result.reason))
    }
  }

  await engine.stop()
  process.exit(0)
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
 * A TCP proxy in front of the engine. `cut(ms)` drops every connection through it and refuses
 * new ones for that long, which looks to the engine like the worker went away and came back.
 */
export async function startProxy(port: number): Promise<{ url: string; cut: (ms: number) => Promise<void>; close: () => void }> {
  const sockets = new Set<Socket>()
  let refusing = false
  const server: Server = createServer((client) => {
    if (refusing) {
      client.destroy()
      return
    }

    const upstream = tcpConnect(ENGINE_PORT, '127.0.0.1')
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

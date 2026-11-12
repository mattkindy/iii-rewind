/**
 * The burst's stack: compose up with one arm's environment, the calls the burst observes, and
 * compose down. Each arm starts from an empty stack/data, so its outbox, journal and sends are
 * its own.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { connect as tcpConnect } from 'node:net'
import path from 'node:path'
import type { IIIClient, ObserveSource } from 'iii-sdk'
import { connect, HERE, III_BIN, log, sleep, waitForFunctions } from './lib.js'

export const STACK_DIR = path.join(HERE, 'stack')
export const COMPOSE_FILE = path.join(STACK_DIR, 'worker-compose.yaml')
export const DATA_DIR = path.join(STACK_DIR, 'data')
export const STACK_URL = 'ws://127.0.0.1:49734'
const STACK_PORT = 49734
const READY = /Containers Running \(7\/7\)/
const FAILED = /✗|Error\[|failed to start/

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

export function iii(args: string[]): string {
  return execFileSync(III_BIN, ['--no-update-check', ...args], { encoding: 'utf8' })
}

export type Stack = { client: IIIClient; stop: () => Promise<void> }

export async function startStack(runDir: string, env: Record<string, string>): Promise<Stack> {
  if (await portOpen(STACK_PORT)) {
    throw new Error(`port ${STACK_PORT} is taken; stop the project's stack or the last burst first`)
  }

  rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(DATA_DIR, { recursive: true })
  const out = createWriteStream(path.join(runDir, 'compose.log'))
  const child: ChildProcess = spawn(III_BIN, ['--no-update-check', 'compose', '--up', '-f', COMPOSE_FILE], {
    cwd: STACK_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let text = ''
  const ready = new Promise<void>((resolve, reject) => {
    const read = (chunk: Buffer) => {
      out.write(chunk)
      text += chunk.toString().replace(/\x1b\[[0-9;]*m/g, '')
      if (READY.test(text)) {
        resolve()
      } else if (FAILED.test(text)) {
        reject(new Error(`compose did not start; see ${path.join(runDir, 'compose.log')}`))
      }
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.once('exit', () => reject(new Error(`compose exited; see ${path.join(runDir, 'compose.log')}`)))
  })
  await ready
  const client = connect('durable-burst', STACK_URL)
  await waitForFunctions(client, ['agent::run', 'traffic::burst', 'journal::wait', 'model::complete', 'email::send', 'engine::queue::enqueue'], 60_000)
  log(`stack up with ${JSON.stringify(env)}`)
  return {
    client,
    stop: async () => {
      await client.shutdown()
      iii(['kill', '--compose', COMPOSE_FILE])
      child.kill('SIGTERM')
      for (let waited = 0; waited < 20_000 && (await portOpen(STACK_PORT)); waited += 250) {
        await sleep(250)
      }
    },
  }
}

export type Observed = { at: number; function_id: string; invocation_id: string; status: string; input: any; output?: any; error?: any; caller?: { invocation_id?: string } }

/** Everything the burst needs to count, observed as it completes: model calls, sends and runs. */
export async function observeCalls(client: IIIClient): Promise<Observed[]> {
  const seen: Observed[] = []
  client.registerFunction('durable-burst::observed', async (envelope: Observed) => {
    seen.push({ ...envelope, at: Date.now() })
    return null
  }, { description: 'Keeps what the burst observes', metadata: { internal: true } })
  await waitForFunctions(client, ['durable-burst::observed'])
  const watched: ObserveSource[] = [
    { function_id: 'model::complete', capture: ['input', 'caller'] },
    { function_id: 'email::send', capture: ['input', 'output', 'error', 'caller', 'metadata'] },
    { function_id: 'agent::run', capture: ['input', 'output', 'error', 'caller'] },
  ]
  for (const source of watched) {
    await client.observe(source, 'durable-burst::observed').ready()
  }

  return seen
}

/** Waits until `functionId` is registered again, after a kill and compose's restart. */
export async function waitForRestart(client: IIIClient, functionId: string): Promise<void> {
  await waitForFunctions(client, [functionId], 60_000)
}

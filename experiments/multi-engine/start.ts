/**
 * Starts the two-engine experiment: engine B (tools, probe, a second Rewind) at
 * 50134 first, then engine A (agent, Rewind, bridge, ADE) at 50034, and waits
 * until A lists the bridged tools. Each compose daemon runs in the background
 * and writes its output to compose.log in its own folder.
 *
 * Run from experiments/multi-engine, after `npm install`:
 *   III_BIN=/path/to/iii-0.25.0 npx tsx start.ts            both engines
 *   III_BIN=/path/to/iii-0.25.0 npx tsx start.ts --single   the one-engine baseline on 50034
 *   III_BIN=/path/to/iii-0.25.0 npx tsx start.ts --stop     stops whatever this experiment started
 */
import { execFileSync, spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { createConnection } from 'node:net'
import path from 'node:path'
import { ADE_PORT, ENGINE_A, ENGINE_B, III_BIN, type Setup, composeDir, composeFile, connect, waitForFunctions } from './lib/engines.js'

const FIRST_START_MS = 15 * 60_000
const PORTS = [50034, 50134, 50036, ADE_PORT]

const READY: Record<Setup, { url: string; functions: string[] }> = {
  'engine-b': { url: ENGINE_B, functions: ['calendar::find-slot', 'email::send', 'probe::echo', 'rewind::status'] },
  'engine-a': {
    url: ENGINE_A,
    functions: ['agent::run', 'traffic::burst', 'clock::now', 'model::complete', 'calendar::find-slot', 'email::send', 'probe::echo', 'rewind::status'],
  },
  single: {
    url: ENGINE_A,
    functions: ['agent::run', 'traffic::burst', 'clock::now', 'model::complete', 'calendar::find-slot', 'email::send', 'probe::echo', 'rewind::status'],
  },
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

function startCompose(setup: Setup): void {
  const log = openSync(path.join(composeDir(setup), 'compose.log'), 'a')
  const child = spawn(III_BIN, ['compose', '--up', '-f', composeFile(setup)], {
    cwd: composeDir(setup),
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  console.log(`started compose for ${setup} (pid ${child.pid}), log ${path.join(setup, 'compose.log')}`)
}

async function waitUntilReady(setup: Setup): Promise<void> {
  const { url, functions } = READY[setup]
  const engine = connect(url, 'multi-engine-start')
  try {
    const tookMs = await waitForFunctions(engine, functions, FIRST_START_MS)
    console.log(`${setup} ready on ${url} after ${(tookMs / 1000).toFixed(1)} s`)
  } finally {
    await engine.shutdown()
  }
}

function stop(setups: Setup[]): void {
  for (const setup of setups) {
    try {
      execFileSync(III_BIN, ['kill', '--compose', composeFile(setup)], { stdio: 'inherit' })
    } catch {
      console.log(`nothing to stop for ${setup}`)
    }
  }
}

async function start(setups: Setup[]): Promise<number> {
  const busy = (await Promise.all(PORTS.map(async (port) => ((await portInUse(port)) ? port : undefined)))).filter((p) => p !== undefined)
  if (busy.length > 0) {
    console.error(`ports already in use: ${busy.join(', ')}. Run with --stop first.`)
    return 1
  }

  for (const setup of setups) {
    startCompose(setup)
    await waitUntilReady(setup)
  }

  return 0
}

const MODES: Record<string, () => Promise<number>> = {
  '--single': () => start(['single']),
  '--stop': async () => {
    stop(['engine-a', 'engine-b', 'single'])
    return 0
  },
  split: () => start(['engine-b', 'engine-a']),
}

const mode = process.argv[2] ?? 'split'
const run = MODES[mode]
if (!run) {
  console.error('usage: npx tsx start.ts [--single | --stop]')
  process.exit(2)
}

process.exit(await run())

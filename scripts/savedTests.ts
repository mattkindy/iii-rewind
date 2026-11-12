/**
 * Replays every saved test in tests/rewind against the code on disk and exits with 1 when any of
 * them fails. Rewind runs each test in a copy of the agent that gets only the answers in the
 * test's file, so the stack has to be up (`iii compose --up`).
 *
 * Run from the repo root, after `npm --prefix scripts install`:
 *   npm run saved-tests
 *   scripts/node_modules/.bin/tsx scripts/savedTests.ts booked-omar
 *
 * Test names on the command line run only those tests. III_URL is the engine (default
 * ws://127.0.0.1:49334), and III_COMPOSE_DIR is the project folder with tests/rewind (default the
 * repo root).
 */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerWorker } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49334'
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_DIR = process.env.III_COMPOSE_DIR ?? REPO_DIR
const TESTS_DIR = path.join(PROJECT_DIR, 'tests', 'rewind')
// A test whose copy starts cold takes a few seconds, and a held answer waits as long as its recorded call took.
const TEST_TIMEOUT_MS = 180_000

type ErrorAnswer = { code?: string; message: string }
type Need = { seq: number; path?: number[]; function_id: string }
type Outcome = { state: 'done'; output: unknown } | { state: 'crashed'; error: ErrorAnswer } | { state: 'paused'; need: Need }
type Expect = { status: string } | { throws: string } | { output: unknown }
type Difference = { field: string; saved?: unknown; sent?: unknown }
type Diverged = {
  seq: number
  path?: number[]
  function_id: string
  input: unknown
  saved?: { function_id: string; input?: unknown }
  differences: Difference[]
}
type TestRun = { pass: boolean; expected: Expect; outcome: Outcome; diverged?: Diverged }
type Status = { target_code: { version: string } | null }

type Worker = ReturnType<typeof registerWorker>

function place(call: { seq: number; path?: number[] }): string {
  return call.path && call.path.length > 0 ? call.path.join('.') : String(call.seq)
}

function show(value: unknown): string {
  return value === undefined ? '(nothing)' : JSON.stringify(value)
}

function describeExpect(expect: Expect): string {
  if ('status' in expect) {
    return `done with status ${expect.status}`
  }

  if ('throws' in expect) {
    return `a crash with "${expect.throws}"`
  }

  return `done with output ${show(expect.output)}`
}

const DESCRIBE_OUTCOME: { [S in Outcome['state']]: (outcome: Extract<Outcome, { state: S }>) => string } = {
  done: ({ output }) => {
    const status = (output as { status?: unknown } | null)?.status
    return status === undefined ? `done with output ${show(output)}` : `done with status ${status}`
  },
  crashed: ({ error }) => `a crash with "${error.message}"`,
  paused: ({ need }) => `a pause at seq ${place(need)} (${need.function_id})`,
}

function describeOutcome(outcome: Outcome): string {
  return (DESCRIBE_OUTCOME[outcome.state] as (outcome: Outcome) => string)(outcome)
}

/** What changed at the call where the run left the test's file, one line each. */
function divergedLines(diverged: Diverged): string[] {
  const at = `seq ${place(diverged)} (${diverged.function_id})`
  if (!diverged.saved) {
    return [`diverged at ${at}: the test has no call there, so the code makes a call it didn't make before`]
  }

  if (diverged.saved.function_id !== diverged.function_id) {
    return [`diverged at ${at}: the test has ${diverged.saved.function_id} there`]
  }

  const fields = diverged.differences.flatMap((difference) => [
    `  ${difference.field || '(the whole input)'}`,
    `    saved ${show(difference.saved)}`,
    `    sent  ${show(difference.sent)}`,
  ])
  return [`diverged at ${at}: the call sends another input than the test saved`, ...fields]
}

function testFiles(names: string[]): string[] {
  if (names.length > 0) {
    return names.map((name) => path.basename(name.endsWith('.json') ? name : `${name}.json`))
  }

  if (!existsSync(TESTS_DIR)) {
    return []
  }

  return readdirSync(TESTS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
}

async function testRun(worker: Worker, file: string): Promise<TestRun | { refused: string }> {
  try {
    return await worker.call<unknown, TestRun>({ function_id: 'rewind::test', payload: { path: file }, timeoutMs: TEST_TIMEOUT_MS })
  } catch (error) {
    const { code, message = String(error) } = error as { code?: string; message?: string }
    return { refused: !code || message.startsWith(code) ? message : `${code}: ${message}` }
  }
}

/** Runs one test and prints how it went. True when it passed. */
async function runOne(worker: Worker, file: string): Promise<boolean> {
  const name = file.replace(/\.json$/, '')
  const result = await testRun(worker, file)
  if ('refused' in result) {
    console.log(`  FAIL  ${name}`)
    console.log(`        rewind::test refused it: ${result.refused}`)
    return false
  }

  if (result.pass) {
    console.log(`  pass  ${name}: ${describeOutcome(result.outcome)}`)
    return true
  }

  console.log(`  FAIL  ${name}`)
  for (const line of result.diverged ? divergedLines(result.diverged) : []) {
    console.log(`        ${line}`)
  }

  console.log(`        expected ${describeExpect(result.expected)}, got ${describeOutcome(result.outcome)}`)
  return false
}

async function status(worker: Worker): Promise<Status | undefined> {
  try {
    return await worker.call<unknown, Status>({ function_id: 'rewind::status', payload: {}, timeoutMs: 10_000 })
  } catch {
    return undefined
  }
}

async function main(): Promise<number> {
  const files = testFiles(process.argv.slice(2))
  const shownDir = path.relative(process.cwd(), TESTS_DIR) || '.'
  if (files.length === 0) {
    console.log(`No saved tests in ${shownDir}. Save one from a finished fork with Save as test.`)
    return 0
  }

  const worker = registerWorker(ENGINE_URL, { workerName: 'saved-tests', otel: { enabled: false } })
  try {
    const rewind = await status(worker)
    if (!rewind) {
      console.error(`Rewind isn't answering on ${ENGINE_URL}. Start the stack with \`iii compose --up\`, or set III_URL.`)
      return 1
    }

    const code = rewind.target_code ? `, agent code ${rewind.target_code.version}` : ''
    console.log(`Replaying ${files.length} saved test${files.length === 1 ? '' : 's'} from ${shownDir} against ${ENGINE_URL}${code}`)
    let failed = 0
    for (const file of files) {
      failed += (await runOne(worker, file)) ? 0 : 1
    }

    console.log(`${files.length - failed} passed, ${failed} failed`)
    return failed > 0 ? 1 : 0
  } finally {
    await worker.shutdown()
  }
}

process.exit(await main())

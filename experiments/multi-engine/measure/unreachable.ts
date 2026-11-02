/**
 * Question 6, third case: what a caller on engine A gets when engine B itself
 * stops answering. It freezes B's engine with SIGSTOP in the middle of a
 * find-slot call, so the bridge's connection stays open and nothing replies,
 * then resumes it. Then it kills B's engine with SIGKILL in the middle of a
 * find-slot and an email::send, checks the outbox, and watches for 20 s
 * whether calls through A work again. It leaves engine B down, so stop both
 * engines with `npx tsx start.ts --stop` afterwards.
 *
 * Run from experiments/multi-engine with both engines up:
 *   npx tsx measure/unreachable.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { ENGINE_A, OUTBOX_A, RESULTS_DIR, connect, enginePid, lines, sleep } from '../lib/engines.js'

const CALL_TIMEOUT_MS = 45_000

const out: string[] = []
function say(line = ''): void {
  console.log(line)
  out.push(line)
}

const a = connect(ENGINE_A, 'unreachable-probe')

type Result = { value?: unknown; error?: { code?: string; message?: string }; ms: number }

/** One call from engine A, timed from `from`, which is when the engine was stopped or killed. */
async function settle(pending: Promise<unknown>, from: () => number): Promise<Result> {
  const settled = await pending.then((value) => ({ value })).catch((error) => {
    const { code, message } = error as { code?: string; message?: string }
    return { error: { code, message } }
  })
  return { ...settled, ms: performance.now() - from() }
}

function slot(tag: string): Promise<unknown> {
  return a.call('calendar::find-slot', { attendee: `${tag}@example.com`, day: '2026-11-10', duration: 30 }, CALL_TIMEOUT_MS)
}

function show(label: string, result: Result): void {
  const what = result.error ? JSON.stringify({ error: result.error }) : 'a result'
  say(`  ${label}: ${what}, ${(result.ms / 1000).toFixed(2)} s after B's engine stopped`)
}

async function frozen(pid: number): Promise<void> {
  say(`1. SIGSTOP engine B (pid ${pid}) 200 ms into a find-slot call`)
  let stoppedAt = 0
  const inFlight = slot('frozen-in-flight')
  await sleep(200)
  process.kill(pid, 'SIGSTOP')
  stoppedAt = performance.now()
  const sentWhileFrozen = slot('frozen-sent-after')
  show('the call in flight', await settle(inFlight, () => stoppedAt))
  show('a call sent while frozen', await settle(sentWhileFrozen, () => stoppedAt))
  process.kill(pid, 'SIGCONT')
  const resumedAt = performance.now()
  const after = await settle(slot('frozen-after-resume'), () => resumedAt)
  say(`  SIGCONT, then a new call got ${after.error ? JSON.stringify({ error: after.error }) : 'a result'} in ${(after.ms / 1000).toFixed(2)} s`)
}

async function killed(pid: number): Promise<void> {
  say(`2. SIGKILL engine B (pid ${pid}) 200 ms into a find-slot and an email::send`)
  const subject = `multi-engine engine B killed ${Date.now()}`
  let killedAt = 0
  const inFlight = slot('killed-in-flight')
  const send = a.call('email::send', { to: 'probe@example.com', subject, start: '2026-11-10T14:00:00-06:00' }, CALL_TIMEOUT_MS)
  await sleep(200)
  process.kill(pid, 'SIGKILL')
  killedAt = performance.now()
  show('find-slot in flight', await settle(inFlight, () => killedAt))
  show('email::send in flight', await settle(send, () => killedAt))
  show('a find-slot sent after the kill', await settle(slot('killed-sent-after'), () => killedAt))
  await sleep(4_000)
  say(`  outbox lines with this send's subject 4 s later: ${lines(OUTBOX_A).filter((line) => line.includes(subject)).length}`)
  for (let second = 1; second <= 20; second++) {
    const tried = await settle(
      a.call('calendar::find-slot', { attendee: `killed-retry-${second}@example.com`, day: '2026-11-10', duration: 30 }, 2_000),
      () => killedAt,
    )
    if (!tried.error) {
      say(`  calls through A worked again ${(tried.ms / 1000).toFixed(1)} s after the kill`)
      return
    }

    if (second === 1 || second === 20) {
      show(`retry ${second}`, tried)
    }

    await sleep(1_000)
  }

  say('  calls through A did not work again within 20 s')
}

say(`Engine B unreachable, ${new Date().toISOString()}`)
try {
  const pid = enginePid('engine-b')
  if (!pid) {
    throw new Error('engine B is not running')
  }

  await frozen(pid)
  await sleep(2_000)
  await killed(pid)
} finally {
  await a.shutdown()
}

mkdirSync(RESULTS_DIR, { recursive: true })
writeFileSync(path.join(RESULTS_DIR, 'unreachable-split.txt'), `${out.join('\n')}\n`)
process.exit(0)

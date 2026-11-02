/**
 * A fake email provider. Each send is appended to data/outbox.jsonl, so a
 * duplicate invite is easy to spot there. About one send in ten takes 2.5 s,
 * which is longer than the agent waits before it sends again (bug 3).
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const SLOW_SEND_RATE = 0.1
const SLOW_SEND_MS = 2500

export type Send = { to: string; subject: string; start: string; caller_invocation_id?: string | null }

// Compose sets III_COMPOSE_DIR. Started by hand, the worker finds the same folder
// by walking up to the compose file, the way the tools worker always has.
function projectDir(): string {
  if (process.env.III_COMPOSE_DIR) {
    return process.env.III_COMPOSE_DIR
  }

  for (let dir = process.cwd(); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'worker-compose.yaml'))) {
      return dir
    }
  }

  return process.cwd()
}

export const OUTBOX = path.join(projectDir(), 'data', 'outbox.jsonl')

function sendTime(): number {
  if (Math.random() < SLOW_SEND_RATE) {
    return SLOW_SEND_MS
  }

  return 150 + Math.floor(Math.random() * 301)
}

export async function sendEmail(send: Send) {
  const tookMs = sendTime()
  await sleep(tookMs)
  const id = `msg_${randomBytes(6).toString('hex')}`
  const entry = {
    id,
    to: send.to,
    subject: send.subject,
    start: send.start,
    sent_at: new Date().toISOString(),
    took_ms: tookMs,
    caller_invocation_id: send.caller_invocation_id ?? null,
  }
  mkdirSync(path.dirname(OUTBOX), { recursive: true })
  appendFileSync(OUTBOX, `${JSON.stringify(entry)}\n`)
  return { status: 'accepted', id }
}

/**
 * Prints the durable experiment's tables from results/<arm>.json, as Markdown, and writes them to
 * results/table.md. Run from this folder after the arms: npx tsx table.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { HERE } from './lib.js'

type Summary = Record<string, any>
type Result = { arm: string; what: string; faults: { at_ms: number; what: string }[]; burst_ms: number; summary: Summary }

const OUTCOMES = ['rival', 'rival-retry', 'recovery', 'queue', 'journal-kill', 'zombie']
const OVERHEAD = ['plain', 'journal', 'queue-calm']

function load(arm: string): Result | undefined {
  const file = path.join(HERE, 'results', `${arm}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Result) : undefined
}

function row(cells: unknown[]): string {
  return `| ${cells.map((cell) => String(cell ?? '')).join(' | ')} |`
}

function pair(value: { p50: number | null; p99: number | null }): string {
  return value.p50 === null ? 'none' : `${value.p50} / ${value.p99}`
}

const lines: string[] = []
lines.push(
  row(['Arm', 'Runs', 'Interrupted', 'Interrupted that finished', 'Never finished', 'Booked', 'Booked, one invite', 'Booked, two invites from the agent’s retry', 'Booked, two invites across executions', 'Invites for runs that did not book', 'Model calls made / uninterrupted', 'Repeated model calls', 'Executions', 'Fenced writes', 'Repeats email::send dropped']),
)
lines.push(row(Array(15).fill('---')))
for (const arm of OUTCOMES) {
  const result = load(arm)
  if (!result) {
    continue
  }

  const s = result.summary
  lines.push(
    row([
      arm,
      s.runs,
      s.interrupted,
      s.interrupted_finished,
      s.never_finished,
      s.booked,
      s.booked_with_one_email,
      s.booked_sent_twice_by_the_agents_retry,
      s.booked_sent_twice_across_executions,
      s.emails_for_runs_not_booked,
      `${s.model_calls} / ${s.model_reference}${s.runs_without_a_reference ? ` (${s.runs_without_a_reference} runs with none)` : ''}`,
      s.model_repeats,
      s.executions || 'none',
      s.fenced_writes,
      s.repeat_sends_dropped,
    ]),
  )
}

lines.push('')
lines.push(row(['Arm', 'Journal per step, ms p50 / p99', 'Journal per run (begin and finish), ms p50 / p99', 'Run as the caller saw it, ms p50 / p99', 'Steps']))
lines.push(row(Array(5).fill('---')))
for (const arm of [...OVERHEAD, ...OUTCOMES]) {
  const result = load(arm)
  if (!result) {
    continue
  }

  const s = result.summary
  lines.push(row([arm, pair(s.journal_step_ms), pair(s.journal_run_ms), pair(s.run_elapsed_ms), s.journal_step_ms.steps]))
}

lines.push('')
for (const arm of [...OVERHEAD, ...OUTCOMES]) {
  const result = load(arm)
  if (result) {
    lines.push(`- ${arm}: ${result.what}. Faults at ${result.faults.map((fault) => `${fault.at_ms} ms`).join(', ') || 'none'}; the burst took ${result.burst_ms} ms.`)
  }
}

const text = `${lines.join('\n')}\n`
writeFileSync(path.join(HERE, 'results', 'table.md'), text)
console.log(text)

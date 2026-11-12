/**
 * What iii 0.26's queue does with a job whose worker dies, whose handler runs too long, or whose
 * handler keeps failing, and what a job keeps of its payload and metadata.
 *
 * 1. kill: the consumer is SIGKILLed 1 s into a job and comes back 2 s later.
 * 2. away: the same, but the consumer stays away for 8 s.
 * 3. timeout: an 8 s job on a queue whose timeout_ms is 2 s.
 * 4. fail: a handler that always throws, on a queue with max_retries 2.
 *
 * Run from this folder after `npm install`: npx tsx q1Queue.ts
 * QUEUE_BIN picks the queue worker binary; it defaults to the newest one in iii's package cache.
 */
import { CallAction } from 'iii-sdk'
import { brief, connect, log, sleep, startProbe, startRole, waitForFunctions, type Role } from './lib.js'

const QUEUE_CONFIG = `adapter:
  name: builtin
  config:
    store_method: in_memory
queue_configs:
  probe:
    concurrency: 4
    max_retries: 2
    backoff_ms: 500
    timeout_ms: 2000
  long:
    concurrency: 4
    max_retries: 2
    backoff_ms: 500
    timeout_ms: 60000
`

const probe = await startProbe('q1')
const queue = await probe.startQueue(QUEUE_CONFIG)
let consumer = startRole('consumer', 'consumer.ts')
await consumer.waitFor(/^ROLE/)
const caller = connect('probe-caller')
await waitForFunctions(caller, ['probe::job', 'probe::fail', 'engine::queue::enqueue'])

caller.registerFunction('probe::workers-changed', async (envelope: { input: { event: string; worker_id: string } }) => {
  log(`EVENT ${envelope.input.event} ${envelope.input.worker_id.slice(0, 8)}`)
  return null
})
await waitForFunctions(caller, ['probe::workers-changed'])
await caller.observe({ function_id: 'engine::on-workers-changed', capture: ['input'] }, 'probe::workers-changed').ready()

async function enqueue(queueName: string, functionId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const receipt = await caller.call({
      function_id: functionId,
      payload,
      action: CallAction.Enqueue({ queue: queueName }),
      metadata: { sent_with: 'metadata', label: payload.label },
    })
    log(`enqueued ${payload.label} on ${queueName}`, receipt)
  } catch (error) {
    log(`enqueue ${payload.label} failed`, brief(error))
  }
}

function starts(role: Role, label: string): string[] {
  return role.lines.filter((line) => line.startsWith(`HANDLER start ${label} `))
}

function startedAt(line: string): number {
  return Number(/ at (\d+) /.exec(line)?.[1])
}

async function stats(label: string): Promise<void> {
  const calls: { function_id: string; payload: Record<string, string> }[] = [
    { function_id: 'engine::queue::topic_stats', payload: { topic: 'long' } },
    { function_id: 'engine::queue::topic_stats', payload: { topic: 'probe' } },
    { function_id: 'engine::queue::dlq_topics', payload: {} },
  ]
  for (const call of calls) {
    try {
      log(`${label} ${call.function_id} ${JSON.stringify(call.payload)}`, await caller.call({ ...call, timeoutMs: 5000 }))
    } catch (error) {
      log(`${label} ${call.function_id} failed`, brief(error))
    }
  }
}

function restartConsumer(): Promise<string> {
  consumer = startRole('consumer', 'consumer.ts')
  return consumer.waitFor(/^ROLE/)
}

log('--- 1. kill: the consumer dies 1 s into a 30 s job and is back after 2 s')
await enqueue('long', 'probe::job', { label: 'kill', hold_ms: 30_000, workflow_id: 'wf-kill' })
await consumer.waitFor(/HANDLER start kill /)
await sleep(1000)
const killedAt = Date.now()
consumer.kill('SIGKILL')
await sleep(2000)
await restartConsumer()
const restartedAt = Date.now()
const again = await consumer.waitFor(/HANDLER start kill /, 75_000).catch(() => undefined)
if (again) {
  log(`CHECK kill: delivered again ${startedAt(again) - killedAt} ms after the kill, ${startedAt(again) - restartedAt} ms after the restart`)
  log(`CHECK kill: the redelivered job had`, JSON.parse(again.slice(again.indexOf('{'))))
  await consumer.waitFor(/HANDLER end kill /, 40_000).catch(() => log('the redelivered kill job never finished'))
} else {
  log('CHECK kill: the job was not delivered again within 75 s of the restart')
}
await stats('after kill')

log('--- 2. away: the consumer dies 1 s into a job and stays away for 8 s')
await enqueue('long', 'probe::job', { label: 'away', hold_ms: 30_000, workflow_id: 'wf-away' })
await consumer.waitFor(/HANDLER start away /)
await sleep(1000)
const awayAt = Date.now()
consumer.kill('SIGKILL')
await sleep(8000)
await stats('while the consumer is away')
await restartConsumer()
const backAt = Date.now()
const awayAgain = await consumer.waitFor(/HANDLER start away /, 30_000).catch(() => undefined)
if (awayAgain) {
  log(`CHECK away: delivered again ${startedAt(awayAgain) - awayAt} ms after the kill, ${startedAt(awayAgain) - backAt} ms after the restart`)
} else {
  log('CHECK away: the job was not delivered again within 30 s of the restart')
}
await stats('after away')

log('--- 3. timeout: an 8 s job on a queue with timeout_ms 2000')
await enqueue('probe', 'probe::job', { label: 'slow', hold_ms: 8000, workflow_id: 'wf-slow' })
await sleep(20_000)
const slowStarts = starts(consumer, 'slow')
const slowEnds = consumer.lines.filter((line) => line.startsWith('HANDLER end slow '))
log(`CHECK timeout: the handler started ${slowStarts.length} times and finished ${slowEnds.length} times`, slowStarts.map((line) => startedAt(line) - startedAt(slowStarts[0])))
await stats('after timeout')

log('--- 4. fail: a handler that always throws, max_retries 2, backoff_ms 500')
await enqueue('probe', 'probe::fail', { label: 'fail', workflow_id: 'wf-fail' })
await sleep(8000)
const failStarts = starts(consumer, 'fail')
log(`CHECK fail: the handler ran ${failStarts.length} times, at`, failStarts.map((line) => startedAt(line) - startedAt(failStarts[0])))
await stats('after fail')
try {
  log('dlq messages', await caller.call({ function_id: 'engine::queue::dlq_messages', payload: { topic: 'probe' }, timeoutMs: 5000 }))
} catch (error) {
  log('dlq messages failed', brief(error))
}

await caller.shutdown()
await consumer.stop('SIGKILL')
await queue.stop()
await probe.engine.stop()
process.exit(0)

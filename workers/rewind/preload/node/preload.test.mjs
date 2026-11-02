/**
 * Tests for the Node preload that need no iii engine. The ones that load the
 * preload start a child Node with `--import` and a capture file in a temporary
 * folder. Run them with `node --test workers/rewind/preload/node/preload.test.mjs`.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { MAX_BODY_BYTES, bodyFields, storedBody } from './body.mjs'
import { readRequest } from './fetch.mjs'
import { REDACTED, askedHeaders, recordedHeaders, withoutRedacted } from './headers.mjs'

const PRELOAD = fileURLToPath(new URL('./index.mjs', import.meta.url))
const scratch = mkdtempSync(path.join(tmpdir(), 'rewind-preload-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const SECRETS = { authorization: 'Bearer sk-test-secret', cookie: 'session=cookie-secret', 'x-api-key': 'key-secret', 'x-tenant': 'tenant-secret' }

async function runChild(name, source, env) {
  const script = path.join(scratch, `${name}.mjs`)
  const captures = path.join(scratch, `${name}.jsonl`)
  writeFileSync(script, source)
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', PRELOAD, script], {
    cwd: scratch,
    env: { ...process.env, REWIND_CAPTURE_FILE: captures, REWIND_REDACT_HEADERS: 'x-tenant', ...env },
  })
  const lines = existsSync(captures) ? readFileSync(captures, 'utf8').trim().split('\n') : []
  return { output: JSON.parse(stdout.trim().split('\n').at(-1)), text: lines.join('\n'), captures: lines.map((line) => JSON.parse(line)) }
}

// A server in the child that keeps the headers it got and sends a cookie and a body over the cap.
const SERVER_AND_FETCH = `
import http from 'node:http'
import { AsyncLocalStorage as Storage } from 'node:async_hooks'
let seen
const server = http.createServer((request, response) => {
  seen = request.headers
  request.resume()
  request.on('end', () => {
    response.setHeader('set-cookie', 'session=set-cookie-secret')
    response.end('x'.repeat(200_000))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = 'http://127.0.0.1:' + server.address().port + '/thing'
const call = () => fetch(url, { method: 'POST', headers: { ...${JSON.stringify(SECRETS)}, accept: 'application/json' }, body: 'y'.repeat(100_000) })
const answer = await new Storage().run({ invocation_id: 'inv-1', function_id: 'test::call' }, async () => (await call()).text())
server.close()
`

describe('headers', () => {
  it('stores secret headers with their name and a hidden value, and leaves out trace headers', () => {
    const stored = recordedHeaders({ Authorization: 'Bearer x', cookie: 'a=b', 'x-goog-api-key': 'k', 'x-csrf-token': 't', accept: '*/*', traceparent: '00-1', baggage: 'b' })
    assert.deepEqual(stored, { Authorization: REDACTED, cookie: REDACTED, 'x-goog-api-key': REDACTED, 'x-csrf-token': REDACTED, accept: '*/*' })
  })

  it('leaves secret headers out of a question to Rewind and lists their names', () => {
    assert.deepEqual(askedHeaders({ authorization: 'Bearer x', 'proxy-authorization': 'p', accept: '*/*', traceparent: '00-1' }), {
      headers: { accept: '*/*' },
      redacted_headers: ['authorization', 'proxy-authorization'],
    })
    assert.deepEqual(askedHeaders({ accept: '*/*' }), { headers: { accept: '*/*' } })
  })

  it('hands back no header whose value was hidden', () => {
    assert.deepEqual(withoutRedacted({ 'set-cookie': REDACTED, 'content-type': 'text/plain' }), { 'content-type': 'text/plain' })
  })
})

describe('bodies', () => {
  it('stores a body under the cap whole, as text or base64', () => {
    assert.deepEqual(bodyFields(Buffer.from('hello')), { body: 'hello' })
    assert.deepEqual(bodyFields(Buffer.from([0xff, 0x00])), { body: '/wA=', body_encoding: 'base64' })
    assert.deepEqual(bodyFields(Buffer.alloc(0)), { body: null })
  })

  it('cuts a body over the cap and says how long it was and what it hashed to', () => {
    const whole = Buffer.from('z'.repeat(MAX_BODY_BYTES + 10))
    const stored = bodyFields(whole)
    assert.equal(stored.body.length, MAX_BODY_BYTES)
    assert.deepEqual(stored.body_truncated, { bytes: MAX_BODY_BYTES + 10, sha256: createHash('sha256').update(whole).digest('hex') })
  })

  it('cuts text on a character boundary and gives the same result in chunks', () => {
    const whole = Buffer.from(`${'a'.repeat(MAX_BODY_BYTES - 1)}é${'b'.repeat(10)}`)
    const chunked = storedBody()
    for (let at = 0; at < whole.length; at += 1000) {
      chunked.add(whole.subarray(at, at + 1000))
    }

    const stored = bodyFields(whole)
    assert.equal(stored.body, 'a'.repeat(MAX_BODY_BYTES - 1))
    assert.equal(stored.body_encoding, undefined)
    assert.deepEqual(chunked.fields(), stored)
  })

  it('cuts a request body the same way for the capture and for the question, so they still match', async () => {
    const options = { method: 'post', path: '/send', origin: 'http://127.0.0.1:9', headers: ['authorization', 'Bearer x', 'accept', '*/*'], body: 'q'.repeat(MAX_BODY_BYTES * 2) }
    const { input, question, bytes } = await readRequest(options)
    assert.equal(bytes.length, MAX_BODY_BYTES * 2)
    assert.equal(question.body, input.body)
    assert.deepEqual(question.body_truncated, input.body_truncated)
    assert.equal(input.headers.authorization, REDACTED)
    assert.deepEqual(question.headers, { accept: '*/*' })
    assert.deepEqual(question.redacted_headers, ['authorization'])
  })
})

describe('record mode', () => {
  it('sends credentials as usual but stores none of them, and caps both bodies', async () => {
    const source = `${SERVER_AND_FETCH}\nconsole.log(JSON.stringify({ seen, bigLength: answer.length }))\n`
    const { output, text, captures } = await runChild('record', source, { REWIND_CAPTURE: 'record' })
    for (const [name, value] of Object.entries(SECRETS)) {
      assert.equal(output.seen[name], value, `the server got ${name}`)
      assert.ok(!text.includes(value), `no capture contains the ${name} value`)
    }

    assert.ok(!text.includes('set-cookie-secret'))
    assert.equal(output.bigLength, 200_000)

    const fetched = captures.find((capture) => capture.kind === 'fetch')
    assert.equal(fetched.invocation_id, 'inv-1')
    for (const name of Object.keys(SECRETS)) {
      assert.equal(fetched.input.headers[name], REDACTED)
    }

    assert.equal(fetched.input.headers.accept, 'application/json')
    assert.equal(fetched.input.body.length, MAX_BODY_BYTES)
    assert.equal(fetched.input.body_truncated.bytes, 100_000)
    assert.equal(fetched.output.headers['set-cookie'], REDACTED)
    assert.equal(fetched.output.body.length, MAX_BODY_BYTES)
    assert.equal(fetched.output.body_truncated.bytes, 200_000)

    const received = captures.find((capture) => capture.kind === 'http_in')
    assert.equal(received.input.headers.authorization, REDACTED)
    assert.equal(received.input.body_truncated.bytes, 100_000)
    assert.equal(received.output.headers['set-cookie'], REDACTED)
    assert.equal(received.output.body_truncated.bytes, 200_000)
  })
})

describe('off mode', () => {
  it('changes nothing and writes no capture', async () => {
    const source = `
import { AsyncLocalStorage } from 'node:async_hooks'
import diagnostics from 'node:diagnostics_channel'
const before = {
  run: AsyncLocalStorage.prototype.run.name,
  dispatcher: typeof globalThis[Symbol.for('undici.globalDispatcher.1')],
  inbound: diagnostics.channel('http.server.request.start').hasSubscribers,
  tracer: typeof globalThis[Symbol.for('rewind.trace')],
}
${SERVER_AND_FETCH}
console.log(JSON.stringify(before))
`
    const { output, captures } = await runChild('off', source, { REWIND_CAPTURE: 'off', REWIND_TRACE_FUNCTIONS: 'off.mjs:anything' })
    assert.deepEqual(output, { run: 'run', dispatcher: 'undefined', inbound: false, tracer: 'undefined' })
    assert.deepEqual(captures, [])
  })
})

describe('replay mode', () => {
  it('takes headers whose recorded value was hidden out of a request to the copy', async () => {
    const source = `
import http from 'node:http'
const server = http.createServer((request, response) => response.end(JSON.stringify({ headers: request.headers, raw: request.rawHeaders })))
await new Promise((resolve) => server.listen(8080, '127.0.0.1', resolve))
const headers = { authorization: '${REDACTED}', cookie: '${REDACTED}', accept: 'text/plain' }
const seen = await new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: server.address().port, path: '/', headers, agent: false }, (response) => {
    let text = ''
    response.on('data', (chunk) => (text += chunk))
    response.on('end', () => resolve(JSON.parse(text)))
  }).on('error', reject)
})
console.log(JSON.stringify({ port: server.address().port, ...seen }))
process.exit(0)
`
    const { output, captures } = await runChild('replay', source, { REWIND_CAPTURE: 'replay' })
    assert.notEqual(output.port, 8080)
    assert.equal(output.headers.authorization, undefined)
    assert.equal(output.headers.cookie, undefined)
    assert.equal(output.headers.accept, 'text/plain')
    assert.ok(!output.raw.includes(REDACTED))
    assert.deepEqual(captures, [])
  })
})

/**
 * The fake providers the sample app calls over plain HTTP, outside iii: US
 * holidays for the agent, and an email provider for the tools worker. Only
 * Rewind's preloads see these calls, so they are what a replay has to stand in for.
 *
 *   GET  /holidays?from=2026-11-09&weeks=2  returns  { from, to, holidays: [{ date, name }] }
 *   POST /email { to, subject, start }      returns  { status: "accepted", id }
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type Send, sendEmail } from './email.js'
import { holidaysBetween } from './holidays.js'

const MAX_WEEKS = 52

type Reply = { status: number; body: unknown }
type Route = (url: URL, body: string) => Promise<Reply>

const ROUTES: Record<string, Route> = {
  'GET /holidays': async (url) => {
    const from = url.searchParams.get('from') ?? ''
    const weeks = Number(url.searchParams.get('weeks') ?? 2)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isInteger(weeks) || weeks < 1 || weeks > MAX_WEEKS) {
      return { status: 400, body: { error: `from must be a date and weeks 1 to ${MAX_WEEKS}` } }
    }

    return { status: 200, body: holidaysBetween(from, weeks) }
  },
  'POST /email': async (_url, body) => {
    const send = JSON.parse(body) as Send
    if (!send.to || !send.subject || !send.start) {
      return { status: 400, body: { error: 'a send needs to, subject and start' } }
    }

    return { status: 200, body: await sendEmail(send) }
  },
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(chunk as Buffer)
  }

  return Buffer.concat(chunks).toString('utf8')
}

function send(response: ServerResponse, { status, body }: Reply): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const route = ROUTES[`${request.method} ${url.pathname}`]
  if (!route) {
    send(response, { status: 404, body: { error: `no route for ${request.method} ${url.pathname}` } })
    return
  }

  try {
    send(response, await route(url, await readBody(request)))
  } catch (error) {
    send(response, { status: 500, body: { error: error instanceof Error ? error.message : String(error) } })
  }
}

export function serveProviders(port: number): Server {
  const server = createServer((request, response) => void handle(request, response))
  server.listen(port, '127.0.0.1')
  return server
}

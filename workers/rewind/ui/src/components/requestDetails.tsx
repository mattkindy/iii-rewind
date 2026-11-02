/**
 * What an open call shows about requests around iii: for a request itself, its
 * method, full URL and body; for an iii call, the requests its worker made
 * while it ran, such as the POST to the email provider under `email::send`.
 * Bodies show parsed, so JSON text never shows inside JSON.
 */
import { CollapsibleCard, CollapsibleCardContent, CollapsibleCardTrigger } from '@iii-dev/console-ui'
import { ChevronRight, Globe } from 'lucide-react'
import type { Call } from '../client/types'
import { summarizeAnswer } from '../model/answers'
import { duration } from '../model/format'
import { callName, parseRequestId, readableBody, readableValue } from '../model/requests'
import { JsonBlock, SectionHead } from './bits'

/** The request a call made around iii: its method, the full URL, and the body it sent. */
export function RequestBlock({ call }: { call: Call }) {
  const request = parseRequestId(call.function_id)
  if (!request) {
    return null
  }

  const input = call.input as { body?: string | null; body_encoding?: string } | null
  const body = readableBody(input?.body, input?.body_encoding)
  return (
    <section className="rw-block">
      <SectionHead title="Request outside iii" />
      <code className="rw-request-line">
        <span className="rw-request-method">{request.method}</span> {request.url}
      </code>
      {body === null ? null : typeof body === 'string' ? <pre className="rw-embedded">{body}</pre> : <JsonBlock title="Body sent" value={body} />}
    </section>
  )
}

function InnerRequest({ call }: { call: Call }) {
  const request = parseRequestId(call.function_id)
  return (
    <li className="rw-inner">
      <span className="rw-inner-head">
        <Globe aria-hidden />
        <span className="rw-mono rw-inner-name" title={request?.url}>
          {callName(call.function_id)}
        </span>
        <span className="rw-inner-summary">{summarizeAnswer(call.answer)}</span>
        {call.duration_ms ? <span className="rw-seq-duration">{duration(call.duration_ms)}</span> : null}
      </span>
      <CollapsibleCard className="rw-collapse">
        <CollapsibleCardTrigger className="rw-collapse-trigger">
          <ChevronRight aria-hidden className="rw-collapse-caret" />
          <span>Request and response</span>
        </CollapsibleCardTrigger>
        <CollapsibleCardContent>
          <div className="rw-details">
            <JsonBlock title="Request" value={readableValue(call.input)} />
            <JsonBlock title="Response" value={'value' in call.answer ? readableValue(call.answer.value) : call.answer} />
          </div>
        </CollapsibleCardContent>
      </CollapsibleCard>
    </li>
  )
}

/** The requests a call's worker made while it ran. A replay never makes them, because a stub answers the call. */
export function InnerRequests({ call }: { call: Call }) {
  const inner = call.inner ?? []
  if (inner.length === 0) {
    return null
  }

  return (
    <section className="rw-block">
      <SectionHead title={inner.length === 1 ? 'Outbound request' : `${inner.length} outbound requests`} />
      <ul className="rw-inner-list">
        {inner.map((request, index) => (
          <InnerRequest key={request.invocation_id ?? index} call={request} />
        ))}
      </ul>
    </section>
  )
}

/**
 * What opens under a row in the sequence. For a call: one line on why it
 * matters, its answer, and one action, with input, timing and ids behind
 * Details. For the ending: how the run ended. JSON text inside an answer, such
 * as cut-off tool arguments, is shown as text on its own, marked where parsing
 * stops, because escaped inside JSON it cannot be read.
 */
import {
  ActionLine,
  Button,
  CollapsibleCard,
  CollapsibleCardContent,
  CollapsibleCardTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  JsonHighlight,
  KeyCombo,
  MetaRow,
  type MetaRowItem,
  StatusPanel,
  Tooltip,
} from '@iii-dev/console-ui'
import { copyText } from '@iii-dev/console-ui/format'
import { ChevronRight, Copy, CopyCheck, Crosshair, Ellipsis, Info, Play, SquarePen, TriangleAlert, Waypoints, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { Call } from '../client/types'
import { useSpans } from '../data/useSpans'
import { callName, isRequestId, readableValue } from '../model/requests'
import { answerText, errorLabel, type Finding, findings, isError, isRepeatedCall, withTextSetAside } from '../model/answers'
import { notLiveReason } from '../model/choices'
import { clockTime, duration, errorDetail, shortId } from '../model/format'
import { type Cases, caseOf } from '../model/cases'
import { type Cursor, type Line, type LineOutcome, callAt, nextCall } from '../model/lines'
import { answerCheck, callIssue, type Formats, issueText, problemText } from '../model/schema'
import { SOURCES } from '../model/sources'
import { AnswerEditor } from './answerEditor'
import { CutText, JsonBlock, RecoverButton, SectionHead } from './bits'
import { WhereItFailed } from './functionSpans'
import { InnerRequests, RequestBlock } from './requestDetails'
import type { TraceTarget } from '../model/traceTarget'
import { NO_SPAN_SELECTION } from './traceSync'

// The rows at the top of Details. Ids and timing live here so the open call leads with its answer.
function detailItems(call: Call): MetaRowItem[] {
  const items: (MetaRowItem | null)[] = [
    { label: 'Worker', value: call.worker },
    { label: 'Effects', value: call.effects.join(', ') || 'none declared' },
    call.duration_ms ? { label: 'Took', value: duration(call.duration_ms) } : null,
    call.started_at_ms ? { label: 'Started', value: clockTime(call.started_at_ms) } : null,
    call.invocation_id ? { label: 'Invocation', value: shortId(call.invocation_id) } : null,
  ]
  return items.filter((item): item is MetaRowItem => item !== null)
}

export type EditingProps = {
  text: string | null
  onStart: () => void
  onChange: (next: string) => void
  onFork: () => void
  onCancel: () => void
  onInject: () => void
  busy: boolean
  error: string | null
}

type PanelProps = {
  client: RewindClient
  line: Line
  original: Line
  /** The run's own invocation, whose traced functions show where the agent itself failed. */
  runInvocation?: string
  cursor: Cursor
  cause: Cursor
  entry: string
  input: unknown
  editing: EditingProps
  /** Where the call at the cursor is in Traces, when Rewind knows. */
  trace: { target: TraceTarget | null; available: boolean; spanSelectable: boolean; onShow: (target: TraceTarget) => void }
  onOpenRecovery: () => void
  /** On the original, Replay goes beside Edit answer on the likely cause. */
  replay?: { label: string; onReplay: () => void }
  formats: Formats
}


function filledDetail(effects: string[]): string {
  const reason = notLiveReason(effects)
  return reason ? `${reason} · not sent` : 'Not sent'
}

/** A fork chose these answers on its own, so changing one forks again from that call. */
function chosenByFork(line: Line, call: Call): boolean {
  return line.kind !== 'original' && (call.source === 'live' || call.source === 'filled')
}

/**
 * Whose traced functions explain a failure after this call: the next call's,
 * when it failed on this answer, or the run's own, when the agent threw.
 */
function failureInvocation(line: Line, call: Call, runInvocation: string | undefined): string | undefined {
  const next = nextCall(line, call)
  if (next && isError(next.answer)) {
    return next.invocation_id
  }

  return line.outcome.state === 'crashed' ? runInvocation : undefined
}

function Details({ items, input, event, title = 'Details' }: { items: MetaRowItem[]; input: unknown; event?: Record<string, unknown>; title?: string }) {
  return (
    <CollapsibleCard className="rw-collapse">
      <CollapsibleCardTrigger className="rw-collapse-trigger">
        <ChevronRight aria-hidden className="rw-collapse-caret" />
        <span>{title}</span>
      </CollapsibleCardTrigger>
      <CollapsibleCardContent>
        <div className="rw-details">
          {items.length > 0 ? <MetaRow items={items} className="rw-meta" /> : null}
          <JsonBlock title="Input" value={input} />
          {event ? <JsonBlock title="Recorded event" value={event} /> : null}
        </div>
      </CollapsibleCardContent>
    </CollapsibleCard>
  )
}

/** What happened right after this call, as the first part of the cause line. */
function happenedAfter(line: Line, call: Call): string {
  const next = nextCall(line, call)
  if (next && isError(next.answer)) {
    return `Next call ${callName(next.function_id)} failed with ${errorLabel(next.answer.error)}`
  }

  if (line.outcome.state === 'crashed') {
    return `Run threw ${errorLabel(line.outcome.error)} after this answer`
  }

  return 'Last call before the run ended'
}

function causeLine(line: Line, call: Call, found: Finding[]): string {
  if (isRepeatedCall(call)) {
    return ['Caller timed out and retried · ran twice', call.inferred].filter(Boolean).join(' · ')
  }

  return [happenedAfter(line, call), found[0]?.title].filter(Boolean).join(' · ')
}

/** What the schemas say about the cause: the input of the call that failed next, else this call's own output. */
function schemaLine(line: Line, call: Call, formats: Formats): string | undefined {
  const next = nextCall(line, call)
  const nextIssue = next && isError(next.answer) ? callIssue(next, formats) : undefined
  if (next && nextIssue?.side === 'input') {
    return `${callName(next.function_id)} input · ${problemText(nextIssue.problem)}`
  }

  const own = callIssue(call, formats)
  return own ? issueText(own) : undefined
}

/** One callout for the likely cause, saying what went wrong, and what in the answer did it, from the schemas when they say. */
function CauseCallout({ line, call, found, formats }: { line: Line; call: Call; found: Finding[]; formats: Formats }) {
  const schema = schemaLine(line, call, formats)
  const what = causeLine(line, call, schema ? found.filter((f) => f.kind === 'cut-json') : found)
  const detail = schema ? (
    <>
      <span className="rw-cause-line">{what}</span>
      <span className="rw-cause-line">{schema}</span>
    </>
  ) : (
    what
  )
  return <StatusPanel variant="warn" icon={<Crosshair aria-hidden />} headline="Likely cause" detail={detail} />
}

/** The call as the observer reported it, which is what traces shows for the same invocation. */
function observedEvent(call: Call): Record<string, unknown> {
  const outcome = isError(call.answer) ? { status: 'error', error: call.answer.error } : { status: 'success', output: readableValue(call.answer.value) }
  return {
    invocation_id: call.invocation_id,
    function_id: call.function_id,
    worker: call.worker,
    started_at_ms: call.started_at_ms,
    duration_ms: call.duration_ms,
    input: readableValue(call.input),
    ...outcome,
  }
}

function EmbeddedText({ finding }: { finding: Finding }) {
  return (
    <section className="rw-block">
      <div className="rw-section-head">
        <code className="rw-mono rw-path">{finding.path}</code>
      </div>
      <CutText text={finding.text ?? ''} position={finding.position} />
    </section>
  )
}

/** Shows the call in Traces, or says why it can't. */
function TraceItem({ trace }: { trace: PanelProps['trace'] }) {
  if (!trace.available) {
    return null
  }

  const target = trace.target
  const note = target ? (trace.spanSelectable ? null : NO_SPAN_SELECTION) : 'No trace id'
  return (
    <DropdownMenuItem disabled={!target} onSelect={() => (target ? trace.onShow(target) : undefined)}>
      <Waypoints aria-hidden />
      <span className="rw-menu-row">
        Show in Traces
        {note ? <span className="rw-menu-meta">{note}</span> : null}
      </span>
    </DropdownMenuItem>
  )
}

function CallPanel({ props, call }: { props: PanelProps; call: Call }) {
  const { line, cause, editing } = props
  const found = findings(call.answer)
  const isCause = line.kind === 'original' && cause === call.seq
  const details = detailItems(call)
  const spans = useSpans(props.client, [call.invocation_id, isCause ? failureInvocation(line, call, props.runInvocation) : undefined])
  const request = isRequestId(call.function_id)
  const issue = isCause ? undefined : callIssue(call, props.formats)

  if (editing.text !== null) {
    return (
      <div className="rw-insp-body">
        <AnswerEditor
          recorded={call.answer}
          source={call.source}
          text={editing.text}
          onChange={editing.onChange}
          onFork={editing.onFork}
          onCancel={editing.onCancel}
          busy={editing.busy}
          error={editing.error}
          check={answerCheck(props.formats, call.function_id)}
        />
        <Details items={details} input={readableValue(call.input)} />
      </div>
    )
  }

  const shown = isError(call.answer) ? call.answer : { value: withTextSetAside(call.answer.value, found) }
  const editLabel = chosenByFork(line, call) ? 'Change answer' : 'Edit answer'
  return (
    <div className="rw-insp-body">
      {isCause ? <CauseCallout line={line} call={call} found={found} formats={props.formats} /> : null}
      {issue ? (
        <ActionLine icon={<TriangleAlert aria-hidden />} tone="warn" className="rw-finding">
          {issueText(issue)}
        </ActionLine>
      ) : null}
      {!isCause && call.inferred ? <StatusPanel variant="info" icon={<Info aria-hidden />} headline="Inferred answer" detail={call.inferred} /> : null}
      {call.source === 'filled' ? (
        <StatusPanel
          variant="info"
          icon={<CopyCheck aria-hidden />}
          headline={call.filled_from ? `Filled from run ${shortId(call.filled_from)}` : 'Filled from another run'}
          detail={filledDetail(call.effects)}
        />
      ) : null}
      {!isCause
        ? found.map((finding) => (
            <ActionLine key={finding.path} icon={<TriangleAlert aria-hidden />} tone="warn" className="rw-finding">
              {finding.title}
            </ActionLine>
          ))
        : null}
      <WhereItFailed spans={spans} />
      {request ? <RequestBlock call={call} /> : null}
      <section className="rw-block">
        <SectionHead title={request ? SOURCES[call.source].responseTitle : SOURCES[call.source].answerTitle} />
        <div className="rw-code" data-preview="">
          <JsonHighlight code={answerText(shown)} wrap />
        </div>
      </section>
      {found.filter((f) => f.kind === 'cut-json').map((finding) => (
        <EmbeddedText key={finding.path} finding={finding} />
      ))}
      <InnerRequests call={call} />
      <div className="rw-actions">
        <Tooltip label={<>{editLabel} <KeyCombo binding="Alt+E" /></>}>
          <Button variant="primary" onClick={editing.onStart} disabled={editing.busy}>
            <SquarePen aria-hidden />
            {editLabel}
          </Button>
        </Tooltip>
        {isCause && props.replay ? (
          <Tooltip label={<>Rerun with recorded answers <KeyCombo binding="Alt+R" /></>}>
            <Button variant="pill" onClick={props.replay.onReplay} disabled={editing.busy}>
              <Play aria-hidden />
              {props.replay.label}
            </Button>
          </Tooltip>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label="More actions for this call" tooltip={false} disabled={editing.busy}>
              <Ellipsis aria-hidden />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={editing.onInject}>
              <Zap aria-hidden />
              Fork with error
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copyText(answerText(call.answer))}>
              <Copy aria-hidden />
              Copy answer
            </DropdownMenuItem>
            <TraceItem trace={props.trace} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {editing.error ? <StatusPanel variant="alert" role="alert" headline="Fork failed" detail={editing.error} /> : null}
      <Details items={details} input={readableValue(call.input)} event={call.invocation_id ? observedEvent(call) : undefined} />
    </div>
  )
}

function EndPanel({ props }: { props: PanelProps }) {
  const { line, entry, input, onOpenRecovery } = props
  const spans = useSpans(props.client, [line.kind === 'original' ? props.runInvocation : undefined])
  const body: Cases<LineOutcome, ReactNode> = {
    done: ({ output }) => <JsonBlock title="Returned" value={output} />,
    crashed: ({ error }) => <StatusPanel variant="alert" headline={`Threw ${errorLabel(error)}`} detail={<code className="rw-wrap">{errorDetail(error.message)}</code>} />,
    stopped: ({ output }) => (
      <>
        {output !== undefined ? <JsonBlock title="Returned anyway" value={output} /> : null}
        <div className="rw-actions">
          <RecoverButton variant="pill" onClick={onOpenRecovery}>
            Recover run
          </RecoverButton>
        </div>
      </>
    ),
    paused: () => null,
  }
  return (
    <div className="rw-insp-body">
      {caseOf(line.outcome, 'state', body)}
      <WhereItFailed spans={spans} />
      <Details items={[{ label: 'Entry', value: entry }]} input={input} />
    </div>
  )
}

export function CallInspector(props: PanelProps) {
  const { line, cursor } = props
  const call = cursor === 'end' ? undefined : callAt(line, cursor)
  return call ? <CallPanel props={props} call={call} /> : <EndPanel props={props} />
}

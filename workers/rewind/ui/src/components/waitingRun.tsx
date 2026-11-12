/**
 * One durable run waiting on a pending step, and the one question it asks: what to give it. The
 * top says what the run was asked to do and what it waits for. A wait about a call shows that
 * call's input, which for the agent is the invite about to go out. Below is the answer: the
 * wait's choices, a value typed as JSON, waking a sleep, or deciding about a call a crash cut
 * off. Once the step is resolved, the answer gives way to how the run went on.
 */
import { type BreadcrumbItem, Button, Chip, CodeEditor, StatusPanel } from '@iii-dev/console-ui'
import { errorMessage } from '@iii-dev/console-ui/format'
import { CircleCheck, Diamond, Hourglass } from 'lucide-react'
import { useState } from 'react'
import type { JournalClient, Resolution, Settled, WaitingRun as Run } from '../client/journalClient'
import { requestText, shortId } from '../model/format'
import { aboutCall, afterLine, type Answer, answersFor, pendingTitle, roughDuration, runLine } from '../model/pending'
import { JsonBlock, SectionHead, Step } from './bits'
import { LevelBar } from './levelBar'
import { useNow } from './motion'

// How long the page waits to say how the run went on, before it settles for "Resumed".
const FOLLOW_MS = 20_000

const LOST_LINE = 'The worker died while this call was out, so it may have done its work'

function parsedValue(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

/** What the run waits for, or waited for once `resolvedAt` is set. */
function Waited({ run, now, resolvedAt }: { run: Run; now: number; resolvedAt: number | null }) {
  const about = aboutCall(run.pending.detail)
  const aside = resolvedAt === null ? runLine(run, now) : `Waited ${roughDuration(resolvedAt - run.pending.since_ms)}`
  return (
    <Step icon={Hourglass} tone={resolvedAt === null ? 'warn' : 'accent'} title={pendingTitle(run.pending)} aside={aside}>
      {run.pending.kind === 'lost' ? <p className="rw-step-text">{LOST_LINE}</p> : null}
      {about ? <JsonBlock title={`Before ${about.functionId}`} value={about.input} /> : null}
      {!about && run.pending.detail !== undefined ? <JsonBlock title="Detail" value={run.pending.detail} /> : null}
    </Step>
  )
}

function Answered({ resolution, after }: { resolution: Resolution; after: Settled | null | undefined }) {
  const following = after === undefined
  return (
    <Step icon={CircleCheck} tone="ok" title="Resolved" last>
      <StatusPanel
        variant={after?.status === 'failed' ? 'warn' : 'success'}
        headline={following ? 'Resumed · following the run' : afterLine(after)}
        detail={resolution.resumed ? undefined : 'Kept for when the run gets to this wait'}
      />
    </Step>
  )
}

export function WaitingRun({
  journal,
  run,
  crumbs,
  onBack,
  onResolved,
  announce,
}: {
  journal: JournalClient
  run: Run
  crumbs: BreadcrumbItem[]
  onBack: () => void
  /** After a resolve, so the list of waiting runs is read again. */
  onResolved: () => void
  announce: (text: string) => void
}) {
  const now = useNow(1_000)
  const [typing, setTyping] = useState<Answer | null>(null)
  const [text, setText] = useState('{}')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolution, setResolution] = useState<Resolution | null>(null)
  const [resolvedAt, setResolvedAt] = useState<number | null>(null)
  const [after, setAfter] = useState<Settled | null | undefined>(undefined)
  const typed = parsedValue(text)

  const resolve = async (answer: Answer) => {
    setBusy(true)
    setError(null)
    try {
      const value = answer.typed && typed.ok ? { value: typed.value } : {}
      const resolved = await journal.resolve({ workflow_id: run.workflow_id, step: run.pending.step, ...answer.request, ...value })
      onResolved()
      if (!resolved.resolved) {
        setError(resolved.reason ?? 'The journal did not take it')
        return
      }

      setResolution(resolved)
      setResolvedAt(Date.now())
      announce(`${answer.label} · run resumed`)
      const settled = resolved.resumed ? await journal.settled(run.workflow_id, FOLLOW_MS).catch(() => null) : null
      setAfter(settled)
      onResolved()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const answers = answersFor(run.pending)
  const asking = typing ?? answers.find((answer) => answer.typed && answers.length === 1) ?? null
  return (
    <div className="rw-run">
      <LevelBar crumbs={crumbs} onBack={onBack} />
      <header className="rw-mast">
        <div className="rw-mast-copy">
          <h2 className="rw-mast-title" title={requestText(run.input)}>
            {requestText(run.input)}
          </h2>
          <p className="rw-mast-meta">
            <span className="rw-mono" title={run.workflow_id}>
              {shortId(run.workflow_id)}
            </span>
            <span>{run.function_id}</span>
            <span>step {run.pending.step + 1}</span>
          </p>
        </div>
        <div className="rw-mast-end">
          <Chip tone={resolution ? 'success' : 'warning'} className="rw-chip">
            {resolution ? 'Resolved' : 'Waiting'}
          </Chip>
        </div>
      </header>
      <div className="rw-scroll">
        <div className="rw-recovery">
          <Waited run={run} now={now} resolvedAt={resolvedAt} />
          {resolution ? (
            <Answered resolution={resolution} after={after} />
          ) : (
            <Step icon={Diamond} tone="accent" title="Answer" last>
              {asking ? (
                <>
                  <SectionHead title="Value" />
                  <div className="rw-editor-frame">
                    <CodeEditor value={text} onChange={setText} language="json" aria-label="Value to resolve the step with" autoFocus wordWrap />
                  </div>
                  <div className="rw-actions">
                    <Button variant="primary" disabled={busy || !typed.ok} onClick={() => void resolve(asking)}>
                      {typed.ok ? 'Resolve' : 'Invalid JSON'}
                    </Button>
                    {typing ? (
                      <Button variant="ghost" disabled={busy} onClick={() => setTyping(null)}>
                        Back
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="rw-actions">
                  {answers.map((answer) => (
                    <Button
                      key={answer.label}
                      variant={answer.primary ? 'primary' : 'secondary'}
                      disabled={busy}
                      onClick={() => (answer.typed ? setTyping(answer) : void resolve(answer))}
                    >
                      {answer.label}
                    </Button>
                  ))}
                </div>
              )}
              {error ? <StatusPanel variant="alert" role="alert" headline="Not resolved" detail={error} /> : null}
            </Step>
          )}
        </div>
      </div>
    </div>
  )
}

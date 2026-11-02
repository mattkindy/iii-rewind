/**
 * How a fork differs from the original: a banner that states both endings, and
 * a table that lines the two runs up call by call and marks what changed.
 */
import {
  Button,
  Chip,
  type ChipTone,
  FileDiff,
  StatusPanel,
  Table,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
  TableViewport,
} from '@iii-dev/console-ui'
import { FlaskConical, GitCompareArrows, GitFork, Unplug } from 'lucide-react'
import type { Call } from '../client/types'
import { summarizeAnswer } from '../model/answers'
import { callName, callUrl } from '../model/requests'
import { type Change, type CompareRow, compareLines, countChanges, outcomeJson } from '../model/compare'
import { prettyJson } from '../model/format'
import type { Lane } from '../model/lanes'
import type { Cursor, Line } from '../model/lines'
import { LOST_CALL, type LostKind } from '../model/lost'
import { outcomeLook } from '../model/outcomes'
import { RecoverButton, SectionHead, WorkerGlyph } from './bits'
import { SaveTest, type TestState } from './saveTest'

type ChangeLook = { label: string; tone: ChipTone } | null

const CHANGE: Record<Change, ChangeLook> = {
  same: null,
  answer: { label: 'Different answer', tone: 'accent' },
  input: { label: 'Different input', tone: 'warning' },
  call: { label: 'Different call', tone: 'warning' },
  added: { label: 'New', tone: 'success' },
  removed: { label: 'Gone', tone: 'danger' },
}

function bannerVariant(line: Line): 'success' | 'alert' | 'warn' {
  const look = outcomeLook(line.outcome)
  if (look.tone === 'success') {
    return 'success'
  }

  return look.tone === 'danger' ? 'alert' : 'warn'
}

export function OutcomeBanner({
  line,
  original,
  onCompare,
  comparing,
  test,
  defaultName,
  onSave,
  onRun,
}: {
  line: Line
  original: Line
  onCompare: () => void
  comparing: boolean
  test: TestState
  defaultName: string
  onSave: (name: string) => void
  onRun: () => void
}) {
  const rows = compareLines(original, line)
  const changes = countChanges(rows)
  const canSave = !comparing && !test.saved
  // A fork's own answers decide its ending, so comparing comes first there. A
  // replay with the current code is the fix itself, and keeping it is the next step.
  const keepsFix = line.kind === 'replay'
  const reproduced = changes === 0 && prettyJson(outcomeJson(original.outcome)) === prettyJson(outcomeJson(line.outcome))
  const headline = reproduced
    ? `${line.label} ${outcomeLook(line.outcome).phrase} · same as original`
    : `${line.label} ${outcomeLook(line.outcome).phrase} · original ${outcomeLook(original.outcome).phrase}`
  const detail = reproduced ? 'No differences' : `${changes}/${rows.length} calls differ`
  return (
    <div className="rw-banner">
      <StatusPanel
        variant={reproduced ? 'info' : bannerVariant(line)}
        icon={<GitFork aria-hidden />}
        role="status"
        headline={headline}
        detail={detail}
        action={
          comparing && !canSave ? undefined : (
            <span className="rw-banner-actions">
              {comparing ? null : (
                <Button variant={keepsFix ? 'pill' : 'primary'} size="sm" onClick={onCompare}>
                  <GitCompareArrows aria-hidden />
                  Compare
                </Button>
              )}
              {canSave ? (
                <Button variant={keepsFix ? 'primary' : 'pill'} size="sm" onClick={() => onSave(defaultName)} disabled={test.busy !== null}>
                  <FlaskConical aria-hidden />
                  {test.busy === 'save' ? 'Saving…' : 'Save as test'}
                </Button>
              ) : null}
            </span>
          )
        }
      />
      {!comparing && (test.saved || test.error) ? (
        <SaveTest state={test} defaultName={defaultName} onSave={onSave} onRun={onRun} askName={false} />
      ) : null}
    </div>
  )
}

export function StoppedBanner({ kind, onOpenRecovery }: { kind: LostKind; onOpenRecovery: () => void }) {
  return (
    <div className="rw-banner">
      <StatusPanel
        variant="warn"
        icon={<Unplug aria-hidden />}
        role="status"
        headline={LOST_CALL[kind].headline}
        action={
          <RecoverButton variant="pill" size="sm" onClick={onOpenRecovery}>
            Recover run
          </RecoverButton>
        }
      />
    </div>
  )
}

function Cell({ call, laneFor, change }: { call?: Call; laneFor: (functionId: string, worker?: string) => Lane; change?: Change }) {
  if (!call) {
    return <span className="rw-cmp-none">No call</span>
  }

  const look = change ? CHANGE[change] : null
  return (
    <span className="rw-cmp-cell">
      <span className="rw-cmp-fn">
        <WorkerGlyph lane={laneFor(call.function_id, call.worker)} />
        <span className="rw-mono" title={callUrl(call.function_id)}>
          {callName(call.function_id)}
        </span>
        {look ? (
          <Chip tone={look.tone} className="rw-chip">
            {look.label}
          </Chip>
        ) : null}
      </span>
      <span className="rw-cmp-summary">{summarizeAnswer(call.answer)}</span>
    </span>
  )
}

export function CompareView({
  original,
  line,
  laneFor,
  onPick,
  onClose,
  test,
  defaultName,
  onSave,
  onRun,
}: {
  original: Line
  line: Line
  laneFor: (functionId: string, worker?: string) => Lane
  onPick: (cursor: Cursor) => void
  onClose: () => void
  test: TestState
  defaultName: string
  onSave: (name: string) => void
  onRun: () => void
}) {
  const rows: CompareRow[] = compareLines(original, line)
  const endingChanged = prettyJson(outcomeJson(original.outcome)) !== prettyJson(outcomeJson(line.outcome))
  const finished = line.outcome.state !== 'paused'
  // A paused line has no ending yet, so there is nothing to diff.
  const showEndingDiff = endingChanged && finished

  return (
    <div className="rw-compare">
      <section className="rw-block">
        <SectionHead title={`Original vs ${line.label}`}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Back to calls
          </Button>
        </SectionHead>
        <TableViewport>
          <TableFrame>
            <Table density="compact" inset className="rw-cmp-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="rw-cmp-seq">#</TableHead>
                  <TableHead>Original</TableHead>
                  <TableHead>{line.label}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow key={row.seq} interactive data-change={row.change} onClick={() => onPick(row.seq)}>
                    <TableCell className="rw-cmp-seq">{index + 1}</TableCell>
                    <TableCell>
                      <Cell call={row.left} laneFor={laneFor} />
                    </TableCell>
                    <TableCell>
                      <Cell call={row.right} laneFor={laneFor} change={row.change} />
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow data-change={endingChanged ? 'answer' : 'same'} data-ending="">
                  <TableCell className="rw-cmp-seq">End</TableCell>
                  <TableCell>
                    <span className="rw-cmp-ending" data-tone={outcomeLook(original.outcome).tone}>
                      {outcomeLook(original.outcome).short}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="rw-cmp-ending" data-tone={outcomeLook(line.outcome).tone}>
                      {outcomeLook(line.outcome).short}
                    </span>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TableFrame>
        </TableViewport>
      </section>
      {showEndingDiff ? (
        <section className="rw-block">
          <SectionHead title="Outcome diff" />
          <div className="rw-diff">
            <FileDiff
              oldFile={{ name: 'original.json', contents: `${prettyJson(outcomeJson(original.outcome))}\n` }}
              newFile={{ name: 'fork.json', contents: `${prettyJson(outcomeJson(line.outcome))}\n` }}
              diffStyle="unified"
              lineDiffType="word"
              disableFileHeader
              expandUnchanged
            />
          </div>
        </section>
      ) : null}
      {finished ? (
        <section className="rw-block">
          <SaveTest state={test} defaultName={defaultName} onSave={onSave} onRun={onRun} askName />
        </section>
      ) : null}
    </div>
  )
}

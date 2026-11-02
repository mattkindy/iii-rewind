/**
 * One decision for every run in a group of waiting recoveries. Sends lost
 * mid-call start on Mark all sent, which gives each run the newest result the
 * function returned in a recorded run, the same answer Already sent starts
 * from on one run. Sends that never went out start on Send all. A
 * function that declares no effects starts on nothing, so a person has to
 * pick. Choose per run lists the group's runs, each opening its own decision.
 */
import { Button, List, ListItem } from '@iii-dev/console-ui'
import { Circle, CircleDot, Lock } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import type { RewindClient } from '../client/rewindClient'
import type { RunRow } from '../client/types'
import { type Template, useRecordedAnswer } from '../data/useAnswerTemplate'
import { parseTypedText } from '../model/answers'
import { EFFECTS_UNKNOWN, MAY_REPEAT } from '../model/choices'
import { plural } from '../model/format'
import { callName, callUrl } from '../model/requests'
import { GROUP_CHOICES, type GroupChoice, groupBlockedReason, groupTitle, presetChoice, WAITING_KINDS, type WaitingGroup } from '../model/waiting'
import { ButtonTip, EffectsChips } from './bits'

/** What to apply to a group's runs. `value` is the answer Mark all sent gives each one. */
export type GroupDecision = { group: WaitingGroup; choice: GroupChoice; value?: unknown }

type Recorded = Template | null | undefined

const DESCRIBE: Record<GroupChoice, (group: WaitingGroup, recorded: Recorded) => string | undefined> = {
  'mark-sent': (_group, recorded) => (recorded ? `Result from ${recorded.from}` : undefined),
  resend: (group) => `Up to ${plural(group.runs.length, 'duplicate')}`,
  send: (group) => (group.effects.length === 0 ? MAY_REPEAT : undefined),
  skip: () => 'Nothing is sent',
  'per-run': () => undefined,
}

/** Why a choice can't be picked for this group, or undefined when it can. */
function choiceBlocked(choice: GroupChoice, group: WaitingGroup, recorded: Recorded): string | undefined {
  if (choice === 'mark-sent' && recorded === null) {
    return 'No recorded result'
  }

  return groupBlockedReason(choice, group)
}

/** Why the picked choice can't be applied yet, or undefined when it can. */
function applyBlocked(choice: GroupChoice, group: WaitingGroup, recorded: Recorded): string | undefined {
  if (choice === 'mark-sent' && recorded === undefined) {
    return 'Looking for a recorded result'
  }

  return choiceBlocked(choice, group, recorded)
}

export function WaitingGroupPanel({
  client,
  group,
  runs,
  busy,
  onApply,
  perRun,
}: {
  client: RewindClient
  group: WaitingGroup
  /** Recorded runs, newest first, to find the result Mark all sent gives. */
  runs: RunRow[]
  busy: boolean
  onApply: (decision: GroupDecision) => void
  /** The group's runs, listed when someone chooses per run. */
  perRun: ReactNode
}) {
  const headingId = useId()
  const kind = WAITING_KINDS[group.kind]
  const [choice, setChoice] = useState<GroupChoice | null>(() => presetChoice(group))
  const recorded = useRecordedAnswer(client, kind.choices.includes('mark-sent') ? group.functionId : undefined, runs)
  const apply = choice ? GROUP_CHOICES[choice].apply : null
  const blocked = choice ? applyBlocked(choice, group, recorded) : undefined
  const count = group.runs.length

  const commit = () => {
    if (!choice || blocked) {
      return
    }

    const parsed = choice === 'mark-sent' && recorded ? parseTypedText(recorded.text) : undefined
    onApply({ group, choice, value: parsed?.ok ? parsed.value : undefined })
  }

  const button = apply ? (
    <Button variant={choice === 'skip' ? 'pill' : 'primary'} onClick={commit} disabled={busy || Boolean(blocked)}>
      {apply.button(count)}
    </Button>
  ) : null

  return (
    <section className="rw-decision rw-group" aria-labelledby={headingId} data-kind={group.kind}>
      <div className="rw-decision-head">
        <div className="rw-decision-copy">
          <h3 id={headingId}>
            {groupTitle(group)} · {count}
          </h3>
          <p>
            <code title={callUrl(group.functionId)}>{callName(group.functionId)}</code> · {kind.note}
          </p>
        </div>
        <span className="rw-chips">
          <EffectsChips effects={group.effects} none={EFFECTS_UNKNOWN} />
        </span>
      </div>
      <List role="radiogroup" aria-label="What to do with these runs" className="rw-choices">
        {kind.choices.map((option) => {
          const reason = choiceBlocked(option, group, recorded)
          const checked = option === choice
          const Mark = checked ? CircleDot : Circle
          return (
            <ListItem
              key={option}
              role="radio"
              aria-checked={checked}
              selected={checked}
              disabled={Boolean(reason) || busy}
              data-choice={option}
              leading={reason ? <Lock aria-hidden /> : <Mark aria-hidden />}
              label={GROUP_CHOICES[option].title}
              description={reason ?? DESCRIBE[option](group, recorded)}
              onClick={() => setChoice(option)}
            />
          )
        })}
      </List>
      {choice === 'per-run' ? perRun : null}
      {button ? (
        <div className="rw-actions">
          {blocked ? (
            <ButtonTip tip={blocked} disabled>
              {button}
            </ButtonTip>
          ) : (
            button
          )}
        </div>
      ) : null}
    </section>
  )
}

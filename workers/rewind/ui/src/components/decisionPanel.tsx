/**
 * What a person decides at a paused call. Every choice is listed; the ones the
 * call's effects rule out stay visible, disabled, with the reason. The panel
 * opens in the sequence right under the paused row, and in the recovery view.
 */
import { Button, KeyCombo, List, ListItem, StatusPanel, Switch } from '@iii-dev/console-ui'
import { Circle, CircleAlert, CircleDot, Lock } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import type { Choice, Fork, PausedNeed, PauseReason } from '../client/types'
import type { Template } from '../data/useAnswerTemplate'
import { blockedReason, CHOICE_ORDER, CHOICES, CONTINUE_LABEL, choiceDescription, choiceTitle, EFFECTS_UNKNOWN, type PausedLine, pauseReason } from '../model/choices'
import { type DecisionState, typedProblem, typedWarning } from '../model/decision'
import { compactJson } from '../model/format'
import { callName, callUrl } from '../model/requests'
import type { AnswerCheck } from '../model/schema'
import { type AnswerMode, AnswerInput } from './answerInput'
import { ButtonTip, EffectsChips } from './bits'

const TITLE: Record<PauseReason, (need: PausedNeed, mode: Fork['mode']) => ReactNode> = {
  stop: (need) => (
    <>
      Stop · <code title={callUrl(need.function_id)}>{callName(need.function_id)}</code>
    </>
  ),
  no_answer: (_need, mode) => (mode === 'debug' ? 'No recorded answer' : 'Needs your answer'),
  lost: () => 'Interrupted mid-call · the provider may have it',
}

function continueTip(problem: string | null, warning: string | null): ReactNode {
  if (problem) {
    return problem
  }

  return warning ? `Breaks schema · ${warning}` : <>Continue <KeyCombo binding="Mod+Enter" /></>
}

function continueLabel(busy: boolean, warning: string | null, label: string): string {
  if (busy) {
    return 'Running…'
  }

  return warning ? `${label} anyway` : label
}

export function DecisionPanel({
  need: paused,
  mode,
  state,
  onChange,
  onContinue,
  busy,
  error,
  template,
  showInput = true,
  line = 'fork',
  lostHere = false,
  auto = false,
  check,
}: {
  need: PausedNeed
  mode: Fork['mode']
  state: DecisionState
  onChange: (next: DecisionState) => void
  onContinue: () => void
  busy: boolean
  error: string | null
  template: Template
  showInput?: boolean
  line?: PausedLine
  /** In a recovery, whether this is the call the dead worker took with it. */
  lostHere?: boolean
  /** A fork with `auto` already runs read-only calls live, so it has no switch for them. */
  auto?: boolean
  /** The function's response schema, which makes the typed answer a form. */
  check?: AnswerCheck
}) {
  const headingId = useId()
  const need = { ...paused, reason: pauseReason(paused, lostHere) }
  const problem = typedProblem(state)
  const warning = typedWarning(state, check)
  const [answerMode, setAnswerMode] = useState<AnswerMode>('form')

  const pick = (choice: Choice) => {
    const typed = choice === 'typed' && !state.typed ? template.text : state.typed
    onChange({ ...state, choice, typed })
  }

  return (
    <div className="rw-decision" role="group" aria-labelledby={headingId}>
      <div className="rw-decision-head">
        <div className="rw-decision-copy">
          <h3 id={headingId}>{TITLE[need.reason](need, mode)}</h3>
          {showInput ? (
            <p className="rw-decision-input">
              Input <code>{compactJson(need.input, 140)}</code>
            </p>
          ) : null}
        </div>
        <span className="rw-chips">
          <EffectsChips effects={need.effects} none={mode === 'recover' ? EFFECTS_UNKNOWN : undefined} />
        </span>
      </div>
      <List role="radiogroup" aria-label="What the call returns" className="rw-choices">
        {CHOICE_ORDER.map((choice) => {
          const blocked = blockedReason(choice, need)
          const checked = choice === state.choice
          const Mark = checked ? CircleDot : Circle
          const shortcut = CHOICES[choice].shortcut
          return (
            <ListItem
              key={choice}
              role="radio"
              aria-checked={checked}
              selected={checked}
              disabled={Boolean(blocked)}
              data-choice={choice}
              leading={blocked ? <Lock aria-hidden /> : <Mark aria-hidden />}
              label={choiceTitle(choice, mode, line)}
              description={blocked ?? choiceDescription(choice, need, mode, line)}
              title={shortcut && !blocked ? `${choiceTitle(choice, mode, line)} (${shortcut.replace('Alt+', 'Option ')})` : undefined}
              onClick={() => pick(choice)}
            />
          )
        })}
      </List>
      {state.choice === 'typed' ? (
        <div className="rw-typed">
          <AnswerInput
            title="Answer"
            actions={template.from ? <span className="rw-hint">From {template.from}</span> : null}
            text={state.typed}
            onChange={(typed) => onChange({ ...state, typed })}
            check={check}
            mode={answerMode}
            onMode={setAnswerMode}
            label={`What ${callName(need.function_id)} returns, as JSON`}
          />
          {problem && (!check || answerMode === 'json') ? (
            <p className="rw-verdict" data-tone="alert" role="alert">
              <CircleAlert aria-hidden />
              <span>{problem}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      {mode === 'debug' && !auto ? (
        <label className="rw-switch-row">
          <Switch checked={state.autoRead} onChange={(event) => onChange({ ...state, autoRead: event.target.checked })} />
          <span>Auto-run read-only calls</span>
        </label>
      ) : null}
      {error ? <StatusPanel variant="alert" role="alert" headline="Failed to continue" detail={error} /> : null}
      <div className="rw-actions">
        <ButtonTip tip={continueTip(problem, warning)} disabled={busy || problem !== null}>
          <Button variant={state.choice === 'stop' ? 'pill' : 'primary'} onClick={onContinue} disabled={busy || problem !== null}>
            {continueLabel(busy, warning, CONTINUE_LABEL[mode][state.choice].replace('fork', line))}
          </Button>
        </ButtonTip>
      </div>
    </div>
  )
}

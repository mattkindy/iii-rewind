/**
 * Small pieces several views share: how a worker, an answer's source, a
 * function's effects and a line's ending look on screen.
 */
import { Button, type ButtonProps, Chip, type ChipTone, Eyebrow, IconButton, JsonHighlight, StatusDot, Tooltip } from '@iii-dev/console-ui'
import { useCopyFlash } from '@iii-dev/console-ui/hooks'
import { Check, Copy, LifeBuoy } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AnswerSource } from '../client/types'
import type { Lane } from '../model/lanes'
import type { LineOutcome } from '../model/lines'
import { RECOVER_LINE } from '../model/lost'
import { outcomeLook } from '../model/outcomes'
import { SOURCES } from '../model/sources'

export function WorkerGlyph({ lane }: { lane: Lane }) {
  const Icon = lane.icon
  return (
    <span className="rw-glyph" data-tone={lane.tone} aria-hidden>
      <Icon />
    </span>
  )
}

export function SourceChip({ source }: { source: AnswerSource }) {
  const info = SOURCES[source]
  return (
    <Chip tone={info.tone} className="rw-chip">
      {info.label}
    </Chip>
  )
}

// Only the effect that decides what a person may do gets a status tone.
const EFFECT_TONE: Record<string, ChipTone> = { irreversible: 'warning' }

/** `none` is the badge for a function that declares no effects. */
export function EffectsChips({ effects, none = 'No effects declared' }: { effects: string[]; none?: string }) {
  if (effects.length === 0) {
    return (
      <Chip tone="warning" className="rw-chip">
        {none}
      </Chip>
    )
  }

  return (
    <>
      {effects.map((effect) => (
        <Chip key={effect} tone={EFFECT_TONE[effect] ?? 'neutral'} className="rw-chip">
          {effect}
        </Chip>
      ))}
    </>
  )
}

export function OutcomeChip({ outcome }: { outcome: LineOutcome }) {
  const look = outcomeLook(outcome)
  return (
    <Chip tone={look.tone} className="rw-chip">
      {look.short}
    </Chip>
  )
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const { state, copy } = useCopyFlash(text)
  return (
    <IconButton label={state === 'copied' ? 'Copied' : label} onClick={copy}>
      {state === 'copied' ? <Check aria-hidden /> : <Copy aria-hidden />}
    </IconButton>
  )
}

export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rw-section-head">
      <Eyebrow>{title}</Eyebrow>
      {children ? <span className="rw-section-actions">{children}</span> : null}
    </div>
  )
}

export function JsonBlock({ title, value, text, actions }: { title: string; value?: unknown; text?: string; actions?: ReactNode }) {
  const code = text ?? JSON.stringify(value, null, 2) ?? 'null'
  return (
    <section className="rw-block">
      <SectionHead title={title}>
        {actions}
        <CopyButton text={code} label={`Copy ${title.toLowerCase()}`} />
      </SectionHead>
      <div className="rw-code">
        <JsonHighlight code={code} wrap />
      </div>
    </section>
  )
}

/** JSON text that stops parsing, marked where it stops. */
export function CutText({ text, position }: { text: string; position?: number }) {
  const at = Math.min(position ?? text.length, text.length)
  return (
    <pre className="rw-embedded">
      <span>{text.slice(0, at)}</span>
      {at < text.length ? <mark className="rw-embedded-rest">{text.slice(at)}</mark> : null}
      <span className="rw-embedded-stop">{at < text.length ? 'parse error' : 'cut off'}</span>
    </pre>
  )
}

/**
 * A tooltip around a button that may be disabled. A disabled button gets no
 * pointer events, so the tooltip hangs on a wrapper that does, and the wrapper
 * takes focus in the button's place while it is disabled, unless `focusable`
 * is false.
 */
export function ButtonTip({ tip, disabled, focusable = true, children }: { tip: ReactNode; disabled: boolean; focusable?: boolean; children: ReactNode }) {
  return (
    <Tooltip label={tip}>
      <span className="rw-tip-target" tabIndex={disabled && focusable ? 0 : undefined}>
        {children}
      </span>
    </Tooltip>
  )
}

/** A Recover run or Recover all button, with what a recovery does in its tooltip unless that line is already beside it. */
export function RecoverButton({ children, lineShown = false, ...props }: ButtonProps & { lineShown?: boolean }) {
  const button = (
    <Button {...props}>
      <LifeBuoy aria-hidden />
      {children}
    </Button>
  )
  if (lineShown) {
    return button
  }

  return (
    <ButtonTip tip={RECOVER_LINE} disabled={Boolean(props.disabled)}>
      {button}
    </ButtonTip>
  )
}

/** Whether updates arrive as they happen. Without the binding the page reads again when the tab comes back into view. */
export function LiveIndicator({ live }: { live: boolean }) {
  return (
    <span className="rw-live" title={live ? 'Updates as they happen' : 'Updates when you return to the tab'}>
      <StatusDot tone={live ? 'accent' : 'ink'} pulse={live} />
      {live ? 'Live' : 'Not live'}
    </span>
  )
}

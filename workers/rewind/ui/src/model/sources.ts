/**
 * How each answer source reads on screen: the chip on a call's row, and the
 * heading over the answer when the call is open. A filled answer came from
 * another run and nothing was sent, so it gets the one warning tone.
 */
import type { ChipTone } from '@iii-dev/console-ui'
import type { AnswerSource } from '../client/types'

export type SourceLook = { label: string; tone: ChipTone; answerTitle: string; responseTitle: string }

export const SOURCES: Record<AnswerSource, SourceLook> = {
  recorded: { label: 'Recorded', tone: 'neutral', answerTitle: 'Recorded answer', responseTitle: 'Recorded response' },
  edited: { label: 'Edited', tone: 'accent', answerTitle: 'Edited answer', responseTitle: 'Edited response' },
  typed: { label: 'Typed', tone: 'accent', answerTitle: 'Typed answer', responseTitle: 'Typed response' },
  live: { label: 'Live', tone: 'neutral', answerTitle: 'Live answer', responseTitle: 'Live response' },
  filled: { label: 'Filled', tone: 'warning', answerTitle: 'Filled answer', responseTitle: 'Filled response' },
  injected: { label: 'Injected error', tone: 'danger', answerTitle: 'Injected error', responseTitle: 'Injected error' },
  copy: { label: 'Ran in copy', tone: 'neutral', answerTitle: 'Answer from the copy', responseTitle: 'Response from the copy' },
}

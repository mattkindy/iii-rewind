/**
 * What the walk scripts need to fill an answer's form the way a person would:
 * the arguments the model meant to send before bug 1 cut them off, and the
 * fields "Close cut-off JSON" marks as lost.
 */
import type { Locator } from 'playwright-core'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export type FindSlotArgs = { attendee: string; day: string; duration: number }

/** The arguments the model meant to send, worked out from the request and the recorded date. */
export function intendedArgs(request: string, today: string): FindSlotArgs {
  const name = /\bwith ([A-Za-z]+)/.exec(request)?.[1] ?? ''
  const minutes = Number(/(\d+)\s*minutes?/i.exec(request)?.[1] ?? 30)
  const weekday = WEEKDAYS.findIndex((day) => request.includes(day))
  const date = new Date(`${today}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + ((weekday - date.getUTCDay() + 6) % 7) + 1)
  return { attendee: `${name.toLowerCase()}@example.com`, day: date.toISOString().slice(0, 10), duration: minutes }
}

export type LostField = { name: keyof FindSlotArgs; input: Locator }

/**
 * The fields under `form` that have the Cut off mark, with their inputs. Filling
 * a field takes its mark away, so each input is found by its field's name.
 */
export async function cutOffFields(form: Locator): Promise<LostField[]> {
  const page = form.page()
  const names = await form.locator('.rw-field').filter({ has: page.locator('.rw-chip', { hasText: 'Cut off' }) }).locator('.rw-field-name').allInnerTexts()
  return names.map((name) => ({
    name: name as keyof FindSlotArgs,
    input: form.locator('.rw-field', { has: page.locator('.rw-field-name', { hasText: new RegExp(`^${name}$`) }) }).locator('input').first(),
  }))
}

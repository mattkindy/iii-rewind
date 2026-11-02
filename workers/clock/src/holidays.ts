/**
 * US federal holidays, worked out from their rules, for the holiday route of
 * the providers server. The agent fetches them outside iii, so a replay has to
 * get them from Rewind's capture of that request.
 */

type Holiday = { date: string; name: string }

const DAY_MS = 86_400_000

function iso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)
}

/** The nth weekday of a month (1 for the first), or the last one when n is -1. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n < 0) {
    const last = new Date(Date.UTC(year, month, 0))
    const back = (last.getUTCDay() - weekday + 7) % 7
    return iso(year, month, last.getUTCDate() - back)
  }

  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  return iso(year, month, 1 + ((weekday - first + 7) % 7) + 7 * (n - 1))
}

function holidaysIn(year: number): Holiday[] {
  return [
    { date: iso(year, 1, 1), name: "New Year's Day" },
    { date: nthWeekday(year, 1, 1, 3), name: 'Martin Luther King Jr. Day' },
    { date: nthWeekday(year, 2, 1, 3), name: "Washington's Birthday" },
    { date: nthWeekday(year, 5, 1, -1), name: 'Memorial Day' },
    { date: iso(year, 6, 19), name: 'Juneteenth' },
    { date: iso(year, 7, 4), name: 'Independence Day' },
    { date: nthWeekday(year, 9, 1, 1), name: 'Labor Day' },
    { date: nthWeekday(year, 10, 1, 2), name: 'Columbus Day' },
    { date: iso(year, 11, 11), name: 'Veterans Day' },
    { date: nthWeekday(year, 11, 4, 4), name: 'Thanksgiving Day' },
    { date: iso(year, 12, 25), name: 'Christmas Day' },
  ]
}

export function holidaysBetween(from: string, weeks: number) {
  const start = new Date(`${from}T00:00:00Z`)
  const to = new Date(start.getTime() + (weeks * 7 - 1) * DAY_MS).toISOString().slice(0, 10)
  const years = [start.getUTCFullYear(), new Date(`${to}T00:00:00Z`).getUTCFullYear()]
  const holidays = [...new Set(years)]
    .flatMap(holidaysIn)
    .filter((holiday) => holiday.date >= from && holiday.date <= to)
  return { from, to, holidays }
}

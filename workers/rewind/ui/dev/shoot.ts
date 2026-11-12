/**
 * Walks the flows in docs/jobs.md through Rewind's page in the running console
 * with headless Chrome and saves a numbered screenshot per step, one folder per
 * flow, theme and width, such as `mock/a-dark/01-landing.png`. A walk fails on
 * any uncaught error, any console.error, and any render error on screen.
 *
 * Against the mock it walks flows A to E, D once more with a send whose effects
 * nobody declared, a video of D's progress as each run lands, a replay with
 * tools copied, the schema checks, the player and the loading, empty and error
 * states, resetting the mock before each flow. With TARGET=core it walks A, B,
 * D, the copied replay, the schema checks and the player on whatever
 * traffic::burst recorded, with a video of B, and D with unknown effects if
 * email::send has none.
 *
 * Run from workers/rewind/ui with the engine, ADE and Rewind (or the mock) up:
 *   III_URL=ws://127.0.0.1:49634 CONSOLE_URL=http://127.0.0.1:3633 \
 *     SHOTS=/some/folder npx tsx dev/shoot.ts
 * FLOWS=a,b and THEMES=dark pick a subset.
 */
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerWorker } from 'iii-sdk'
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from 'playwright-core'
import { cutOffFields, intendedArgs } from './formWalk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49634'
const CONSOLE_URL = process.env.CONSOLE_URL ?? 'http://127.0.0.1:3633'
const AGAINST_CORE = process.env.TARGET === 'core'
const SHOTS = path.join(process.env.SHOTS ?? path.join(os.tmpdir(), 'rewind-shots'), AGAINST_CORE ? 'core' : 'mock')
const HEIGHT = 900
const WIDE = 1440
const NARROW = 560
const RUN_WAIT_MS = 120_000

type Theme = 'dark' | 'light'
type Shooter = (name: string) => Promise<void>
/** `themes` limits a flow to some themes; `video` records it; `coreOnly` needs what only the core captures. */
type Flow = { id: string; core: boolean; walk: (page: Page, shot: Shooter) => Promise<void>; themes?: Theme[]; video?: boolean; coreOnly?: boolean }

const iii = registerWorker(ENGINE_URL, { workerName: 'rewind-shoot' })
const say = (text: string) => process.stdout.write(`${text}\n`)

// The core has no dev controls; against it the script only drives the page.
async function configure(payload: Record<string, unknown>): Promise<void> {
  if (!AGAINST_CORE) {
    await iii.call({ function_id: 'rewind-dev::configure', payload, timeoutMs: 10_000 })
  }
}

async function burst(count: number): Promise<void> {
  if (!AGAINST_CORE) {
    await iii.call({ function_id: 'traffic::burst', payload: { count, interval_ms: 10 }, timeoutMs: 60_000 })
  }
}

function scope(page: Page): Locator {
  return page.locator('[data-iii-ui="rewind"]').first()
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.waitForTimeout(ms)
}

/** Waits until no fork, replay or recovery is running. */
async function idle(page: Page): Promise<void> {
  await scope(page).locator('.rw-progress-detail').waitFor({ state: 'detached', timeout: RUN_WAIT_MS })
  await settle(page, 500)
}

async function openLanding(page: Page): Promise<void> {
  await page.goto(`${CONSOLE_URL}/#/worker/rewind/rewind`)
  await scope(page).locator('.rw-landing-row').first().waitFor({ timeout: 30_000 })
  await settle(page, 600)
}

async function openFailureGroup(page: Page, label: RegExp): Promise<void> {
  await scope(page).locator('.rw-landing-row[data-group]', { hasText: label }).first().click()
  await scope(page).locator('.rw-seq-item[data-open]').first().waitFor({ timeout: 30_000 })
  await settle(page)
}

/** Answers paused calls with their default choice until the line finishes, shooting each pause. */
async function answerPauses(page: Page, shot: Shooter, limit: number): Promise<void> {
  const root = scope(page)
  for (let index = 0; index < limit; index++) {
    if ((await root.locator('.rw-decision').count()) === 0) {
      return
    }

    await root.locator('.rw-decision').first().scrollIntoViewIfNeeded()
    const continueButton = root.locator('.rw-decision .rw-actions button').first()
    if (await continueButton.isDisabled()) {
      await root.locator('.rw-decision [data-choice="inject"]').click()
    }

    await shot(`paused-${index + 1}`)
    await continueButton.click()
    await idle(page)
  }
}

// ── flows ───────────────────────────────────────────────────────────────

/** A: from a failure to its cause, then a replay that reproduces it. */
async function flowA(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  await openLanding(page)
  await shot('landing')
  await openFailureGroup(page, /SyntaxError/)
  await shot('suspect-call-open')
  await root.locator('.rw-seq-item[data-open] .rw-collapse-trigger').first().click()
  await settle(page, 500)
  await root.locator('.rw-seq-item[data-open] .rw-collapse-trigger').first().scrollIntoViewIfNeeded()
  await shot('details-open')
  await root.locator('.rw-seq-item[data-open] .rw-collapse-trigger').first().click()
  await root.locator('.rw-seq-item[data-open] button', { hasText: /^Replay/ }).first().click()
  await settle(page, 250)
  await shot('replaying')
  await idle(page)
  await root.getByText(/^(Reproduced|Replay (returned|threw|diverged|paused|cut off)) /).first().waitFor({ timeout: RUN_WAIT_MS })
  await shot('reproduced')
  await root.getByRole('button', { name: 'Show workers' }).click()
  await settle(page, 500)
  await shot('workers-as-lanes')
  await root.getByRole('button', { name: 'Hide workers' }).click()
}

/** The day the run was recorded, from its clock::now answer in the first row. */
async function recordedDay(page: Page): Promise<string> {
  const first = await scope(page).locator('.rw-seq-item').first().innerText()
  return /\d{4}-\d{2}-\d{2}/.exec(first)?.[0] ?? new Date().toISOString().slice(0, 10)
}

/**
 * Applies the quick fix in the open editor, which parses the cut-off
 * arguments into the form and marks the fields the cut took, then types those
 * back in from the request, as a person would. Says whether any were lost.
 */
async function fixCutOff(page: Page, shot: Shooter): Promise<boolean> {
  const root = scope(page)
  await root.locator('.rw-editor button', { hasText: /Close cut-off|Fix/ }).first().click()
  await settle(page)
  const lost = await cutOffFields(root.locator('.rw-editor'))
  if (lost.length === 0) {
    return false
  }

  await shot('cut-off-fields-marked')
  const args = intendedArgs(await root.locator('.rw-mast-title').innerText(), await recordedDay(page))
  for (const field of lost) {
    await field.input.fill(String(args[field.name]))
  }

  await settle(page, 400)
  return true
}

/** Opens the editor on the suspect answer, a form of the model's tool call, and fixes its cut-off arguments. */
async function editWithQuickFix(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  await root.locator('.rw-seq-item[data-open] button', { hasText: 'Edit answer' }).click()
  await root.locator('.rw-editor .rw-form').waitFor()
  await shot('edit-answer-as-a-form')
  await fixCutOff(page, shot)
}

function callRow(page: Page, name: string): Locator {
  return scope(page).locator('.rw-seq-item', { has: page.locator('.rw-seq-name', { hasText: new RegExp(`^${name}$`) }) })
}

/** Clicks the gutter of the first row calling `name`, which toggles a stop on that function. */
async function toggleStopInGutter(page: Page, name: string): Promise<void> {
  await callRow(page, name).first().locator('.rw-seq-gutter').click()
  await settle(page, 250)
  await idle(page)
}

async function openStopsMenu(page: Page): Promise<Locator> {
  await scope(page).getByRole('button', { name: /^Stops/ }).click()
  const menu = page.getByRole('menu')
  await menu.waitFor()
  await settle(page, 300)
  return menu
}

/** Closes an open menu, then moves focus off its button, so the button's tooltip stays out of the next still. */
async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(0, 0)
  await settle(page, 300)
}

async function scrollToTop(page: Page): Promise<void> {
  await scope(page).locator('.rw-scroll').evaluate((el) => el.scrollTo({ top: 0 }))
}

/**
 * B: edit the suspect answer and fork. The fork runs to its end on its own,
 * then the walk opens the call it filled, sets a stop there, answers at the
 * stop, takes the stop away again, compares and keeps it as a test.
 */
async function flowB(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  await openLanding(page)
  await openFailureGroup(page, /SyntaxError/)
  await editWithQuickFix(page, shot)
  await shot('edited-with-diff')
  await root.locator('.rw-editor button', { hasText: /^Fork$/ }).click()
  await settle(page, 250)
  await shot('forking')
  await idle(page)
  await root.locator('.rw-path-line').waitFor({ timeout: RUN_WAIT_MS })
  await shot('fork-lands-on-its-ending')
  await scrollToTop(page)
  await shot('fork-result-with-its-path')

  // Against the core, a booked fork may have filled nothing if a send ran live, so the walk opens whatever it filled.
  const filled = root.locator('.rw-seq-row', { has: page.locator('.rw-chip', { hasText: /^Filled$/ }) }).first()
  if ((await filled.count()) > 0) {
    await filled.click()
    await root.locator('.rw-seq-item[data-open] button', { hasText: 'Change answer' }).waitFor()
    await settle(page)
    await shot('filled-call-open-with-change-answer')
    await root.locator('.rw-seq-item[data-open] button', { hasText: 'Change answer' }).click()
    await root.locator('.rw-editor').waitFor()
    await shot('change-answer-editor')
    await root.locator('.rw-editor button', { hasText: /^Cancel$/ }).click()
    await settle(page)
  }

  await openStopsMenu(page)
  await shot('stops-menu')
  await closeMenu(page)

  await toggleStopInGutter(page, 'email::send')
  await root.locator('.rw-decision').first().waitFor({ timeout: RUN_WAIT_MS })
  await scrollToTop(page)
  await shot('stop-set-in-the-gutter')
  await root.locator('.rw-decision').first().scrollIntoViewIfNeeded()
  await shot('paused-at-the-stop')
  await answerPauses(page, async () => undefined, 4)
  await scrollToTop(page)
  await shot('typed-at-the-stop-and-booked')

  const menu = await openStopsMenu(page)
  await shot('stops-menu-with-a-stop')
  await menu.getByRole('menuitemcheckbox', { name: /email::send/ }).click()
  await closeMenu(page)
  await idle(page)
  await scrollToTop(page)
  await shot('stop-removed-typed-answer-kept')

  await root.locator('.rw-switcher').getByText('Compare', { exact: true }).click()
  await root.locator('.rw-compare').waitFor()
  await settle(page)
  await shot('compare')
  const save = root.locator('.rw-compare button', { hasText: 'Save as test' })
  if ((await save.count()) > 0) {
    await save.click()
    await root.locator('.rw-test-head').waitFor({ timeout: 30_000 })
    await root.locator('.rw-compare button', { hasText: 'Run test' }).click()
    await root.locator('.rw-test-head', { hasText: /Passed|Failed/ }).waitFor({ timeout: RUN_WAIT_MS })
    await root.locator('.rw-test-head').scrollIntoViewIfNeeded()
    await shot('test-saved-and-run')
  }
}

/**
 * A saved test that diverges: fork a crash into a booking, save the fork as a
 * test and run it, then change the agent's code so its first model call sends
 * another date, and run the test again. Mock only, since it changes the code.
 */
async function flowSavedTest(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  await openLanding(page)
  await openFailureGroup(page, /SyntaxError/)
  await editWithQuickFix(page, async () => undefined)
  await root.locator('.rw-editor button', { hasText: /^Fork$/ }).click()
  await idle(page)
  await root.locator('.rw-path-line').waitFor({ timeout: RUN_WAIT_MS })
  await root.locator('.rw-run-notes button', { hasText: 'Save as test' }).click()
  await root.locator('.rw-test-head').waitFor({ timeout: 30_000 })
  await root.locator('.rw-test button', { hasText: 'Run test' }).click()
  await root.locator('.rw-test-head', { hasText: 'Passed' }).waitFor({ timeout: RUN_WAIT_MS })
  await scrollToTop(page)
  await shot('test-passes')
  await configure({ code_change: 'weekday' })
  await root.locator('.rw-test button', { hasText: 'Run again' }).click()
  await root.locator('.rw-test-head', { hasText: 'Failed' }).waitFor({ timeout: RUN_WAIT_MS })
  await page.mouse.move(0, 0)
  await scrollToTop(page)
  await shot('test-diverged')
}

/** C: the code changed; replay with it, check every run like this in two passes, open one that still fails. */
async function flowC(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  await burst(20)
  await configure({ code_change: true })
  await openLanding(page)
  await shot('landing-code-changed')
  await openFailureGroup(page, /SyntaxError/)
  await shot('run-code-changed')
  await root.locator('.rw-seq-item[data-open] button', { hasText: 'Replay with current code' }).click()
  await idle(page)
  await shot('replay-takes-new-path')
  await root.locator('.rw-run-notes button', { hasText: 'Open replay' }).click()
  await settle(page)
  await answerPauses(page, shot, 8)
  await root.locator('.rw-run-notes').first().scrollIntoViewIfNeeded()
  await shot('replay-with-current-code-books')
  const save = root.locator('.rw-run-notes button', { hasText: 'Save as test' })
  if ((await save.count()) > 0) {
    await save.click()
    await root.locator('.rw-test-head').waitFor({ timeout: 30_000 })
    await shot('saved-as-test')
  }

  await root.getByRole('button', { name: 'More for this run' }).click()
  await page.getByRole('menuitem', { name: 'Check similar runs' }).click()
  await settle(page, 300)
  await shot('checking')
  await root.locator('button', { hasText: 'Run new calls live' }).waitFor({ timeout: RUN_WAIT_MS })
  await shot('every-run-takes-a-new-path')
  await root.locator('button', { hasText: 'Run new calls live' }).click()
  await settle(page, 600)
  await shot('checking-live')
  await root.getByText(/\d+\/\d+ fixed/).first().waitFor({ timeout: RUN_WAIT_MS })
  await settle(page)
  await shot('live-results')
  await root.locator('.rw-landing-row', { hasText: /Fails/ }).first().click()
  await root.locator('.rw-seq-item[data-open]').first().waitFor({ timeout: 30_000 })
  await settle(page)
  await shot('a-run-that-still-fails')
}

/** Opens the newest incident and recovers all of it, shooting the page before and while it runs. */
async function recoverIncident(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  await openLanding(page)
  await root.locator('.rw-landing-row[data-incident]').first().click()
  await root.locator('.rw-level-head').waitFor()
  await shot('interrupted')
  const recoverAll = root.locator('button', { hasText: /^Recover all/ })
  if ((await recoverAll.count()) === 0) {
    return
  }

  await recoverAll.click()
  await page.mouse.move(0, 0)
  await settle(page, 300)
  await shot('recovering')
  // Partway is once a run or two have landed, so the bar and the list show runs in each state.
  const partway = root.getByText(/^Recovering [3-9]\d*\//).first()
  if (await partway.waitFor({ timeout: RUN_WAIT_MS }).then(() => true, () => false)) {
    await settle(page, 600)
    await shot('recovering-partway')
  }

  await recoverAll.waitFor({ state: 'detached', timeout: RUN_WAIT_MS * 3 })
  await idle(page)
}

function waitingGroup(page: Page, kind: 'lost' | 'unsent'): Locator {
  return scope(page).locator(`.rw-group[data-kind="${kind}"]`).first()
}

/** Applies the choice a group starts on, shooting the progress partway through when there is time to. */
async function applyGroup(page: Page, shot: Shooter, kind: 'lost' | 'unsent', doing: string): Promise<void> {
  const group = waitingGroup(page, kind)
  await group.locator('.rw-actions button').click()
  // Against the core each run takes well under a second, so the second run's progress may come and go unseen.
  const partway = scope(page).getByText(new RegExp(`^${doing} [2-9]\\d*/`)).first()
  if (await partway.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
    await settle(page, 600)
    await shot(`${kind}-partway`)
  }

  await idle(page)
}

/**
 * D: runs interrupted when a worker stopped, recovered in one step. The runs left
 * waiting get one decision per group: the sends interrupted mid-call are marked sent,
 * after a look at Resend all's confirmation and the runs one by one. The sends
 * that never went out are sent, after a look at one that tools was already gone for.
 */
async function flowD(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  await recoverIncident(page, shot)
  if ((await root.locator('.rw-group').count()) === 0) {
    return
  }

  await shot('one-decision-per-group')
  const lost = waitingGroup(page, 'lost')
  if ((await lost.count()) > 0) {
    await lost.locator('[data-choice="resend"]').click()
    await lost.locator('.rw-actions button').click()
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).first()
    await dialog.waitFor()
    await settle(page, 300)
    await shot('resend-all-asks-first')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await lost.locator('[data-choice="per-run"]').click()
    await page.mouse.move(0, 0)
    await shot('interrupted-sends-one-by-one')
    await lost.locator('[data-choice="mark-sent"]').click()
    // The mock fails the first run, so the result lists it with a retry. The core has no such control.
    await configure({ answer_failures: 1 })
    await applyGroup(page, shot, 'lost', 'Marking sent')
    await page.mouse.move(0, 0)
    const retry = root.locator('button', { hasText: /^Retry \d+/ }).first()
    if ((await retry.count()) > 0) {
      await shot('interrupted-one-failed-with-retry')
      await retry.click()
      await idle(page)
      await page.mouse.move(0, 0)
    }

    await shot('interrupted-marked-sent')
  }

  // A recovery pauses at every call its worker died in, so each function cut off mid-call has a group.
  for (let more = 0; more < 3 && (await waitingGroup(page, 'lost').count()) > 0; more++) {
    await applyGroup(page, async () => undefined, 'lost', 'Marking sent')
  }

  if ((await waitingGroup(page, 'unsent').count()) > 0) {
    await openNotFoundSend(page, shot)
    await applyGroup(page, shot, 'unsent', 'Sending')
  }

  await scrollToTop(page)
  await page.mouse.move(0, 0)
  await shot('every-run-recovered')
}

/** D's recovery and its first group decision, for a video of the progress as each run lands. */
async function flowDMotion(page: Page, shot: Shooter): Promise<void> {
  await recoverIncident(page, shot)
  if ((await waitingGroup(page, 'lost').count()) > 0) {
    await page.mouse.move(0, 0)
    await applyGroup(page, shot, 'lost', 'Marking sent')
    await page.mouse.move(0, 0)
    await shot('interrupted-marked-sent')
  }
}

type LostRow = { run_id: string; mid_call?: boolean; recovery: { outcome: { state: string } } | null }

/** Lost runs whose call failed with function_not_found, because its worker was already gone. */
async function notFoundRuns(): Promise<LostRow[]> {
  const lost = (await iii.call({ function_id: 'rewind::lost', payload: {}, timeoutMs: 30_000 })) as LostRow[]
  return lost.filter((run) => run.mid_call === false)
}

/** Opens a send that was not found from Not sent yet, shoots it, and goes back to the groups. */
async function openNotFoundSend(page: Page, shot: Shooter): Promise<void> {
  const runId = (await notFoundRuns()).find((run) => run.recovery?.outcome.state === 'paused')?.run_id
  if (!runId) {
    say('  no waiting run has a send that failed with function_not_found')
    return
  }

  const root = scope(page)
  const unsent = waitingGroup(page, 'unsent')
  await unsent.locator('[data-choice="per-run"]').click()
  await unsent.locator('.rw-landing-row', { hasText: runId.slice(0, 8) }).click()
  await root.locator('.rw-recovery').waitFor()
  await root.locator('.rw-decision').first().waitFor({ timeout: RUN_WAIT_MS })
  await page.mouse.move(0, 0)
  await shot('send-not-found-never-went-out')
  await root.locator('.rw-decision').first().scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await shot('send-not-found-decision')
  await root.getByRole('button', { name: 'Back' }).click()
  await root.locator('.rw-level-head').waitFor()
  await waitingGroup(page, 'unsent').scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await shot('not-sent-yet-starts-on-send-all')
  await waitingGroup(page, 'unsent').locator('[data-choice="send"]').click()
}

/**
 * D again, with email::send declaring no effects: the groups have the
 * Effects unknown badge and start with nothing picked, and one waiting run
 * starts on Skip run. Against the core it needs a tools worker that registers
 * email::send with `effects: []`, and it stops early on a stack without one.
 */
async function flowUnknownEffects(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  await configure({ undeclared: ['email::send'] })
  await recoverIncident(page, async () => undefined)
  await root.locator('.rw-group').first().waitFor({ timeout: RUN_WAIT_MS })
  if ((await root.locator('.rw-group .rw-chip', { hasText: 'Effects unknown' }).count()) === 0) {
    say('  email::send declares effects on this stack, so no group has unknown effects')
    return
  }

  await page.mouse.move(0, 0)
  await shot('groups-with-effects-unknown')
  const unsent = waitingGroup(page, 'unsent')
  if ((await unsent.count()) > 0) {
    await unsent.locator('[data-choice="send"]').click()
    await page.mouse.move(0, 0)
    await shot('send-all-may-repeat-a-side-effect')
  }

  const lost = (await waitingGroup(page, 'lost').count()) > 0 ? waitingGroup(page, 'lost') : unsent
  await lost.locator('[data-choice="per-run"]').click()
  await lost.locator('.rw-landing-row').first().click()
  await root.locator('.rw-recovery').waitFor()
  await root.locator('.rw-decision').first().waitFor({ timeout: RUN_WAIT_MS })
  await root.locator('.rw-decision').first().scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await shot('interrupted-send-with-effects-unknown')
}

/** E: check recent runs against changed code, then open a changed run. */
async function flowE(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  await burst(12)
  await configure({ code_change: true })
  await openLanding(page)
  await root.locator('button', { hasText: /^Check (recent runs|against current code)/ }).first().click()
  await settle(page, 300)
  await shot('checking-recent-runs')
  await root.locator('button', { hasText: 'Run new calls live' }).waitFor({ timeout: RUN_WAIT_MS })
  await settle(page)
  await shot('summary')
  const showRows = root.locator('button', { hasText: /^Show / })
  for (const button of await showRows.all()) {
    await button.click()
    await settle(page)
  }

  await shot('every-run')
  await root.locator('.rw-landing-row', { hasText: 'Diverges' }).first().click()
  await idle(page)
  await root.locator('.rw-decision').first().waitFor({ timeout: RUN_WAIT_MS })
  await settle(page)
  await shot('changed-run-opens-at-the-new-call')
}

// ── schemas and Show in Traces ──────────────────────────────────────────

/** Hovers `target` and waits for its tooltip to open. */
async function hoverTip(page: Page, target: Locator): Promise<void> {
  await target.hover()
  await page.getByRole('tooltip').first().waitFor({ timeout: 5_000 }).catch(() => undefined)
  await settle(page, 300)
}

/**
 * The checks the functions' schemas allow: the Schema chip on the call a
 * string duration broke, that duration as an error in the form, Show in
 * Traces and the function name as a link, and a cut-off answer whose fix
 * loses fields, from whichever SyntaxError run loses some.
 */
async function flowSchema(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  await openLanding(page)
  if ((await root.locator('.rw-landing-row[data-group]', { hasText: /TypeError in calendar::find-slot/ }).count()) > 0) {
    await openFailureGroup(page, /TypeError in calendar::find-slot/)
    await hoverTip(page, root.locator('.rw-chip[data-schema]').first())
    await shot('schema-chip-on-find-slot')
    const findSlot = callRow(page, 'calendar::find-slot').first()
    await findSlot.locator('.rw-seq-row').hover()
    await hoverTip(page, findSlot.locator('.rw-seq-trace button'))
    await shot('show-in-traces-on-hover')
    await hoverTip(page, findSlot.locator('.rw-seq-name'))
    await shot('function-name-as-a-link')
    await root.locator('.rw-seq-item[data-open] button', { hasText: 'Edit answer' }).click()
    await root.locator('.rw-editor .rw-form').waitFor()
    await hoverTip(page, root.locator('.rw-editor .rw-actions .rw-tip-target').first())
    await shot('string-duration-inline-error')
    await root.locator('.rw-editor button', { hasText: /^Cancel$/ }).click()
    await backToLanding(page)
  }

  await openFailureGroup(page, /SyntaxError/)
  for (let index = 0; index < 8; index++) {
    await root.locator('.rw-seq-item[data-open] button', { hasText: 'Edit answer' }).click()
    await root.locator('.rw-editor .rw-form').waitFor()
    if (await fixCutOff(page, shot)) {
      await shot('cut-off-fields-filled')
      return
    }

    await root.locator('.rw-editor button', { hasText: /^Cancel$/ }).click()
    const next = root.getByRole('button', { name: 'Next run in this group' })
    if (await next.isDisabled()) {
      return
    }

    await next.click()
    await root.locator('.rw-seq-item[data-open]').first().waitFor()
    await settle(page)
  }
}

// ── the player ──────────────────────────────────────────────────────────

async function openPlayer(page: Page): Promise<void> {
  await scope(page).getByRole('button', { name: /^Play back/ }).click()
  await scope(page).locator('.rw-player').waitFor()
  await settle(page, 200)
}

async function setPlaying(page: Page, playing: boolean): Promise<void> {
  const button = scope(page).locator('.rw-play')
  if ((await button.getAttribute('aria-label')) !== (playing ? 'Pause' : 'Play')) {
    await button.click()
  }
}

/** Moves the playhead by clicking the scrubber at a share of the run. */
async function scrubTo(page: Page, share: number): Promise<void> {
  const box = await scope(page).locator('.rw-scrub-rail').boundingBox()
  if (!box) {
    throw new Error('the scrubber is not on screen')
  }

  await page.mouse.click(box.x + box.width * Math.min(1, Math.max(0, share)), box.y + box.height / 2)
}

/** The share of the run where a row's outline starts and ends, read from its style. */
async function rowShare(page: Page, row: Locator): Promise<{ from: number; to: number }> {
  const style = await row.locator('.rw-wf-ghost').evaluate((el) => ({ left: (el as HTMLElement).style.left, width: (el as HTMLElement).style.width }))
  const left = Number.parseFloat(style.left) / 100
  const width = Number.parseFloat(/([\d.]+)%/.exec(style.width)?.[1] ?? '0') / 100
  return { from: left, to: left + width }
}

async function longestRow(page: Page): Promise<Locator> {
  const rows = scope(page).locator('button.rw-wf-row')
  let best = { index: 0, width: -1 }
  for (let index = 0; index < (await rows.count()); index++) {
    const share = await rowShare(page, rows.nth(index))
    if (share.to - share.from > best.width) {
      best = { index, width: share.to - share.from }
    }
  }

  return rows.nth(best.index)
}

type Flight = 'out' | 'back'

/**
 * Plays at half speed from where the playhead is, and pauses inside the page
 * the frame a pulse is between two workers, so the still catches it moving.
 */
async function pauseInFlight(page: Page, flight: Flight): Promise<void> {
  await scope(page).getByRole('radio', { name: '0.5x' }).click()
  await setPlaying(page, true)
  await page.waitForFunction(
    (kind) => {
      const root = document.querySelector('[data-iii-ui="rewind"]')
      const discs = Array.from(root?.querySelectorAll('.rw-graph-disc') ?? []).map((c) => ({ x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) }))
      const pulses = Array.from(root?.querySelectorAll(kind === 'out' ? '.rw-graph-pulse[data-kind="out"]' : '.rw-graph-pulse:not([data-kind="out"])') ?? [])
      const between = pulses.some((p) => {
        const x = Number(p.getAttribute('cx'))
        const y = Number(p.getAttribute('cy'))
        return discs.every((d) => Math.hypot(d.x - x, d.y - y) > 40)
      })
      if (between) {
        root?.querySelector<HTMLButtonElement>('.rw-play')?.click()
      }

      return between
    },
    flight,
    { polling: 'raf', timeout: 30_000 },
  )
  await scope(page).getByRole('radio', { name: '1x' }).click()
}

/**
 * `lost-call` is the ring breaking when tools goes away, or, on a stack that
 * does not record worker changes, the lost call's error coming back.
 */
type Sight = 'tools-joining' | 'lost-call' | 'request-out'

/** Plays at half speed and pauses inside the page the frame the ring shows what `sight` asks for. */
async function pauseOnSight(page: Page, sight: Sight): Promise<void> {
  await scope(page).getByRole('radio', { name: '0.5x' }).click()
  await setPlaying(page, true)
  await page.waitForFunction(
    (kind) => {
      const root = document.querySelector('[data-iii-ui="rewind"]')
      const tools = root?.querySelector<SVGGElement>('.rw-graph-node[aria-label^="tools"]')
      const shown = Number(tools?.style.getPropertyValue('--rw-shown') || 0)
      const lost = root?.querySelector('.rw-graph-hold[data-kind="broken"], .rw-graph-pulse[data-kind="error"]')
      // A request still close to the agent has only just left, and its host hasn't faded in yet.
      const request = root?.querySelector('.rw-graph-pulse[data-kind="out"][data-tone="outside"]')
      const agent = root?.querySelector('.rw-graph-node[aria-label^="agent"] .rw-graph-disc')
      const gone = request && agent ? Math.hypot(Number(request.getAttribute('cx')) - Number(agent.getAttribute('cx')), Number(request.getAttribute('cy')) - Number(agent.getAttribute('cy'))) : 0
      // Plain expressions only: a function defined in here would need a helper the page doesn't have.
      const seen = (kind === 'tools-joining' && shown > 0.35 && shown < 0.65) || (kind === 'lost-call' && Boolean(lost)) || (kind === 'request-out' && gone > 60)
      if (seen) {
        root?.querySelector<HTMLButtonElement>('.rw-play')?.click()
      }

      return seen
    },
    sight,
    { polling: 'raf', timeout: 30_000 },
  )
  await scope(page).getByRole('radio', { name: '1x' }).click()
}

/** Four moments of one line: a call on its way out, the longest call running, its answer on the way back, and the end. */
async function playerStills(page: Page, shot: Shooter, name: string): Promise<void> {
  const root = scope(page)
  await setPlaying(page, false)
  const longest = await longestRow(page)
  const outbound = root.locator('button.rw-wf-row').nth(1)
  await ((await outbound.count()) > 0 ? outbound : longest).click()
  await pauseInFlight(page, 'out')
  await shot(`${name}-1-call-on-its-way`)
  const share = await rowShare(page, longest)
  await scrubTo(page, (share.from + share.to) / 2)
  await shot(`${name}-2-longest-call-running`)
  await scrubTo(page, share.to - 0.002)
  await pauseInFlight(page, 'back')
  await shot(`${name}-3-answer-on-its-way-back`)
  await pressOnScrubber(page, 'End')
  await shot(`${name}-4-ended`)
}

/** A key on the scrubber, then focus moves away so the still has no focus ring. */
async function pressOnScrubber(page: Page, key: string): Promise<void> {
  const scrubber = scope(page).locator('.rw-scrub')
  await scrubber.focus()
  await page.keyboard.press(key)
  await scrubber.blur()
  await settle(page, 400)
}

async function backToLanding(page: Page): Promise<void> {
  await scope(page).getByRole('button', { name: 'Needs attention' }).first().click()
  await scope(page).locator('.rw-landing-row').first().waitFor({ timeout: 30_000 })
  await settle(page, 400)
}

/** The player on a SyntaxError run, on a booked fork of it and then on that fork paused at a stop, and on the double send's timeout. */
async function flowPlayer(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  await openLanding(page)
  await openFailureGroup(page, /SyntaxError/)
  await openPlayer(page)
  await playerStills(page, shot, 'syntax-error')
  // Closing in the middle of a call opens that call in the list.
  const longest = await rowShare(page, await longestRow(page))
  await scrubTo(page, (longest.from + longest.to) / 2)
  await root.getByRole('button', { name: 'Close the player' }).first().click()
  await root.locator('.rw-seq-item[data-open]').first().waitFor()
  await shot('closed-on-the-call-at-the-playhead')

  await editWithQuickFix(page, async () => undefined)
  await root.locator('.rw-editor button', { hasText: /^Fork$/ }).click()
  await idle(page)
  await openPlayer(page)
  await playerStills(page, shot, 'booked-fork')

  // Reduced motion steps from call to call; three steps in, the live calendar call is running.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await pressOnScrubber(page, 'Home')
  await setPlaying(page, true)
  await root.locator('.rw-wf-row[aria-current="step"] .rw-wf-fn', { hasText: /^calendar::find-slot$/ }).waitFor({ timeout: 30_000 })
  await setPlaying(page, false)
  await shot('booked-fork-reduced-motion-step')
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  // A stop on email::send reruns the fork, which now pauses there.
  await root.getByRole('button', { name: 'Close the player' }).first().click()
  await toggleStopInGutter(page, 'email::send')
  await root.locator('.rw-decision').first().waitFor({ timeout: RUN_WAIT_MS })
  await openPlayer(page)
  await pressOnScrubber(page, 'End')
  await shot('paused-fork-at-its-stop')

  await backToLanding(page)
  await openFailureGroup(page, /ran twice/)
  await openPlayer(page)
  await setPlaying(page, false)
  await pressOnScrubber(page, 'Home')
  await pauseOnSight(page, 'tools-joining')
  await shot('double-send-ring-making-room-for-tools')
  const gaveUp = root.locator('button.rw-wf-row[data-gave-up]').first()
  const share = await rowShare(page, gaveUp)
  await scrubTo(page, share.to + 0.06)
  await shot('double-send-timed-out-for-the-caller')

  // A run interrupted when tools died, opened from all runs so it plays in the run view.
  await backToLanding(page)
  await root.getByRole('button', { name: /^All \d+ runs/ }).click()
  await root.locator('.rw-run-row', { hasText: 'Stopped when a worker died' }).first().click()
  await root.locator('.rw-seq').waitFor({ timeout: 30_000 })
  await openPlayer(page)
  await setPlaying(page, false)
  await root.locator('button.rw-wf-row[data-lost]').click()
  await pauseOnSight(page, 'lost-call')
  await shot('interrupted-run-tools-stopped-mid-call')
  await scrubTo(page, 0.98)
  await shot('interrupted-run-tools-back-after-the-run')

  // A run that made its send after tools was gone, which failed at once and never ran.
  const missing = (await notFoundRuns())[0]
  if (!missing) {
    return
  }

  await root.getByRole('button', { name: 'Close the player' }).first().click()
  await backToLanding(page)
  await root.getByRole('button', { name: /^All \d+ runs/ }).click()
  await root.locator('.rw-run-row', { hasText: missing.run_id.slice(0, 8) }).first().click()
  await root.locator('.rw-seq').waitFor({ timeout: 30_000 })
  await page.mouse.move(0, 0)
  await shot('send-not-found-run')
  await openPlayer(page)
  await setPlaying(page, false)
  const failed = await rowShare(page, root.locator('button.rw-wf-row[data-lost]'))
  await scrubTo(page, failed.to + 0.1)
  await settle(page, 400)
  await shot('send-not-found-in-the-player')
}

/** The player playing the double send at 1x, for the video. */
async function flowPlayerVideo(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  await openLanding(page)
  await openFailureGroup(page, /ran twice/)
  await settle(page, 600)
  await openPlayer(page)
  await root.locator('.rw-play[aria-label="Play"]').waitFor({ timeout: 30_000 })
  await settle(page, 1_200)
  await shot('played-to-the-end')
}

/** One still of the player in the middle of a long call. */
async function flowPlayerStill(page: Page, shot: Shooter): Promise<void> {
  await openLanding(page)
  await openFailureGroup(page, /SyntaxError/)
  await openPlayer(page)
  await setPlaying(page, false)
  const share = await rowShare(page, await longestRow(page))
  await scrubTo(page, share.from + (share.to - share.from) * 0.6)
  await shot('longest-call-running')
}

// ── what the core captures around iii ───────────────────────────────────

/** From the landing, opens the newest run in all runs whose row says it succeeded, which has a fetch and an email POST. */
async function openBookedRun(page: Page): Promise<void> {
  const root = scope(page)
  await root.getByRole('button', { name: /^All [\d,]+ runs/ }).click()
  await root.locator('.rw-run-row', { hasText: 'Succeeded' }).first().click()
  await root.locator('.rw-seq').waitFor({ timeout: 30_000 })
  await settle(page)
}

async function openRow(page: Page, name: RegExp): Promise<void> {
  const root = scope(page)
  await root.locator('.rw-seq-row', { has: page.locator('.rw-seq-name', { hasText: name }) }).first().click()
  await root.locator('.rw-seq-item[data-open]').first().waitFor()
  await settle(page, 500)
}

/** Requests around iii, the email POST under email::send, and the traced function behind bugs 1 and 2. */
async function flowAround(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  await openLanding(page)
  await openBookedRun(page)
  await openRow(page, /^GET /)
  await shot('fetch-row-open')
  await openPlayer(page)
  await setPlaying(page, false)
  await root.locator('button.rw-wf-row', { has: page.locator('.rw-wf-fn', { hasText: /^GET / }) }).first().click()
  await pauseOnSight(page, 'request-out')
  await shot('fetch-on-the-ring')
  await root.getByRole('button', { name: 'Close the player' }).first().click()
  await openRow(page, /^email::send$/)
  await root.locator('.rw-inner-list').scrollIntoViewIfNeeded()
  await root.locator('.rw-inner .rw-collapse-trigger').first().click()
  await settle(page, 400)
  await root.locator('.rw-inner-list').scrollIntoViewIfNeeded()
  await shot('email-post-under-email-send')

  await backToLanding(page)
  await openFailureGroup(page, /SyntaxError/)
  await root.locator('.rw-span').first().waitFor({ timeout: 15_000 })
  await root.locator('.rw-span .rw-collapse-trigger').first().click()
  await settle(page, 400)
  await root.locator('.rw-span').first().scrollIntoViewIfNeeded()
  await shot('parse-args-threw-syntax-error')

  await backToLanding(page)
  await openFailureGroup(page, /TypeError in calendar::find-slot/)
  await root.locator('.rw-span').first().waitFor({ timeout: 15_000 })
  await root.locator('.rw-span .rw-collapse-trigger').first().click()
  await settle(page, 400)
  await root.locator('.rw-span').first().scrollIntoViewIfNeeded()
  await shot('find-slot-raised-type-error')

  // A fork of a double send replays the first send, which the stub holds past the end of the rerun.
  await backToLanding(page)
  await openFailureGroup(page, /ran twice/)
  await root.locator('.rw-seq-row', { has: page.locator('.rw-seq-name', { hasText: /^model::complete$/ }) }).last().click()
  await root.getByRole('button', { name: 'More actions for this call' }).click()
  await page.getByRole('menuitem', { name: /Fork with error/ }).click()
  await idle(page)
  await openPlayer(page)
  await pressOnScrubber(page, 'End')
  await shot('fork-timed-in-its-rerun-held-send')
}

type RunRowLike = { run_id: string; status: string; output?: { status?: unknown } | null }

/**
 * A replay that copies the tools worker, which the page has no control for, so
 * the walk asks Rewind for it. The calls to tools run in the copy, and the
 * email POST the copy made shows under email::send.
 */
async function flowCopy(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  const runs = (await iii.call({ function_id: 'rewind::runs', payload: { filter: 'all', limit: 100 }, timeoutMs: 30_000 })) as RunRowLike[]
  const booked = runs.find((run) => run.status === 'success' && run.output?.status === 'booked')
  if (!booked) {
    say('  no booked run to replay with tools copied')
    return
  }

  await iii.call({ function_id: 'rewind::replay', payload: { run_id: booked.run_id, copy: ['tools'] }, timeoutMs: RUN_WAIT_MS })
  await openLanding(page)
  await root.getByRole('button', { name: /^All [\d,]+ runs/ }).click()
  await root.getByLabel('Search runs').fill(booked.run_id.slice(0, 8))
  await root.locator(`.rw-run-row[data-run="${booked.run_id}"]`).click()
  await root.locator('.rw-run-notes button', { hasText: 'Compare' }).click()
  await root.locator('.rw-compare').waitFor()
  await settle(page)
  await shot('replay-with-tools-copied')
  await root.locator('.rw-cmp-table tr', { has: page.locator('.rw-cmp-fn .rw-mono', { hasText: /^email::send$/ }) }).first().click()
  await root.locator('.rw-seq-item[data-open]').first().waitFor()
  await root.locator('.rw-inner-list').scrollIntoViewIfNeeded()
  await settle(page, 400)
  await shot('email-send-ran-in-the-copy')
}

/**
 * Rewind in the workspace beside Traces. Clicking a call's function name
 * opens the run's own trace, then sync follows the selection to another run.
 * Traces' default view hides traces without a session, and it doesn't open a
 * trace its filters hide, so the walk clears them first.
 */
async function flowTracesSync(page: Page, shot: Shooter): Promise<void> {
  const root = scope(page)
  const traces = page.locator('section[aria-label="traces"]')
  await page.goto(CONSOLE_URL)
  await settle(page, 2_000)
  await iii.call({ function_id: 'ade::workspace::open', payload: { screen: 'traces' }, timeoutMs: 10_000 })
  await traces.getByRole('button', { name: 'Clear all' }).click({ timeout: 10_000 }).catch(() => undefined)
  await iii.call({ function_id: 'ade::workspace::open', payload: { screen: 'ext:rewind' }, timeoutMs: 10_000 })
  await root.locator('.rw-landing-row').first().waitFor({ timeout: 30_000 })
  await openFailureGroup(page, /SyntaxError/)
  await callRow(page, 'model::complete').first().locator('.rw-seq-name').click()
  await traces.locator('[data-trace-span-id]').first().waitFor({ timeout: 15_000 })
  await page.mouse.move(0, 0)
  await settle(page, 1_500)
  await shot('traces-opened-from-the-function-name')

  const next = root.getByRole('button', { name: 'Next run in this group' })
  if (await next.isEnabled()) {
    await next.click()
    await root.locator('.rw-seq-item[data-open]').first().waitFor()
  }

  const sync = root.locator('.rw-sync')
  if ((await sync.getAttribute('aria-pressed')) !== 'true') {
    await sync.click()
  }

  await settle(page, 1_500)
  await root.locator('.rw-seq-row', { has: page.locator('.rw-seq-name', { hasText: /^clock::now$/ }) }).first().click()
  await page.locator('section[aria-label="traces"] [data-trace-span-id]').first().waitFor({ timeout: 15_000 })
  await settle(page, 1_500)
  await shot('traces-open-on-the-call')
}

const APPROVAL_REQUESTS = ['Dana next Tuesday', 'Priya next Wednesday', 'Marcus next Thursday', 'Lena next Monday', 'Omar next Friday', 'Sofia next Tuesday']

/** Starts agent::run with approval until one parks before its invite, since the fake model fails some runs first (bug 1). */
async function parkForApproval(): Promise<string> {
  for (const [index, who] of APPROVAL_REQUESTS.entries()) {
    const workflowId = `shoot-approval-${Date.now()}-${index}`
    const payload = { request: `Book 30 minutes with ${who} afternoon`, approval: true, _workflow_id: workflowId }
    const reply = await iii.call<unknown, { pending?: boolean }>({ function_id: 'agent::run', payload, timeoutMs: 60_000 }).catch(() => ({ pending: false }))
    if (reply.pending) {
      return workflowId
    }
  }

  throw new Error('no agent::run with approval parked before its invite')
}

/** A durable run waiting for approval: the landing's Waiting row, the runs waiting for approval, the run's question, and the run once approved. */
async function flowWaiting(page: Page, shot: Shooter): Promise<void> {
  const workflowId = await parkForApproval()
  const root = scope(page)
  await page.goto(`${CONSOLE_URL}/#/worker/rewind/rewind`)
  const row = root.locator('.rw-landing-row[data-wait="wait:approval"]')
  await row.waitFor({ timeout: 30_000 })
  await shot('landing-waiting')
  await row.click()
  const run = root.locator('.rw-level .rw-landing-row', { hasText: workflowId })
  await run.waitFor({ timeout: 15_000 })
  await shot('waiting-for-approval')
  await run.click()
  await root.getByRole('button', { name: 'Approve' }).waitFor({ timeout: 15_000 })
  await shot('waiting-run-before')
  await root.getByRole('button', { name: 'Approve' }).click()
  await root.getByText(/^Run (booked|failed|done)/).waitFor({ timeout: 30_000 })
  await shot('waiting-run-after')
}

/** The states around the flows: loading, nothing recorded yet, and Rewind not answering. */
async function flowStates(page: Page, shot: Shooter): Promise<void> {
  await configure({ delay_ms: 2500 })
  await page.goto(`${CONSOLE_URL}/#/worker/rewind/rewind`)
  await scope(page).locator('.rw-skeleton-list, .rw-skeleton-work').first().waitFor({ timeout: 30_000 })
  await shot('loading')
  await configure({ delay_ms: 140, empty: true })
  await page.reload()
  await scope(page).locator('.rw-empty').first().waitFor({ timeout: 30_000 })
  await shot('nothing-recorded-yet')
  await configure({ reset: true, fail: true })
  await page.reload()
  await scope(page).locator('.rw-error').first().waitFor({ timeout: 30_000 })
  await shot('rewind-not-answering')
  await configure({ fail: false })
}

const FLOWS: Flow[] = [
  { id: 'a', core: true, walk: flowA },
  { id: 'b', core: true, walk: flowB },
  { id: 'c', core: false, walk: flowC },
  { id: 'saved-test', core: false, walk: flowSavedTest },
  { id: 'd', core: true, walk: flowD },
  { id: 'd-unknown', core: true, walk: flowUnknownEffects, themes: ['dark'] },
  { id: 'd-motion', core: false, walk: flowDMotion, themes: ['dark'], video: true },
  { id: 'e', core: false, walk: flowE },
  { id: 'copy', core: true, walk: flowCopy },
  { id: 'schema', core: true, walk: flowSchema, themes: ['dark'] },
  { id: 'states', core: false, walk: flowStates },
  { id: 'player', core: true, walk: flowPlayer, themes: ['dark'] },
  { id: 'player-video', core: true, walk: flowPlayerVideo, themes: ['dark'], video: true },
  { id: 'player-light', core: true, walk: flowPlayerStill, themes: ['light'] },
  { id: 'around', core: true, coreOnly: true, walk: flowAround, themes: ['dark'] },
  { id: 'traces', core: true, coreOnly: true, walk: flowTracesSync, themes: ['dark'] },
  { id: 'waiting', core: true, coreOnly: true, walk: flowWaiting },
]

// ── running a flow ──────────────────────────────────────────────────────

type Run = { flow: Flow; theme: Theme; width: number; video: boolean }

function folderOf(run: Run): string {
  const width = run.width === WIDE ? '' : `-${run.width}`
  return path.join(SHOTS, `${run.flow.id}-${run.theme}${width}`)
}

async function newContext(browser: Browser, run: Run, dir: string): Promise<BrowserContext> {
  const size = { width: run.width, height: HEIGHT }
  const context = await browser.newContext({
    viewport: size,
    colorScheme: run.theme,
    ...(run.video ? { recordVideo: { dir, size } } : {}),
  })
  await context.addInitScript((theme) => window.localStorage.setItem('iii-theme', theme), run.theme)
  return context
}

async function walk(browser: Browser, run: Run): Promise<boolean> {
  const dir = folderOf(run)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  say(`${path.relative(SHOTS, dir)}`)
  await configure({ reset: true, empty: false, fail: false, delay_ms: 140 })
  const context = await newContext(browser, run, dir)
  const page = await context.newPage()
  const problems = watchProblems(page)
  let count = 0
  const shot: Shooter = async (name) => {
    count += 1
    await settle(page)
    const file = `${String(count).padStart(2, '0')}-${name}`
    await page.screenshot({ path: path.join(dir, `${file}.png`) })
    await noteRenderError(page, file, problems)
    say(`  ${file}`)
  }

  let ok = true
  try {
    await run.flow.walk(page, shot)
    await noteRenderError(page, 'the end', problems)
  } catch (error) {
    ok = false
    await page.screenshot({ path: path.join(dir, 'failed-here.png') }).catch(() => undefined)
    say(`  FAILED: ${(error as Error).message.split('\n')[0]}`)
  } finally {
    await context.close()
    const video = readdirSync(dir).find((f) => f.endsWith('.webm') && f !== 'flow.webm')
    if (video) {
      renameSync(path.join(dir, video), path.join(dir, 'flow.webm'))
    }

    say(problems.length ? `  page errors:\n    ${problems.join('\n    ')}` : '  no page errors')
  }

  return ok && problems.length === 0
}

/** Every uncaught error and every console.error the page logs while it walks. */
function watchProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      problems.push(`console.error: ${message.text().split('\n')[0]}`)
    }
  })
  return problems
}

// A render error the page's error boundary caught is drawn on screen and throws nothing the browser sees.
async function noteRenderError(page: Page, where: string, problems: string[]): Promise<void> {
  const caught = scope(page).getByText('Render error', { exact: true })
  if ((await caught.count()) > 0) {
    const detail = await scope(page).locator('.rw-error').first().innerText().catch(() => '')
    problems.push(`Render error at ${where}: ${detail.replace(/\s+/g, ' ').trim()}`)
  }
}

function plan(): Run[] {
  const wanted = (process.env.FLOWS ?? '').split(',').filter(Boolean)
  const themes = (process.env.THEMES ?? 'dark,light').split(',').filter(Boolean) as Theme[]
  const flows = FLOWS.filter((f) => (AGAINST_CORE ? f.core : !f.coreOnly) && (wanted.length === 0 || wanted.includes(f.id)))
  const runs: Run[] = flows.flatMap((flow) =>
    themes
      .filter((theme) => !flow.themes || flow.themes.includes(theme))
      .map((theme) => ({ flow, theme, width: WIDE, video: Boolean(flow.video) || (AGAINST_CORE && flow.id === 'b' && theme === 'dark') })),
  )
  const flowA = flows.find((f) => f.id === 'a')
  if (flowA && !AGAINST_CORE) {
    runs.push({ flow: flowA, theme: 'dark', width: NARROW, video: false })
  }

  return runs
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const failed: string[] = []
try {
  for (const run of plan()) {
    if (!(await walk(browser, run))) {
      failed.push(path.relative(SHOTS, folderOf(run)))
    }
  }
} finally {
  await browser.close()
  await configure({ reset: true, delay_ms: 140, fail: false }).catch(() => undefined)
  // The SDK's shutdown can wait on its telemetry export, so it gets a few seconds.
  await Promise.race([iii.shutdown(), new Promise((resolve) => setTimeout(resolve, 3_000))])
}

say(failed.length ? `failed: ${failed.join(', ')}` : 'every flow finished')
process.exit(failed.length ? 1 : 0)

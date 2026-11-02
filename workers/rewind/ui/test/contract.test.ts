// The page's unions against the Rust core's serde enums. Adding a variant to one of the unions makes
// every table typed as a Record over it fail to build until the table has a row for it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ANSWER_SOURCES, CALL_KINDS, CHECK_VERDICTS, FORK_MODES, OUTCOME_STATES, PAUSE_REASONS } from '../src/client/types'
import { CONTINUE_LABEL } from '../src/model/choices'
import { REPLAY_ON_OPEN } from '../src/model/nav'
import { SOURCES } from '../src/model/sources'
import { rustEnum } from './rustEnums'

function sameValues(page: readonly string[], core: readonly string[], what: string): void {
  const missing = core.filter((value) => !page.includes(value))
  const extra = page.filter((value) => !core.includes(value))
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${what}: the page lacks ${JSON.stringify(missing)} and has ${JSON.stringify(extra)} the core never sends`)
}

const ENUMS = [
  { file: 'types.rs', name: 'Source', page: ANSWER_SOURCES, tables: { SOURCES } },
  { file: 'types.rs', name: 'PauseReason', page: PAUSE_REASONS, tables: {} },
  { file: 'types.rs', name: 'Mode', page: FORK_MODES, tables: { CONTINUE_LABEL } },
  { file: 'types.rs', name: 'Outcome', page: OUTCOME_STATES, tables: {} },
  { file: 'outside/mod.rs', name: 'Kind', page: CALL_KINDS, tables: {} },
  { file: 'checks.rs', name: 'Verdict', page: CHECK_VERDICTS, tables: { REPLAY_ON_OPEN } },
]

for (const { file, name, page, tables } of ENUMS) {
  test(`the page has every ${name} the core sends`, () => {
    sameValues(page, rustEnum(file, name).values, name)
  })

  for (const [table, value] of Object.entries(tables)) {
    test(`${table} has a row for every ${name}`, () => {
      sameValues(Object.keys(value), rustEnum(file, name).values, table)
    })
  }
}

test('a fork outcome is tagged by state, which the page dispatches on', () => {
  assert.equal(rustEnum('types.rs', 'Outcome').tag, 'state')
})

test('a renamed or missing enum fails instead of passing with no variants', () => {
  assert.throws(() => rustEnum('types.rs', 'NoSuchEnum'), /no enum NoSuchEnum/)
})

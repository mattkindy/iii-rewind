# Save as test

Save as test writes one finished fork to a JSON file, with the run's input, the answer every call
got and how the run ended. Running the test later replays the code on disk against those answers
alone and says whether it still ends the same way. The developer reaches for it once a fix works,
to keep the failing run as a test (job 5 in [jobs.md](../jobs.md)).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../media/flow-save-as-test-dark.svg">
  <img alt="You save a finished fork as a JSON file in tests/rewind, and running it starts a copy of the agent that gets only the saved answers and says whether it ended the way the file expects." src="../media/flow-save-as-test-light.svg">
</picture>

## Steps

1. **A person** opens a fork or a replay that finished, either done or crashed, and clicks Save as
   test. The page suggests a name made from the failure's signature and the run's short id. It
   calls `rewind::save-test` with `{ fork_id, name }`.
2. **Rewind** builds the test from the fork's latest rerun and writes it to
   `tests/rewind/<name>.json`. It lowercases the name and turns anything other than a letter, a
   digit, `-` or `_` into `-`. Without a name, the file is named after the first 8 characters of
   the run id and the fork id, such as `run-3f2a9c10-f7.json`. The file has four fields:
   - `entry`, the run's root function, such as `agent::run`;
   - `input`, the run's recorded input;
   - `answers`, one for each call the rerun made, with its `seq`, its `path` when it is a call
     inside another call, its `function_id`, its `answer`, its `source`, and a `hold` when the
     caller gave up on that call;
   - `expect`, which is `{ status }` when the output has a `status`, `{ output }` when it doesn't,
     or `{ throws }` with the error message.

   A paused fork is refused with `REWIND_FORK_PAUSED`. Rewind returns the path from the project
   folder along with the test.
3. **A person** clicks Run test, and the page calls `rewind::test` with `{ path }`. A test's name, a
   path from the project folder and an absolute path all work, as long as the file is inside
   `tests/rewind`. A path that leads anywhere else, with `..` or through a link, is refused with
   `REWIND_BAD_INPUT`.
4. **Rewind** reads the file and turns each saved answer into an answer at its place.
5. **Rewind** takes a namespace `rewind-f<n>`, a spare when the entry runs in the worker under test,
   registers the stubs, and makes sure a copy of the entry's worker runs the code on disk. Then it
   calls the entry there with the saved input.
6. **The stub** for each call returns the saved answer at that place when it is for the same
   function. When the answer has a `hold`, the stub first waits as long as the recorded call took,
   so the copy's timeout fires the way it did. A test has no recording behind it, so the stub never
   compares the input the copy sends.
7. **The stub** pauses at any call the file has no answer for. Nothing in a test runs live.
8. **The copy's entry** returns, throws or ends at the pause. Rewind closes the namespace and its
   copy and returns `{ pass, expected, outcome }`. A test passes when the run is done with the
   expected `status`, or exactly the expected `output`, or when it crashed with the expected error
   message. A paused run fails. The page shows "Test passed" or "Test failed". Rewind doesn't store
   a test run as a fork.

## What it guarantees and what it doesn't

Running a test doesn't call anything in `default` or send anything. A saved test has every answer
it needs, so it still runs after Rewind has dropped the recorded run. It runs the code that is on disk
when it starts, so it tells whether a later change still gets the same ending from the same
answers.

A test checks the ending and little else. It compares the status, the whole output or the error
message, and doesn't look at the calls on the way there. The saved answers match on place and
function alone, so a change that sends a different input to the same call at the same place still
gets the saved answer and can still pass. A change that adds or reorders a call reaches a place the
file has no answer for, pauses there, and fails. Answers that came from live calls or from another
run in the fork are frozen in the file as they were in that rerun.

## Limits

- Nothing in this repo runs `tests/rewind` in CI, and `.gitignore` leaves `/tests/` out of git, so
  a saved test stays on the machine that saved it unless someone commits it on purpose. Running one
  needs the stack: the engine, Rewind and a copy of the agent.
- A test copies only the entry's worker. A call that ran in another worker's copy in the fork gets
  the copy's answer back from a stub, and the calls inside it don't happen.
- Only a fork can be saved. To save the original run as it was recorded, replay it and save the
  replay. The page offers Save as test on forks and replays that ended, and never on the original.

## Where it is in the code

- `workers/rewind/src/fixtures.rs`: `save`, `run`, `fixture_of`, `expect_for`, `passes`, the file
  name and the check that a path stays inside `tests/rewind`.
- `workers/rewind/src/functions.rs`: `rewind::save-test` and `rewind::test`.
- `workers/rewind/src/replay/decision.rs`: `decide`, where a saved answer comes first and matches on
  place and function.
- `workers/rewind/ui/src/components/saveTest.tsx`: Save as test and Run test;
  `runWorkspace.tsx`: saving and running; `compareView.tsx` and `forkSwitcher.tsx`: where the
  buttons appear.

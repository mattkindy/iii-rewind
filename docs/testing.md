# Testing Rewind

## The end-to-end check

With the stack running (`iii compose --up`):

```bash
npm run check
```

It fires a burst, then replays one run of each kind and checks that each ends the way it was
recorded. It forks a crash into a booking and saves and runs that fork as a test. It applies the
fix in `docs/demo-fix.patch`, which asks the model again when its tool arguments don't parse, and
checks every crashed run against it twice: once with no live calls, where each run stops at the new
model call, and once with live calls, where most of them book. Then it reverts the patch.

It checks the calls around iii: a replayed fetch gets its recorded response with the holidays API
paused, the email POST is recorded under `email::send`, both bugs' function spans are there, and an
inbound request replays. It replays a booking with the tools worker copied, where find-slot's Python
runs in the copy and the email POST gets its recorded response, and it replays a
`calendar::find-slot` call made with `iii call` as a run of its own.

It forks a crash with safe defaults and checks that the fork runs to a booking without stopping,
and that a stop on `email::send` pauses it there. It checks that Rewind passes on each function's
schemas, and that each run in a burst has a trace of its own. Last, it kills the tools worker,
recovers an interrupted run, and checks that the run shows tools disconnecting and connecting
again. Throughout, it checks that nothing was written to the outbox.

Because it edits `workers/agent` for a moment, it refuses to start when that folder has
uncommitted changes. Set `III_URL` and `III_COMPOSE_DIR` to run it against a stack somewhere else.

## Unit tests

None of these need a running stack.

```bash
cargo test --manifest-path workers/rewind/Cargo.toml                                  # Rewind's core
node --test workers/rewind/preload/node/preload.test.mjs                              # Node preload
node --test workers/rewind/preload/node/durable.test.mjs                              # durable runs in it
(cd workers/journal && npm install && npm test)                                       # the journal
workers/tools/.venv/bin/python -m unittest discover -s workers/rewind/preload/python  # Python preload
(cd workers/rewind/ui && npm install && npm test)                                     # the page
```

The Python preload's tests for requests and urllib3 are skipped in the tools venv, which has
neither. uv adds them on top of it, once for each major version of urllib3:

```bash
for urllib3 in 'urllib3<2' 'urllib3>=2'; do
  uv run --no-project --python workers/tools/.venv/bin/python --with requests --with "$urllib3" \
    python -m unittest discover -s workers/rewind/preload/python
done
```

The page's tests cover its model, plus a contract test that reads the core's serde enums and fails
when the page lacks a value the core sends.

## The page's walks

The page has a mock of every `rewind::*` function, so it runs without an engine or the agent, and
a script that walks each flow against it in dark and light and saves a screenshot at each step. A
walk fails on any page error, any `console.error` and any render error on screen.
`workers/rewind/ui/DESIGN.md` has the commands.

## Saved tests

Save as test writes a fork to `tests/rewind`, and the files there are committed with the code.
With the stack running:

```bash
npm run saved-tests
```

It replays every file in `tests/rewind` against the code on disk, one after another, and prints
each result. A test that diverged shows the call it stopped at and each field of the input that
changed. The command exits with 1 when any test fails. [Save as test](flows/save-as-test.md) says
what a test compares.

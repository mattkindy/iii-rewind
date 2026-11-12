# Check

A check replays a group of recorded runs against the code on disk now, and says for each run
whether it ended the same way, ended differently, or stopped at a call the recording doesn't have.
The developer reaches for it after changing the code, to see whether a fix works on every run that
failed the same way, and before shipping, to see which recent runs would come out differently
(jobs 4 and 7 in [jobs.md](../jobs.md)).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../media/flow-check-dark.svg">
  <img alt="You check a group of runs, and Rewind replays each one in turn on one copy of the agent in rewind-c<n>, stopping at the first call the recording lacks unless the check is live, and reports same, different or stopped for each." src="../media/flow-check-light.svg">
</picture>

## Steps

1. **A person** clicks Check similar runs on a run, which checks every run in its failure group, or
   Check against current code on the landing, which checks the newest 25 runs. The page calls
   `rewind::check` with `{ run_ids }`. When runs stopped at a new call, the person can click Run new
   calls live, which checks the same runs again with `live: true`.
2. **Rewind** refuses more than 500 runs, and refuses a set whose roots belong to different workers,
   because every run in a check shares one copy. It takes the next check number, opens
   `rewind-c<n>` with a handler for every function in `default` that the copy doesn't run, and
   starts one copy of the root's worker on the code on disk. A check always starts its copy cold.
3. **Rewind** replays the runs one after another on that copy. For each run it calls `agent::run`
   in `rewind-c<n>` with that run's recorded input.
4. **The stubs** return the recorded answer for each call that matches the recording, the same way
   a replay does.
5. **The stubs** end the replay at the first call the recording doesn't have when the check isn't
   live, and the run's result is `stopped`, with `stopped_at` saying which call. A fix usually
   makes a new call, so every run in a group often stops at the same place.
6. **The stubs** decide a new call by its effects when the check is live. A call whose effects are
   all `pure`, `read-only` or `external`, and any GET or HEAD request, runs live in `default`. A call
   that writes, is irreversible or declares no effects never runs: the stub gives it the newest
   successful answer that function gave in another run, and the result lists the call in `filled`
   with the run it came from. When no other run has one, the run stops there.
7. **Rewind** compares the replay's outcome with the recorded one. A replay that paused is
   `stopped`, and one that ended like the recording is `same`. Otherwise Rewind replays the run a
   second time with every answer the first replay got and nothing live, and takes the fields that
   differ between the two replays as noise. The run is `same` when only noise differs from the
   recording, and `different` when anything else does.
8. **Rewind** calls `rewind::changed` with `{ kind: "check", id, check }` as each run finishes, and
   the page fills in that run's result.
9. **Rewind** moves on to the next run on the same copy. After the last one it closes `rewind-c<n>`
   and its copy, and returns one `CheckResult` per run in the order they were asked for.

## What it guarantees and what it doesn't

A check without `live` doesn't call anything in `default`. A live check runs only the calls a person could
run live in a debug fork, so it never sends a call that writes, is irreversible or declares no
effects. Each result says which code version it ran in `code`, which calls ran live in `live`, and
which calls got another run's answer in `filled`. Rewind doesn't store a check as a fork, and it
closes the check's namespace and copy when the check ends.

A run comes back `same` when its outcome matches the recording, and the calls on the way there may
still differ. A live check depends on what the live calls return, so the model can send two checks
of the same run down different paths. The second replay only catches noise that changes from one replay to the
next on the same code. A field that differs from the recording, but comes out the same in both
replays, makes the run `different`.

## Limits

- One check takes at most 500 runs, and all of them have to be runs of one worker's functions.
- The runs go through one copy one at a time. The page waits 120 seconds plus 5 seconds for each
  run, and at most 15 minutes, before it gives up on the call.
- When a replay fails outright, for example because the copy didn't start, the whole check returns
  that error. The `check` events for the runs before it have already gone out.
- The page keeps a check's results while it is open, and starting another check drops them.
- Checking an execution of a resumed durable run checks only the calls that execution made live,
  for the same reason [replay](replay.md#limits) gives.

## Where it is in the code

- `workers/rewind/src/checks.rs`: `check`, `check_one`, the second replay and the noise.
- `workers/rewind/src/replay/decision.rs`: `Policy::of_check` and what a live check runs or fills.
- `workers/rewind/src/functions.rs`: `rewind::check`.
- `workers/rewind/ui/src/data/useCheck.ts` and `components/checkView.tsx`: the two passes and
  their results; `components/runWorkspace.tsx`: Check similar runs; `components/rewindPage.tsx`:
  Check against current code.

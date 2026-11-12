# Rewind's flows

All eight flows depend on two things: a record of each call between the app's functions, with its
input, its answer and who made it, and the effects each function declares, such as `read-only` or
`irreversible`. [Record](record.md) collects the calls. [Replay](replay.md), [fork](fork.md),
[check](check.md), [recover](recover.md) and running a [saved test](save-as-test.md) each run a
copy of the worker in a namespace of Rewind's own, where every call the copy makes reaches one of
Rewind's stubs. The stub returns a stored answer when it has one. When it doesn't, the call's
declared effects decide whether it runs live in `default`, gets another run's answer, or waits for
a person. [Resume](resume.md) and [pause](pause.md) run the code again on the live agent instead,
and their stored answers come from the journal.

| Flow | Who uses it | What starts it | Where it runs | What runs live, and what gets a stored answer | A call that writes or can't be undone | What it leaves behind |
| --- | --- | --- | --- | --- | --- | --- |
| [Record](record.md) | Both people in [jobs.md](../jobs.md), without doing anything. Every other job needs it. | Rewind starting up. A person can turn one function off or on from the recording menu (`rewind::record-toggle`). | The live workers in `default`. Rewind only observes. | Everything runs live, and Rewind keeps a record of it. | Runs as the app makes it, and Rewind records it. | Calls in `data/rewind.sqlite`, spans in `data/spans.sqlite`, and worker changes, kept for 7 days or 20,000 runs. |
| [Replay](replay.md) | The developer reproducing a failure (jobs 1 and 2). | Replay on a run (`rewind::replay`). | A copy of the root's worker in `rewind-f<n>`, or `rewind-h<n>` for a request to a worker's own server. | Every call gets its recorded answer. A new call pauses, except a pure or read-only one with `auto_read` on, which runs live. | Gets its recorded answer. A new one pauses and is never sent. | A fork with no edit in the store. |
| [Fork](fork.md) | The developer testing a theory about the cause (job 3). | Edit answer and Fork, or Fork with error (`rewind::fork`). Later `rewind::answer` and `rewind::fork-set`. | A copy in `rewind-f<n>`. | Recorded answers up to the edit, and the person's answer at it. With `auto` on, as the page forks, new pure, read-only and external calls run live. | Never sent. Gets the newest successful answer from another run, or pauses. | A fork with its parent and its edit in the store. |
| [Check](check.md) | The developer checking a fix, or what a change would change (jobs 4 and 7). | Check similar runs, Check against current code, or Run new calls live (`rewind::check`). | One copy in `rewind-c<n>` for every run in the check, closed at the end. | Recorded answers, and the first new call stops the run. With `live`, new pure, read-only and external calls run live. | Never sent. A live check gives it another run's answer, and otherwise the run stops. | Nothing in the store. One result per run, returned and sent as `check` events. |
| [Recover](recover.md) | The person on call after a callee's worker died (job 6). | Recover or Recover all under Interrupted (`rewind::recover`), then a decision for each group (`rewind::answer`). | A copy in `rewind-f<n>`, in recover mode. | Recorded answers for the calls that finished. Pure, read-only and external calls run live. | Pauses until a person marks it sent, sends it live, or skips the run. A call cut off mid-call pauses as `lost` unless it only reads. | A recovery fork in the store, which outlasts restarts. |
| [Resume](resume.md) | Nobody day to day. The person on call steps in only when a crash leaves a step pending for them (job 6). | The agent's worker disconnecting, then the journal's sweep calling `agent::run` again, or the queue delivering the job again. A run that paused starts again the same way once its pending step is resolved. | The live agent in `default`, with the same workflow id. | Finished steps, a resolved wait included, get their saved results from the journal. Everything after the crash or the pause runs live. | Gets its saved result if it finished. If it was in flight, it goes out again with its idempotency key when its function takes one, and otherwise it stays pending until a person sends it again or enters its result, on Rewind's page or with `journal::resolve`. | The workflow, its steps, any pending step and its executions in `data/journal.sqlite`. Rewind records each execution as a separate run. |
| [Pause](pause.md) | Whoever approves what a run does, such as the agent's invite, on Rewind's page under Waiting. | The run's own code calling `durable::wait` or `durable::sleep`. It goes on when someone resolves the step with `journal::resolve`, or when its timeout or wake time comes due. | Nowhere while it waits: the handler returns `{ pending: true }`. Then the live agent in `default`, with the same workflow id. | Saved results from the journal for every step before the wait, and the value that resolved it. Everything after runs live. | Nothing runs while the run waits. After it, the call goes out live, with its idempotency key when it is irreversible. | The pending step, its deadline and the value it got in `data/journal.sqlite`. |
| [Save as test](save-as-test.md) | The developer keeping a fix fixed (job 5). | Save as test on a finished fork (`rewind::save-test`), then Run test (`rewind::test`). | Saving writes a file. Running uses a copy in `rewind-f<n>`, closed at the end. | Only the answers in the file. Nothing runs live, and any other call pauses and fails the test. | Gets its saved answer and is never sent. | `tests/rewind/<name>.json`. A test run leaves nothing. |

Replay and fork both run a copy against the recording. Replay gives every call its recorded answer
and stops at the first call the recording doesn't have, so it shows whether a failure reproduces.
Fork changes one answer, or puts an error in its place, and runs the code to its end. The page's
forks run new safe calls live and give the rest another run's answer.

Recover and resume both finish a run that a crash cut short, but they handle different crashes in
different places. Recover is Rewind's. When a callee's worker such as the tools dies, the agent's
run finishes as failed and shows up under Interrupted. Recovering it runs a copy of the agent in
`rewind-f<n>`, where stubs return the recorded answers, and the recovery waits for a person at each
call that writes or can't be undone. Resume is the journal's. When the agent itself dies,
Rewind never sees the run, and the journal calls `agent::run` again on the live agent in `default`
with the same workflow id, returning saved results for the steps that finished. It sends an
irreversible step again with its idempotency key, and asks a person only when a step can't be
repeated safely.

Resume and pause meet at the journal's pending steps. A crash leaves a step pending when the call
in flight can't be sent again safely, and the run's own code leaves one when it calls
`durable::wait` or `durable::sleep`. Either way the run waits with nothing running it, Rewind's page
lists it under Waiting, and resolving the step starts the run again on the live agent.

Check and save as test both run the code on disk against answers that already exist. A check takes
a group of recorded runs, works from the recording, and says same, different or stopped for each,
without storing anything. Save as test writes one finished fork's answers and ending to a file.
Running it later uses only that file and says pass or fail, so it keeps working after the
recording is gone.

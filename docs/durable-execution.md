# Durable agent runs

An agent run now survives the agent worker dying in the middle of it. The run starts again on the
worker compose brings back, the calls it already finished are not made again, and the invite goes
out once. iii's engine is unchanged: Rewind's Node preload keeps a journal of each run's calls in a
new journal worker, the way DBOS and Restate keep one, and the journal or iii's queue starts the
interrupted run again.

In a burst of 40 runs with the agent killed three times, the journal and its recovery finished all
20 runs the kills interrupted, no booking got a second invite from a crash, and the runs made 9 model
calls more than they make uninterrupted. Started through iii's queue instead, 17 of 17 finished.
Today's code finished none of its 22 interrupted runs. A caller that starts a stopped run over
finished all 24 of its interrupted runs, but sent 6 bookings two invites and made 36 extra model
calls. The table is under [What it measured](#what-it-measured).

A durable run can also pause on purpose, to wait for a person's approval or another value, or to
sleep, with no worker running it while it waits. [Pausing a run](#pausing-a-run) covers that.

## What durable means here

A function opts in with `durable: true` in its metadata. In this repo that is `agent::run`. For a run
of such a function:

- Once the run's start reaches the journal, the run ends exactly once, with the outcome its own code
  reaches, as long as the journal and a worker hosting the function come back.
- A call the run made that returned, and whose result the journal saved, is never made again. The
  run's code gets the saved result instead.
- A call that was in flight when the worker died is made again when its function declares that a
  repeat is harmless (`pure`, `read-only` or `external`), and made again with the same idempotency
  key when it is irreversible and takes a key, as `email::send` now does. Anything else is left as
  a pending step, and the run waits for a person to resolve it.
- `email::send` drops a call whose key it has seen, so the step in flight at a crash sends one
  invite.
- A handler that lost its connection but kept running cannot save anything once the run has started
  again, and its next call fails.

What it does not do:

- The caller of the interrupted call still gets `invocation_stopped`. The run's outcome is in the
  journal, where `journal::wait` returns it.
- A model call in flight at the crash is made twice. The model answered, but the engine dropped the
  answer with the dead caller.
- The agent's own retry of a slow send (bug 3) still sends two invites. The journal sees two calls
  to `email::send`, not one call sent twice.
- A run whose call never reached the agent, because the agent was down when it was sent, has no
  journal yet. The caller has to send it again with the same workflow id, or send it through the
  queue, which keeps it until the agent is back.
- Requests around iii, such as the agent's holiday fetch, run again on every execution.
- Only Node workers with the preload can run durable functions.

## What runs where

![traffic starts agent::run with a workflow id, directly or through iii's queue. Rewind's preload in the agent writes begin, intent, result and finish to the journal worker around every call the run makes. email::send gets an idempotency key. After a crash the journal's recovery calls agent::run again with the same workflow id, and a write from the old epoch is refused.](media/durable-run.svg)

## How a run resumes

1. `traffic::burst` calls `agent::run` with `_workflow_id` in the input. Metadata would be lost on
   the queue path, which drops it, so the id goes in the payload.
2. The preload's wrapper around the handler calls `journal::begin`. The journal creates the run,
   gives it epoch 1, and records the agent's worker id, which it reads from the call's caller, as the
   run's owner.
3. Every call the run's code makes is a step. The wrapper numbers steps in the order the code starts
   them, before anything is awaited, so calls started together get numbers in program order. Before
   the call goes out, `journal::intent` saves the epoch, step number, function and a hash of the
   input, and returns an idempotency key when the function is irreversible. After the call returns,
   `journal::result` saves its value or error, and only then does the code see it.
4. The agent dies. The engine fails the in-flight `agent::run` with `invocation_stopped` and fires
   `worker_disconnected`. The journal clears the owner of every running workflow that worker had.
5. Compose restarts the agent, which took about 2 to 4 seconds here. About 100 to 200 ms after
   `agent::run` registers again, the journal's recovery calls it with the same `_workflow_id`. On
   the queue path the queue delivers the job again instead, about 20 ms after the function is back.
6. `journal::begin` gives the run epoch 2 and returns its saved steps. The code runs again from the
   top. Each step that has a result returns it without a call, as long as the function and input
   hash match. A mismatch fails the run as `DIVERGED`. The step that was in flight is sent again
   with its original idempotency key, or is left pending for a person, by what its function
   declares.
7. The run finishes and `journal::finish` saves its output. The caller, waiting in `journal::wait`,
   gets it.
8. If the old handler was still running, its next write comes with epoch 1. The journal refuses it as
   `FENCED`, and from then on every call that handler makes throws the same error, even if the code
   catches it, so the old execution can't go on.

A run stops for good when the journal refuses a write or stays unreachable for 30 seconds
(`REWIND_JOURNAL_WAIT_MS`). The recovery starts such a run again once nothing has written to it for
five minutes (`JOURNAL_STALE_MS`).

## Decisions

**The calling worker keeps the journal, in its preload.** The preload sees every call before it goes
out, which is what a journal needs, and it keeps the call tree and the error codes as they are.
What lost:

- Rewind's recovery, which runs an interrupted run as a copy in `rewind-f<n>` with stubs. It can't
  see an agent death at all. The engine sends no event for a call cut off by its own worker dying, so
  Rewind never gets a root for the run. After killing the agent under a burst of 12 on the project's
  stack, `rewind::lost` listed none of the interrupted runs, so Recover all had nothing to work on.
  It also asks a person at every irreversible call.
- The worker manager's middleware, which sees calls before dispatch but replaces the caller and the
  error codes (`docs/spike-0.26.md`).
- Observers, which fire only after a call ends. The burst found one more gap: an observer never hears
  of a call whose caller died before it returned, even though the callee finished it. In the
  recovery arm the model made 104 calls and observers reported 95.

**Steps are numbered in program order and checked by input hash.** Re-execution has to line saved
results up with the calls the code makes again, and numbering is the one way that keeps two identical
calls apart, such as bug 3's retry of the same send. What lost: matching calls by function and input,
the way Rewind places a replayed call. That would tolerate small code changes, but it gives the
second of two identical calls the first one's answer. With numbering, changing a durable function's
code while runs are in flight makes those runs fail as `DIVERGED`, loudly.

**Results reach the code only after the journal saves them.** If the code could go on first, a crash
between the call and the write would lose a result the run had already acted on. What lost: writing
in the background, the way Rewind records, which costs the run nothing but can't promise anything.
It costs a durable run about 2.7 ms per step and stops it when the journal is down, which is why
durable is opt-in per function.

**An in-flight step is decided by what its function declares.** A read, or an `external` call that
asks an outside service a question, is sent again. An irreversible call that takes an idempotency
key is sent again with the same key. Everything else waits for a person, who resolves it with
`journal::resolve` or on Rewind's page.
What lost: Rewind's recovery rule, which pauses at any lost call that isn't `pure` or `read-only`,
so it would also pause at a lost `external` call. The model is `external`, and most crashes land
during a model call: under that rule, 9 of the 15 runs the recovery started again, and 11 of the 17
the queue delivered again, would have waited for a person.

**The idempotency key is the workflow id and step number, and `email::send` keeps keys in SQLite.**
The key is the same in every execution of a run, so a resent step finds the first send. Keeping keys
on disk means a tools restart doesn't forget them, and a key left mid-send by a crash fails a repeat
instead of guessing. What lost: a key built from the send's content, which would also have stopped
bug 3's double invite but would merge two sends a run means to make.

**A zombie is fenced by epoch in the journal.** Each start takes the next epoch, and a write from an
older one is refused. What lost: a lease that expires unless the worker renews it, which needs the
worker to keep renewing through long calls, and leaves a window after expiry where two executions
both think they own the run.

**Both ways of starting a run again are built: the journal's recovery and iii's queue.** The probe
(`experiments/durable/q1Queue.ts`) found that queue worker 0.22.2 keeps a job whose worker died
waiting, delivers it again about 20 ms after the function registers again, doesn't count that as a
retry, and keeps the job's payload, though not its metadata. It also delivers a job again when the
handler runs past `timeout_ms` while the first attempt is still running, and it retries a handler
that throws, `max_retries` times with backoff, then moves the job to a dead-letter queue. Queue
worker 0.21.22, still in iii's package cache, never delivered the job again on 0.26, because the
engine drops the trigger frames it relies on. The default stays the recovery path, with traffic calling `agent::run`
directly. What lost: the queue path, by these numbers:

- Both finished every interrupted run, with no double invite from a crash.
- The queue path needed no help from the caller. The recovery path needed the caller to send 5 runs
  again under the same id, because they were sent while the agent was down and never reached the
  journal.
- The queue path's runs took longer as the caller saw them, 2,813 ms against 2,676 ms at the median
  with nothing killed, because the caller enqueues and then waits in the journal.
- The queue retries a run that failed in the agent's own code, since it can't tell a final outcome
  from a crash. With nothing killed, 40 queued runs became 61 `agent::run` calls, which Rewind
  records as extra failed runs with no calls.
- The queue path made 11 repeated model calls over 17 interrupted runs, the recovery path 9 over 20.

**The journal is its own TypeScript worker with SQLite, at `synchronous = FULL`.** It owns its data,
so durable runs don't depend on Rewind being up, and Rewind's recording never waits for a write. At
scale this is the transactional store behind the store workers in `docs/durable-and-scale.md`. What
lost: putting the journal in Rewind's store, which the recording path shares and which must never
block the app, and Postgres, which is another process to run on one machine.

**The preload wraps the worker instance through a loader hook.** The SDK's worker class isn't
exported, and it sets `call` on each instance, so the hook hands the worker's `import 'iii-sdk'` a
module that wraps what `registerWorker` returns. `worker.currentInvocation()` gives the run's
invocation and its caller, and the preload keeps the run's own state in an `AsyncLocalStorage` of
its own. What lost: asking the app to import a wrapper, which would change the app's code.

## What it measured

Each arm ran once: 40 runs, one every 400 ms, on the experiment's own stack
(`experiments/durable/stack/worker-compose.yaml`, which has the app, the journal and the queue, and
no Rewind). The kill arms killed the agent with SIGKILL at about 1.7 s, 6.6 s and 12.6 s into the
burst, the same moments in every arm, and compose restarted it each time. The machine is an M2 Max
shared with other work, at a load average of about 3 during the runs.

- **rival**: today's code, with no journal and nothing retried.
- **rival-retry**: today's code, with the caller starting a stopped run over from scratch, the fix a
  person would reach for first.
- **recovery** and **queue**: the journal, with the journal's recovery or iii's queue starting runs
  again.
- **journal-kill**: the journal itself killed once, 1.8 s in.
- **zombie**: the agent's connection cut for 1.5 s through a TCP proxy while its process kept running.
- The **ceiling** is every run finishing once, one invite per booking, and no model call beyond the
  uninterrupted run's.

A run is interrupted when a fault stopped one of its executions or its call. It finished when the
agent's own code ended it, which includes bug 1's SyntaxError. Model calls are counted at the model,
because observers miss the ones whose caller died. A run's uninterrupted count is the number of model
steps in its journal, or for the rivals, the model calls of the execution that finished.

| Arm | Interrupted | Of those, finished | Never finished | Booked | Bookings with two invites from a crash | Bookings with two invites from bug 3 | Invites for runs that never booked | Model calls made / uninterrupted | Repeated model calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ceiling | any | all | 0 | | 0 | 0 | 0 | equal | 0 |
| rival | 22 | 0 | 22 | 11 | 0 | 1 | 5 | 69 / 42, and 27 went to runs that never finished | |
| rival-retry | 24 | 24 | 0 | 27 | 6 | 1 | 3 | 135 / 99 | 36 |
| recovery | 20 | 20 | 0 | 24 | 0 | 0 | 0 | 104 / 95 | 9 |
| queue | 17 | 17 | 0 | 26 | 0 | 3 | 2 | 110 / 99 | 11 |
| journal-kill | 0 | | 0 | 29 | 0 | 4 | 0 | 104 / 104 | 0 |
| zombie | 11 | 11 | 0 | 24 | 0 | 3 | 2 | 98 / 97 | 1 |

The two invites from bug 3 come from one execution sending two steps, which the journal shows; the
four invites for runs that never booked in the journal arms are bug 3 too, where both sends timed out
and the model gave up. `email::send` dropped a repeated key once in the recovery arm, twice in the
queue arm and once in the zombie arm: each was a send in flight at the crash that would otherwise
have gone out twice. In the rival, 5 people got an invite for a run whose caller got an error. In
rival-retry, one run sent an invite, was killed, and its fresh start drew a cut-off answer from the
model and threw, so its caller got a SyntaxError for a meeting that was already sent.

Killing the journal stopped no run. Steps that were waiting on it while compose restarted it waited
about 0.7 s, and all 40 runs finished. In the zombie arm the journal refused 4 writes from the
cut-off handlers. Three came about 30 s after the cut, when calls whose answers the engine had
dropped reached their 30 s timeout, and one came after about 4 s, from a send with the agent's
1.5 s timeout. Each of those handlers stopped at that write.

The journal's cost, with nothing killed, against the same burst without it:

| Arm | Journal per step, ms p50 / p99 | Journal per run, begin and finish, ms p50 / p99 | Run as the caller saw it, ms p50 / p99 |
| --- | --- | --- | --- |
| no journal | | | 2,679 / 4,112 |
| journal | 2.66 / 5.37 | 3.22 / 4.31 | 2,676 / 4,873 |
| journal, started through the queue | 2.68 / 4.46 | 2.61 / 3.66 | 2,813 / 5,089 |

A step's journal time is its intent and its result, two calls through the engine and two SQLite
commits. A booked run has six steps, so the journal adds about 20 ms to a run of about 2.7 s, less
than the spread of the fake model's 300 to 900 ms answers, which is why the medians match. The p99
of a whole run is set by slow sends and model latency, not the journal.

The probes behind the decisions are in `experiments/durable`: `q1Queue.ts` for the queue,
`q2Resume.ts` for the journal on a small durable function (a kill mid-step, a kill mid-send, a
zombie, and changed code), and `burst.ts` with `allArms.sh` for the table. Their output is in
`experiments/durable/results`.

## Limits

**Workers without the preload.** Durable functions run only in Node workers with Rewind's preload.
The Rust and Go SDKs have no wrapper, and this change adds none to the Python preload, so a Python
function can't be durable. Their functions can still be steps: the agent's calls to the Python tools
are steps, because the agent's preload makes them.

**An engine crash.** It wasn't measured. When the engine dies, every in-flight call and every
undelivered observer event is lost. Workers reconnect with new ids, so the recovery's sweep would
find every running workflow's owner gone and start each one again, and the journal on disk is what
lets them go on. The queue's own store wasn't tested across a queue worker crash either.

**The journal is a dependency.** A durable run can't save, so it waits up to 30 seconds per write
and then stops; the recovery starts it again five minutes after its last write. The journal is one
SQLite file in one process, with nothing replicating it. `synchronous = FULL` waits for fsync on
every commit, and on macOS fsync stops at the drive's cache unless `fullfsync` is on, so a power cut
could lose the last writes even though a crash of the journal's process doesn't.

**Rewind and durable runs.** Rewind records each execution of a run as a run of its own, and an
execution after the first records only the calls it made live, since the journal returned the rest.
Replaying such a run in Rewind pauses or calls live where the journal's saved results belong. Rewind
should group executions by `_workflow_id` and take a step's saved result from the journal as the
recorded answer. It also can't show the execution that died, because that execution has no root
event; the journal's `executions` table has it.

**The rule for durable code.** A durable function's code may depend only on its input and on what
its calls return. That means no `Date`, `Math.random`, timers, environment reads or files outside a
call; anything that changes from one execution to the next goes through a call, the way the agent
reads the time from `clock::now` and every choice from `model::complete`. Calls started together are
numbered in program order, so `Promise.all` is fine, but a call started in a callback whose timing
depends on another call is not. A request around iii, such as the holiday fetch, runs again on each
execution, so it has to be read-only and give the same answer each time, or move behind an iii
function. Deploying new code while runs are in flight fails those runs as `DIVERGED`. The agent
already follows all of this; its header says it never reads the clock or draws a random number.

**What the ceiling would need.** The one repeated call left is the model call in flight at the
crash. The model finished it, and the engine dropped the answer with the dead caller. Saving it would
take the callee keeping answers by key, the way `email::send` now keeps sends, or the engine
delivering a finished call's answer somewhere other than its dead caller. Bug 3 stays until the agent
stops retrying a send without a key of its own.

**What I would try next.**

- Give `model::complete` an idempotency key too, as a cache by step key, and see the repeated model
  calls go to zero.
- Teach Rewind to read the journal, so a resumed run replays as one run.
- Kill the queue worker and the engine mid-burst, which these runs didn't.
- Port the wrapper to the Python preload, which has `iii.current_invocation()` and could wrap
  `register_function` and `call` the same way.

## Pausing a run

A durable run can stop on purpose and wait: for a value from outside, such as a person's approval,
with an optional timeout, or for a set time. Once the journal has saved the waiting step, the run
continues exactly once after the step gets its value, with that value, on whichever worker hosts
the function then. Nothing runs the run while it waits. The handler has returned, and its worker
keeps no memory, no running handler and no open call for it, so the worker can die and the journal
can restart in the meantime. A value and a timeout racing for one wait can't both land, a value sent
before the run reaches its wait is kept for it, and a second value is refused. The words are the
ones iii's harness uses for a tool call that parks a turn: the waiting step is pending, and something
resolves it with a value. The agent uses it with `approval: true`, to wait for a person before each
invite, and [the pause flow](flows/pause.md) walks through it.

In the probes, a run whose worker was killed while it waited for approval finished once with one
send after it was approved, and so did all 28 of the agent's runs that parked before their invite
when the agent was killed under them. A 10 s sleep woke 8 ms after its wake time though the journal
was killed 3 s in. With 200 runs waiting, the worker had no handlers running and the caller no open
calls, and all 200 finished once after their values arrived, half of them after the worker was
killed. The rival, a handler that awaits a promise, lost every run its worker died under, dropped a
value that came early, and left all 200 of its callers to time out after 30 s.

### How a wait goes

1. The run's code calls
   `worker.call({ function_id: 'durable::wait', payload: { name, timeout_ms, detail, choices } })`.
   Only `name` is needed. `detail` and `choices` are for the person who resolves it: the agent
   passes the invite it is about to send, and Approve and Decline.
2. The preload checks the arguments, takes the next step number, and checks the step against a
   saved one the way it checks any call. When an earlier execution already has the wait's result,
   the code gets it without asking anyone.
3. Otherwise the preload calls `journal::park`. In one transaction the journal fences the epoch and
   looks for a value already sent to the wait's name. When there is one, it becomes the step's
   result and the code goes on at once. When there isn't, the step is saved as pending with its
   deadline, `now + timeout_ms`, and the workflow becomes `waiting` with no owner.
4. The preload marks the run stopped with `WAITING`. The wait throws, every later call in the
   handler throws whatever the code does with the error, and the handler returns
   `{ pending: true, workflow_id, waiting_for }`. A call that was already out finishes, and the
   journal still saves its result, but it refuses any new step with `WAITING`.
5. Nothing runs the workflow. The recovery sweep only takes workflows that are running, and the
   journal keeps one timer set for the next deadline in its `pending` table, read again each time
   it starts.
6. Someone calls `journal::resolve` with `{ workflow_id, name, value }`, or with the step's number
   in place of the name. In one transaction the journal saves `{ timed_out: false, value }` as the
   step's result, keeps the value under the name, ends the pending, and sets the workflow running
   with no owner. When the deadline comes first, the journal's timer does the same with
   `{ timed_out: true }`, and a resolve after that returns `{ resolved: false, reason }`.
7. The journal calls the function again at once with the workflow's input and `_workflow_id`, the
   way recovery does, without waiting for the sweep or the queue.
8. The code runs again from the top. Every finished step returns its saved result, the wait
   included, and the run goes on from the wait.

`durable::sleep` with `{ ms }` goes the same way, with a wake time for its deadline and `{ slept_ms }`
for its result. A step a crash cut off, which can't be sent again safely, is one more pending step,
of kind `lost`, that `journal::begin` leaves for a person. `journal::resolve` sends it again with
`action: "execute"`, or takes a `value` or an `error` as its result. That replaced `journal::answer`
and the `paused` status, which only the journal's unit tests used. Rewind's page lists every
waiting run under Waiting, one row for each thing runs wait on, and opens each run on its one
question: the wait's choices, a value, Wake now, or Send again and Enter its result.

### Decisions

**A pause is a step, and the run starts again from the top.** The journal already knows how to
start a run again and hand it saved results, and a wait that is a numbered step gets the replay
check, the fencing and the crash handling of every other step for free. What lost: resuming the
handler where it stopped. JavaScript can't save a stack, so that would mean keeping the handler in
memory, which is the rival, and it dies with the worker.

**A parked handler returns `{ pending: true }` rather than throwing.** That is the shape iii's
harness uses for a trigger whose result comes later. Thrown, the stop reaches the caller as
`invocation_failed`, because the SDK replaces the code of an error a handler throws, and the queue
retries a run that throws, up to `max_retries`, then dead-letters it. What lost: an answer the
caller can't take for success. A caller that ignores the shape sees a success with no booking, so
`traffic::burst` and the e2e check look for `pending`. The agent's response format doesn't list it,
since every durable function can return it.

**A wait's value is kept by the wait's name, once per run, even when it comes early.** A sender
then needs only the workflow id and the name, which a caller picks, and not the step number, which
only the run knows. A value sent before the run gets there is kept, and a second wait with the same
name gets the same value. What lost: a value per step, which would make every sender wait until the
run has parked and look up its step, and a queue of values per name, the way Temporal's signals
queue up, which a loop could read one at a time.

**The value and the timeout race in one SQLite transaction.** better-sqlite3 runs the journal's
transactions one at a time, and both the resolve and the timer insert the wait's row in
`wait_values`, keyed by workflow and name, in the same transaction that saves the step's result. The
second one finds the row and changes nothing. What lost: a timer in the worker, the way the rival
races its promise against `setTimeout`, which dies with the worker.

**Deadlines are rows in the journal, with one timer for the next.** The journal reads the next
deadline from SQLite whenever it starts or something parks or resolves, so a deadline outlasts a
restart and fires within milliseconds when the journal is up. What lost: polling every second, which
is up to a second late, and a delayed job on iii's queue, which would put a second store in charge
of when a run wakes.

**A cut-off step is one more pending step.** A crash that leaves an irreversible call in doubt and
a wait for approval both need a person to give a step its result, so they share the journal's
pending table, `journal::resolve` and the page. What lost: `journal::answer` and the `paused`
status. Nothing outside the journal's unit tests called `journal::answer`, so it is gone rather than
kept as a second name.

**Rewind's page calls the journal directly.** The page reads `journal::list` and calls
`journal::resolve` over the console's connection, and reads the list again after each `run` event
Rewind sends, since a run that parks or goes on ends an execution Rewind records. Rewind's core is
unchanged. What lost: going through Rewind's core, which could group a waiting run with its
recorded executions, for more Rust and no new behavior on the page.

**`durable::wait` and `durable::sleep` are also functions in the journal, and not internal.** A call
that reaches them came from outside a durable run, so they fail with an error saying so instead of
leaving the caller with `function_not_found`. Because they aren't internal, the engine lists them,
Rewind stubs them in its copies, and a replay of a run that waited pauses at the wait for a person.
The first e2e run found the other way: marked internal, a check of an approval run failed inside the
copy with `function_not_found`. What lost: keeping them out of Rewind's function list, where they
now show up with no declared effects.

### What it measured

Each part ran once, on final code. Parts 1 to 5 ran in `experiments/durable/q3Pause.ts`, on a probe
engine of their own: a `pauser` role with the preload and the journal, and a `rival` role whose
handler awaits a promise until the value arrives, with the same callee, the same steps and the same
`--expose-gc`. The agent row ran `q4Approval.ts` on the experiment's stack: 40 runs of
`agent::run` with `approval: true`, the agent killed with SIGKILL while those that parked waited,
and every parked run approved after compose restarted it. The ceiling is every run continuing
exactly once after its value arrives, with no duplicate sends. The machine is the same M2 Max, at a
load average of about 3.

| Measurement | Ceiling | Pause, with the journal | Rival, awaiting in the handler |
| --- | --- | --- | --- |
| 1. The worker dies while a run waits for approval, then it's approved | finishes once, one send | Finished, 2 executions, 1 send. The second execution began 5 ms after the resolve | The caller got `invocation_stopped`. The resolve after the restart didn't find the run. Never finished, 0 sends |
| 1, the agent: 40 runs, the agent killed while 28 waited | 28 booked, 28 single invites | 28 of 28 resolved, done and booked, 2 executions each, 0 invites while waiting. Every booking got one invite per `email::send` step: 22 got one, and 6 got two from two steps, the agent's own retry of a slow send (bug 3). 0 from the kill or the resume | not run |
| 2. A 10 s sleep, the journal killed 3 s in and back 2 s later | wakes on time | Woke 8 ms after its wake time, `slept_ms` 10,002 | Its worker killed 3 s in: `invocation_stopped`, never woke |
| 3. A 2 s timeout and no value, then a late value | the timeout wins, the late value is refused | `{ timed_out: true }`, the late resolve `resolved: false`, 0 sends | The same while its worker lives |
| 3. 40 waits, each resolved between 150 ms before and 150 ms after its 1 s timeout | one result each, and the resolver told which | 20 values won and 20 timeouts. The resolver's answer matched what the run got in 40 of 40, every run has one recorded value, 20 sends | not run |
| 4. The value sent while the run is still thinking, before its wait | used at the wait | `resolved: true, resumed: false`. The run never parked: 1 execution, 1 send | `resolved: false`, the value dropped. The run timed out 5 s later, 0 sends |
| 5. 200 runs waiting at once | the worker keeps nothing, each continues once | 200 parked in 176 ms. 0 handlers running, 0 calls open. Heap after a GC 17.68 → 17.94 MB. 100 resolved, the worker killed, 100 more resolved: 200 of 200 done, each sent once, 0 repeats | 200 handlers running and 200 calls open. Heap 15.96 → 17.13 MB. All 200 callers timed out after 30 s while the handlers still waited. 100 resolved and sent with no caller left, the worker killed, the other 100 lost |

Memory isn't where the rival hurts at 200 runs: its waiting handlers cost about 1.2 MB of heap, and
the pauser's heap grew 0.26 MB. RSS went the other way, 93.8 → 105.1 MB for the pauser against
90.7 → 94.8 MB for the rival, because the pauser's handlers all ran and returned in the same 176 ms,
and V8 keeps the pages it grew into. The agent's RSS went from 118 MB, read before its first run, to
156 MB with 28 runs waiting, which mixes warming up with anything held; that is why the probe reads
the heap after a GC. What the rival keeps that matters is a running handler and an open call per
run, which time out at 30 s and die with the worker. The pause's cost is a restart of the run per
wait: the second execution replays every step before the wait from the journal, and in the agent
the 28 resumed runs were all done 2.8 s after the resolves.

The probes' output is `experiments/durable/results/q3Pause.txt` and `q4Approval.txt`, with the
numbers in the matching `.json`. Screenshots of the page before and after a run is approved are
`pause-waiting-run-before-dark.png`, `pause-waiting-run-after-dark.png` and their light versions,
and `pause-landing-dark.png` shows the Waiting row on the landing.

### Limits

**Only Node workers with the preload can pause.** Anywhere else, and outside a durable run, a call
to `durable::wait` or `durable::sleep` fails at once with an error saying it only works inside a
durable run. The preload throws `NOT_DURABLE` when there is no run, and the journal's own
`durable::*` functions fail the same way for a worker without the preload.

**A pause restarts the run.** Every step before the wait replays from the journal on the way back,
which costs the run little, but requests around iii, such as the holiday fetch, run again, and so
does any code between them. A sleep of a few milliseconds costs the same restart.

**The caller gets `{ pending: true }`.** The run's output is in the journal, where `journal::wait`
returns it once the run ends. `journal::wait` returns as soon as a run waits, so a caller that wants
the output after a pause asks again.

**One value per name, and one pending step at a time.** A second wait with the same name gets the
first one's value. Two waits started together park at the first, and the second parks when the run
comes back to it.

**Nobody checks who resolves.** Anyone who can call functions on the engine can call
`journal::resolve`. A value sent to a workflow id that doesn't exist yet is kept for it, so a typo
is kept too, and the reply says `resumed: false`.

**Deadlines depend on the journal's process.** A deadline that passes while the journal is down
fires when it comes back, and a run whose function isn't hosted then waits for the sweep.

**Rewind and paused runs.** Rewind records the execution that parked as a run that returned
`{ pending: true }`, and the execution after the resolve as another run. No recording has an answer
for the wait, since the preload handled it, so a replay, fork or check pauses there and a person
types its value. The page resolves one run at a time.

**What I would try next.**

- An Approve all on the page for a group of waiting runs, with the same one-decision shape the
  Interrupted groups use.
- A token per wait that the resolver has to send, so only whoever the run asked can resolve it.
- Waits for several values at once, so `Promise.all` of two waits parks once.
- A `journal::wait` option that waits through pauses to the run's end, so a caller asks once.

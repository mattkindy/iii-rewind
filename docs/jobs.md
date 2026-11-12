# What people use Rewind for

The main user is a developer working on a worker, usually against a local or staging engine. The
second is whoever is on call after an incident, who needs to know what was interrupted and finish it
safely. Both already have the ADE's traces view, which shows what happened. Rewind is for the
questions that come after that.

## Jobs

Ordered by how often they come up.

1. **Reproduce a failure I can't trigger again.** When a request failed because of an answer that
   won't come back (a model's output, a vendor's reply, the time), I want to run it again exactly
   as it happened, so I can watch it fail on my machine.
2. **Find which answer caused it.** When I'm looking at a failed run, I want to be shown the call
   whose answer led to the failure, so I don't read every span.
3. **Try a different answer.** When I have a theory about the cause, I want to change that answer
   and see what the code does next, so I can confirm the cause before I write a fix.
4. **Check my fix.** When I've changed the code, I want to run it against the failing request, and
   then against every recorded run that failed the same way. That way I know it's fixed and
   nothing near it broke.
5. **Keep it fixed.** When the fix works, I want the failing run saved as a test, so that a later
   change that breaks it again fails `npm run saved-tests`, which replays every saved test against
   a running stack.
6. **Finish work a crash left behind.** When a worker died mid-request, I want to see which
   requests were interrupted and finish them, without sending anything twice.
7. **See what a change would change.** Before shipping a worker, I want to replay recent traffic
   against the new version and see which outputs differ.

Browsing every recorded call as a log isn't on the list. Traces already does that.

## Flows

Each step is one screen that answers one question. Anything the step doesn't need stays collapsed.

### A. From a failure to its cause (jobs 1 and 2)

1. **What needs attention?** The landing lists failures grouped by how they failed, with a count,
   a one-line explanation and how recent the newest one is. Runs a crash interrupted are listed
   here too, above the failures, because they're waiting on someone.
2. **Did it fail like this one?** Opening a group opens its newest run. The calls read top to
   bottom, and the call right before the failure is already open, showing its answer and why it's
   the suspect.
3. **Does it reproduce?** Replay runs the agent's code with the recorded answers. The result says
   "Reproduced: same failure, every answer from the recording", or says where it diverged.

The flow is done when the person has read the suspect answer and seen the failure reproduce.

### B. Try a different answer (job 3)

1. From the open suspect call, **Edit answer** opens an editor on that answer, with the
   recording's version kept for a diff. When the function declares a response schema, the editor
   is a form of it, with the JSON one tab away, and each field says what is wrong with it. A
   model's tool call shows its arguments as a form of the called tool's input, so a cut-off answer
   is fixed by filling in the fields the cut took, and a duration sent as a string shows as an
   error on the duration field. While the answer breaks the schema, Fork reads **Fork anyway**,
   because seeing how the code copes with such an answer is a reason to fork too.
2. **Fork** runs the code with the edit, all the way to its end. A call the recording doesn't have
   runs live when its effects allow it. A call that can't run live, such as an irreversible send,
   gets the newest successful answer that function gave in another run, and nothing is sent.
3. The person lands on the outcome: booked, failed, or crashed. One line above the calls sums up
   the path it took, such as "Booked · 3 live · email::send filled from run 849b62e0", and each new
   call is marked Live, Filled, Recorded or Edited. **Compare** lines it up against the original,
   call by call.
4. If an answer on that path looks wrong, opening the call offers **Change answer**, which forks
   again from that call.
5. To decide a call by hand, the person sets a stop on its function, by clicking the call's number
   or from **Stops** in the run's toolbar. The fork runs again and pauses there. The call opens with
   the choices its effects allow, and the reason any choice isn't offered. A typed answer is the
   same form, starting from another run's answer or an empty one that fits the schema. Stops stay
   on the run while the page is open.

The flow is done when the person knows whether that answer was the cause.

### C. Check a fix (jobs 4 and 5)

1. The person edits the agent's code in their editor. Rewind notices the change and says the
   agent's code has changed since the recording.
2. **Replay with current code** runs the failing run against the new code. The outcome shows
   beside the recorded one.
3. **Check similar runs** replays each run in the failure group against the new code, with
   no live calls. Each run comes back as one of three results: same as recorded, different
   outcome, or stopped at a call the recording doesn't have. A fix usually makes a new call, so
   every run stops at the same place. That means the code now takes a new path there, and the
   recording can't say what happens next.
4. **Run new calls live** checks the group again, this time running the new calls whose effects
   allow it. An irreversible call never runs; it gets a recorded success from another run, and the
   result says so. The results now read as outcomes, such as "9 now book, 3 fail on another bug".
5. **Save as test** writes the run's input, what each call sent and got back, and the new expected
   outcome to `tests/rewind/`.

The flow is done when every run in the group comes back fixed and the test is saved.

### D. Finish work a crash left behind (job 6)

1. The landing shows "5 runs · tools stopped 15:04" under Interrupted.
2. Opening it lists the runs, with one line on what recovering does: it replays the calls that
   finished, runs read-only and external calls live, such as the model, and asks before the rest.
   **Recover all** recovers every run, four at a time.
3. Runs whose remaining calls are safe to run finish on their own. The rest wait at an
   irreversible call, in two groups. A send interrupted mid-call may have reached the provider, and
   nobody can tell whether it did. A send the recovery reached afterwards never went out, and
   neither did a send the run made after the worker was already gone, which failed with
   `function_not_found`. Both of those are in the second group.
4. Each group gets one decision for all its runs. Interrupted sends start on **Mark all sent**, which
   gives each run the result the same function returned in a recorded run. **Resend all** asks
   first and says how many could be duplicates. Sends that never went out start on **Send all**.
   Either group can be skipped, or answered one run at a time.
5. The page sends the decision to four runs at a time and says how they ended, such as "3/3
   marked sent · 3 booked". A run that fails doesn't stop the others, and it's listed with a
   retry at the end.

The flow is done when every interrupted run is finished or deliberately skipped.

### E. See what a change would change (job 7)

1. **Check against current code** replays the last N recorded runs against the current code.
2. The summary counts runs that came out the same, runs with a different outcome, and runs that
   stopped at a call the recording doesn't have. Noise fields are ignored.
3. Each changed run opens straight into compare.

## What this asks of the page

- The landing is a list of things that need attention, not a run log.
- A run opens with the suspect call already open. "Edit answer" is the one primary action, and
  "Replay" is beside it.
- Replays without an edit are results, not branches. Only forks someone made appear as branches.
- A fork lands on its outcome, with the path it took marked. It asks the person something only at
  a stop they set, or at a call nothing can answer.
- Ids, timing, seq and the raw observe event live behind "Details".
- The page says which version of the agent's code a replay ran, and when that code changed.

## What this asks of the core

- **Run the current code.** A replay or a fork runs the agent's code as it is on disk. When the
  source has changed since a copy started, Rewind stops that copy and starts a new one before the
  next rerun, and it reports the code version on each fork.
- **Check a group of runs.** A function that replays a list of runs against the current code and
  returns one result per run: same, different, or stopped at a call. By default it makes no live
  calls. Asked to, it runs the calls whose effects allow it, and fills irreversible ones with a
  recorded success instead of running them.
- **Find a run from traces.** Search accepts an invocation id, so an id copied from the traces
  view finds the run.
- **Run a fork to its end.** With `auto` on, a call the recording doesn't have runs live when its
  effects allow it, and gets another run's newest success when they don't. The fork pauses only at
  a function in its stops, or when there is nothing to fill from. Changing the stops reruns the
  fork. It keeps every answer a person or the recording gave, and decides the rest again.

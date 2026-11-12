# Rewind in the console

Rewind's page is built as levels. Each level answers one question, each click goes one level down,
and Back goes one level up, at every pane width. The page never shows a list, a run and the details
of a call all at once. The jobs and flows the levels serve are in `docs/jobs.md`.

| Level | The question it answers |
| --- | --- |
| Needs attention | What is waiting on me? |
| Waiting | Which durable runs wait for this, and for how long? |
| One waiting run | What should this run get? |
| One run | Which answer caused this failure, and does it reproduce? |
| Interrupted | Which runs did a dead worker cut off, and can they be finished? |
| One interrupted run | What finished, what was cut off, and what should happen to the irreversible call? |
| Check | Does the current code fix every run like this one? |
| All runs | Where is the run I copied from traces? |

## Needs attention

A slim strip at the top shows the last minute of runs as dots, newest on the right, in the colour of
how each one ended, with "Recording · 12/min" beside it. It is the one thing on the landing that
moves, and it stops when no runs arrive.

Durable runs waiting on a pending step come first, under Waiting, one row per thing they wait for:
"Waiting for approval" with "3 runs · oldest 4m ago · first times out in 26m", "Cut off mid-call ·
billing::charge" for calls a crash cut off, and "Sleeping" with when the next one wakes. The page
reads them from `journal::list` and reads again after each `run` event, since a run that parks or
goes on ends an execution Rewind records. Without the journal the section isn't there.

Interrupted runs come next, because they are waiting on someone too. Under the Interrupted heading,
the row reads "12 runs · tools stopped 21:45". The page reads which worker stopped from the run's
output, where the agent passes on the `invocation_stopped` or `function_not_found` error, and falls
back to "a worker". Runs that one worker cut off, and that ended within five seconds of each other,
are one incident. The newest incident gets the row, and earlier ones fold under "3 earlier
incidents"; each opens Interrupted for that incident only. Failures follow, grouped by how they failed, each with a count, one plain line
and how long ago the newest one ran. A group opens its newest run. All runs and Check against
current code are quiet buttons under the list.

The landing reads every run once, 500 at a time, passing the oldest start on each page as
`before_ms` for the next, and then adds each new run from its `rewind::changed` event, so a count
only grows while traffic runs. A count steps up to its new value, a row whose count grew is lit for a
moment, and a new row rises into place.

When the core reports the code on disk (`status.target_code`) and recorded runs ran an earlier
version, a note at the top offers to check them. Without `target_code` the page hides every control
that needs `rewind::check`, so an older core shows flows A, B and D and nothing broken.

## Waiting

A Waiting row opens the runs that wait for that thing, oldest first, each with the request in the
person's words, its workflow id, how long it has waited and when it times out or wakes. One line
under the heading says what resolving does, such as "Each run goes on from where it waited once it
gets its answer".

A waiting run reads top to bottom, like an interrupted one. The first step says what it waits for,
"Waiting for approval · Since 4m ago · times out in 26m". When the wait's `detail` is a call,
`{ function_id, input }`, the step shows that call's input under "Before email::send", which for
the agent is the invite about to go out. The last step is the one question, Answer: one button
per choice the wait offers, the first one primary, or a JSON editor and Resolve when it offers
none. A sleep offers Wake now. A call a crash cut off offers Send again and Enter its result,
with neither picked, since only a person knows whether the call did its work. The page resolves
the step with `journal::resolve` by its number, then waits up to 20 s on `journal::wait` and puts
how the run went on in place of the question: "Run booked · Booked Tuesday 17 Nov at 3:30 pm with
Dana and sent the invite", "Waiting again", or the error. A resolve the journal refuses, because
the timeout came first or someone else answered, shows "Not resolved" with the journal's reason.

## One run

The request in the person's words and when it ran. Under it the calls read top to bottom at full
width, each with its worker's glyph and name, the answer in one line, and a number counted from 1.
Seq never appears. The last row says how the run ended.

The likely cause is open when the run opens. An open call is one raised block with its row:

1. A "Likely cause" callout with one line, such as "Run threw SyntaxError after this answer ·
   tool_call.args: JSON cut off at 63".
2. The answer. JSON text inside the answer, such as cut-off tool arguments, is shown as text in a
   block of its own, marked where parsing stops.
3. Edit answer, the one primary action, with Replay beside it. Fork with error and Copy answer are in
   the menu next to them.
4. Details, closed: worker, effects, timing, the invocation id, the input, and the event as the
   observer recorded it.

A call with `inferred` text says why the caller saw something different from the callee, such as the
timeout that made `email::send` run twice.

### Schemas

Functions register a `request_format` and a `response_format`, which are JSON schemas, and the page
checks each recorded call against them. A call whose input or output breaks its function's schema
has a "Schema" chip, with the first problem in its tooltip: "Input · duration · expected integer,
got string". When the call that failed after the likely cause broke its input schema, the likely
cause says so on a second line, "calendar::find-slot input · duration · expected integer, got
string", which is how bug 2 reads. The page checks the subset of JSON Schema the sample app uses:
`type`, `properties`, `required`, `enum`, `const`, `items`, `minimum`, `maximum`, the `date`,
`date-time` and `email` formats, and `oneOf` or `anyOf`. It passes over anything else, so a richer
schema is checked less strictly, never more.

When the run failed inside a worker, the open likely cause also says where. The page reads
`rewind::spans` for the call someone opened, and for the call that failed after it or the run itself
when the agent threw, and shows the traced function that threw: "parseArgs threw SyntaxError in
agent" for bug 1, "find_slot threw TypeError in tools" for bug 2. What the function was given is
behind a disclosure. Spans are only read for an open call.

### Requests around iii

A request the agent makes outside iii, such as its fetch of the holidays API, is a row of its own:
"GET 127.0.0.1:49335/holidays?…" with a globe, which no worker gets, and "outside iii" where the
worker's name would be. The full URL is in the tooltip and in the open call. Its answer reads as the
status and a few words about the body, "200 OK · from 2026-11-06, to 2026-11-19, holidays (1)". A body
that is JSON shows parsed everywhere, including the editor, so JSON text never shows inside JSON.
A request doesn't decide what the next call is sent, so it is passed over when the page looks for
the likely cause. A call whose worker made a request, such as the POST to the email provider under
`email::send`, lists it in the open call with its request and response, and has a small ring on its
waterfall bar where the request went out.

Show workers (Alt+W) draws the same rows on lanes, one per worker, for when it matters which worker
called which. Below 560 px the calls stay a list.

### Replay and the code on disk

Replay is a result on the original, not a branch. It says "Reproduced · threw SyntaxError", or what
it did instead. When the agent's code changed since the run was recorded, a note says so and offers
Replay with current code and Check similar runs. A replay that reaches a call the recording lacks
diverges: "Replay diverged at call 3 · model::complete". Opening it makes it a line in the switcher
so its new calls can be answered, and once it finishes it can be saved as a test.

### Forks

Edit answer opens an editor on the answer, with a quick fix for cut-off JSON and a diff against the
recording. When the function has a response format, the editor is a form, with JSON one tab away,
and both tabs edit the same text. The form has one field per property: a select for an enum, a
switch for a boolean, a number field, and a text field with the format in its placeholder. Nested
objects are indented groups and lists are repeatable groups. A field's description is its tooltip, a
required field has a star, and what is wrong with a field shows under it, such as "duration ·
expected integer, got string". A number field shows a string in quotes, so `"45"` can't pass for a
number. While the answer breaks the schema, Fork reads "Fork anyway", with the first problem in its
tooltip, because seeing how the code copes with such an answer is a reason to fork. Fork stays
disabled only while the text isn't JSON or matches the recording. Without a response format the editor is the JSON editor alone.

A model's tool call, `{ tool_call: { name, args } }`, shows `args` as a form of the called tool's
request format, whether the model sent an object or JSON text, and the form writes an object back.
Cut-off text shows as text, marked where it stops, until Close cut-off JSON parses what is there
into the form. The fields the cut took are marked "Cut off" until they have a value again, which
is how bug 1 is fixed. The engine reports a schema's keys in alphabetical order, so a form lists
required fields first, in the order `required` gives them.

Fork (Mod+Enter) runs it with `auto` on, so the fork goes to its end by itself. A call the recording lacks runs live when its effects allow it, and otherwise gets another
run's newest success, so nothing irreversible is sent. The person lands on the ending. A line above
the calls says the path the fork took, "Booked · 3 live · email::send filled from run 849b62e0",
and each call from the edit on has a chip saying where its answer came from: Live, Filled,
Recorded, Edited, Typed or Injected error. A live or filled call opens with Change answer in place
of Edit answer, and a filled one says which run it came from. Change answer forks again from that
call.

Stops are where a fork pauses, the way breakpoints are. Clicking a call's number toggles a stop on
its function, drawn as a dot in the gutter, and Alt+B toggles the one at the cursor. Stops in the
run's toolbar lists every function the run calls, with what a fork does there, such as
"irreversible · filled". Stops belong to the run while the page is open, and every new fork takes
them. Changing them reruns the fork on screen with `rewind::fork-set`, which keeps every answer a
person or the recording gave.

A fork that pauses opens only that call. A stop reads "Stop · email::send", and a call nothing
could answer reads "No recorded answer". The call lists every choice its effects allow. Choices
the effects rule out stay visible, disabled, with the reason, such as "Irreversible". Type answer
uses the same editor as Edit answer, with the pause's `response_format`, or else the function's.
It starts from the newest answer the function gave in another run, and when there is none, from
an answer that fits the schema, with each enum's first value and empty strings. Continue reruns
the fork. It stays disabled while a typed answer isn't JSON, and reads "Continue anyway" while the
answer breaks the schema. A replay runs without `auto`, so one that diverged pauses at its first new call,
and its copy says replay.

The switcher (Original, Fork 1 with its outcome, Compare) appears once someone has made a fork. A
banner states both endings, "Fork 1 returned booked · original threw SyntaxError", with Compare and
Save as test. Compare lines the two runs up call by call and marks what changed. The branch
graph is a toggle on the switcher, for runs with forks of forks.

### Playing a run back

The play button in the run's toolbar (Alt+V) puts a player in place of the call list, for the line
on screen. The player has a waterfall of the calls on one time axis and the run's workers on a ring,
and both follow one playhead. The scrubber above the waterfall has a dot where each call starts, in
its worker's colour, and a diamond where a fork starts to differ. A long call plays at its own pace,
so a 600 ms model call takes 600 ms at 1x, and anything shorter is slowed down until it can be seen.
Selecting a call or a worker moves the playhead there, and closing the player opens the call list at
the call the playhead stopped on. With reduced motion the player steps from one call to the next.

The ring starts with the entry worker alone, and each other worker joins when the first call to it
leaves. A host a request went to joins the same way, as a dashed node labelled outside iii. On the
recording, a worker that went away during the run is dimmed until a worker with its name connects
again, and the ring of the call it was running breaks. That comes from `worker_changes` on
`rewind::run`, so forks, which run against stubs and copies, never show it. A call interrupted when
its worker died has no record, so the player puts it in the gap where the run was interrupted, using
the function the run's output mentions, and labels it "Interrupted · tools stopped". A call that failed with `function_not_found` because its worker was already
gone takes no time there, and reads "Not found · tools was down".

The recording plays as recorded. A fork plays as its latest rerun ran, from each call's
`rerun_at_ms` and `rerun_ms`, so recorded answers come back at once and a call the stub holds for a
caller's timeout runs on past the end of the rerun. A core that doesn't time reruns leaves those
out, and then the player places a fork's new calls one after another, live calls at their measured
duration and typed answers at zero, and says "Estimated timings". Each worker's
language comes from the runtime `engine::workers::list` reports for it.

## Check

A check replays runs against the code on disk with one `rewind::check` call per pass. Progress comes
from the `check` events on `rewind::changed`.

1. The first pass gives every call its recorded answer. A fix usually changes the code's path, so
   every run reaches a call the recording does not have, and the page says so in one line: "All 23
   diverge at call 3 · model::complete". The 23 identical rows stay behind Show 23 runs, and runs
   that ended the same as recorded stay behind a button of their own, so the runs that changed come
   first.
2. Run new calls live starts the second pass. One line says what it does, from the effects each
   function declares: "Live: model::complete, read-only calls · email::send not sent · filled from
   another run".
3. The live pass reads as outcomes: "19/23 fixed · 19 booked, 4 failed". Runs that still fail come
   first, with the reply that says why, which is how the check finds a second bug such as the string
   duration in `calendar::find-slot`.

A run opened from the first pass replays at once: one that ended differently opens in compare, and
one that diverged opens paused at the new call. A run opened from the live pass shows how the check
ended it, because a check is not kept as a fork.

Check against current code on the landing is the same view over the last 25 runs.

## Interrupted

Under the incident's heading, "12 runs interrupted · tools stopped 21:45", one line says what
recovering does: "Replays calls that finished · runs read-only and external calls live · asks
before the rest". Every Recover run button has the same line as its tooltip. Recover all has no tooltip,
because the line is right above it.

Recover all recovers the incident's open runs four at a time, with progress such as "Recovering
2/5", and finishes the runs whose remaining calls are safe. A recovery runs live only calls whose
effects are pure, read-only or external, and pauses at anything else: an irreversible call, a
write, or a function that declares no effects. The call the worker died while running pauses too,
unless it only reads. The paused runs split into two groups by `need.reason`, and each group gets
one decision for all its runs:

- Interrupted mid-send: the recovery paused at a call the worker died while running (`lost`), so the
  provider may already have it. The choices are Mark all sent, Resend all, Skip all and Choose per
  run, and it starts on Mark all sent. Mark all sent gives each run the newest result the function
  returned in a recent recorded run, the same answer Already sent starts from on one run, and its
  description says which run that was. Resend all asks first: "Resend 3 · up to 3 duplicates".
- Not sent yet: the call never went out (`no_answer`). Either the recovery reached it after the
  interrupted call, or it is the interrupted call and it failed with `function_not_found`, because
  the run made it after the worker was gone. The choices are Send all, Skip all and Choose per run, and it
  starts on Send all.

The line under a group's heading says which function it is, "email::send · the provider may have
it". A function that declares no effects gets the "Effects unknown" badge, and its group starts
with nothing picked. The page applies a decision with `rewind::answer`, four runs at a time,
with progress such as "Marking sent 2/3", and a run that fails doesn't stop the rest. The result
counts how the runs ended, "3/3 marked sent · 3 booked", and lists any run that failed, with its
error and a Retry. A run that pauses again at a later irreversible call joins the group it now
belongs to. Choose per run lists the group's runs, and each opens the decision for that run alone.

While Recover all or a group's decision runs, its progress takes the place of the open runs or of
the group's choices. A bar with one segment per run fills as each run finishes, colored by how it
ended, and a tally such as "2 booked" grows under it. Each run is listed as waiting, running or
finished. Each running one has a spinner, the seconds so far and what it is doing, from what the
page knew before it started: "Replaying 2 calls, then picking up at calendar::find-slot" for a
recovery, and "Giving email::send its recorded result, then running the rest" for Mark all sent. A
finished run says how it ended ("booked", "paused at email::send", or its error), lights up for a
moment, and moves to its new list on the page. With reduced motion nothing animates.

A waiting run reads top to bottom: what completed before the worker stopped, what was cut off,
what Rewind ran live, and the irreversible call, with its input and the choice to send it or skip
it. At a call interrupted mid-call, the heading says "Interrupted mid-call · the provider may have
it", Send now says "Check the provider first", and Already sent says "If it went through, enter
its result". At a call that never went out, Send now says "Not sent yet" and Already sent says
"Enter its result without sending". When the interrupted call failed with `function_not_found`
(`mid_call: false`), the cut-off step says so: "email::send not found after 4 calls · worker was
down". The choice starts on Skip run, so nothing is sent until a person picks Send now. A waiting
call whose function declares no effects has an "Effects unknown" badge, Send now says "Effects
unknown · may repeat a side effect", and it starts on Skip run too. A recovery runs without
`auto`: a filled send would let the run finish without the invite ever going out.

The core deletes a recovery someone skips, which makes the run look unrecovered again. So the page
remembers which runs were skipped while it is open: it lists them under Skipped, leaves them out
of Recover all, and drops the incident from the landing once every run is recovered or skipped.

## Sync with Traces

Each step is one click from its span in Traces. A call's function name is a link to it, in a call
row, in an open call's row and in the player's waterfall: it underlines on hover, and a click on it
shows the span while a click anywhere else on the row still opens the call. Every call row and the
ending row also has a Show in Traces button at its end, which shows on hover and keyboard focus the
way DevTools shows "Reveal in Network panel", and Alt+T does the same for the selected row. A call
Rewind has no trace id for shows its name as plain text and its button disabled, each with "No
trace id" in the tooltip. Each run is the root of its own trace, so the trace that opens shows
only that run.

The Traces button in Rewind's header turns syncing on and off. Turning it on puts Traces beside
Rewind if it isn't open. While it is on, the call at the cursor shows in Traces: a call row opens its
trace and selects its span, the ending selects the run's `agent::run` span, and a fork's calls,
its pause and the player's playhead all move the selection in that rerun's trace. A console with
`host.traces.focus` selects the span. Released consoles don't have it, so the page clicks a hidden
`@trace` mention instead, which opens the trace without selecting the span. The tooltips of the
sync button, a function name and Show in Traces say so: "Opens the trace · no span selection".
The page clicks the mention only once the console has found the trace. Traces doesn't open a trace
its filters hide, and its default view hides traces without a session, which is every trace
`traffic::burst` makes, so the sync button's tooltip also says to clear the filters if nothing
opens. The call menu has Show in Traces too, disabled with the reason when Rewind has no
`trace_id` and `span_id` for the call.

Clicking a hidden console element depends on the console's internals, so it has a switch: setting
the localStorage key `rewind:feature:trace-mention-click` to `off` turns it off. On a console
without `host.traces.focus` the page then offers no Traces sync at all: no sync button, no Show in
Traces, and function names as plain text.

## Keys, live updates, states

Key hints are in the palette and in tooltips. The page registers its commands through
`PageRenderProps.commands`: next and previous call, go to the likely cause, edit, fork with an
error, the three choices at a pause, continue, toggle a stop, show in Traces (Alt+T), compare, save
as test, replay, show workers, next and previous run in the group, and the player with its play,
pause and speed.

The page binds `rewind::changed` once and refetches on its events. It never polls: it reads again
when the connection comes back and when the tab is shown again, the way the console's
`useWorkerLive` does, and the header says Live or Not live. Loading shows skeletons in the shape of the level, an empty Rewind shows the
`traffic::burst` command to run, and an error says what failed with a Retry.

## Copy

Copy on the page is short, in the style of a devtools panel. Use a label or a status line rather
than a sentence, such as "Fork failed", "4/7 fixed" or "Replay diverged at call 3 · model::complete".
Separate the parts of a status line with `·` and show a before and after with `→`. Use sentence
case, no trailing period and no dashes. Say what happened rather than what Rewind did, and leave out
anything that explains what the screen already shows or how Rewind works inside. Errors say "<thing>
failed" or "Failed to <verb> <thing>". Aria-labels may stay short sentences, since a screen reader
says them aloud.

## Shapes the page reads

The page follows `docs/rewind.md`. Code fields (`target_code`, `code_version`, `Fork.code`) and the
check fields (`code`, `live_calls`, `filled`) are optional, so the page works with a core that does
not send them yet. So are `Fork.auto` and `stops`, `need.reason`, `filled_from`, a function row's
`request_format` and `response_format`, and `need.response_format`, which a request around iii and
a fork stored before Rewind passed formats on don't have. An interrupted run with no `mid_call`
reads as cut off mid-call, which is how an older core recovers every interrupted run. A fork with no
`auto` at all comes from a core without stops, so changing a stop there only keeps it for the next
fork. Slow functions (`fork`, `fork-set`, `replay`, `answer`, `recover`, `test`) get a 120 s
timeout, and a check gets 5 s more per run.

## Working on it

```bash
npm run build                                   # typecheck, bundle, scope and token checks, strict lint
npm test                                        # the model's unit tests and the contract with the core's enums
III_URL=ws://127.0.0.1:49634 npx tsx dev/mockWorker.ts
III_URL=ws://127.0.0.1:49634 CONSOLE_URL=http://127.0.0.1:3633 SHOTS=/tmp/shots npx tsx dev/shoot.ts
```

The mock (`dev/mockWorker.ts` over `dev/sim.ts`) implements every `rewind::*` function with the
core's shapes, including the code additions, the live check, and forks with `auto` and stops. It
reads each function's formats from the JSON blocks in `docs/contract.md`, with keys sorted the way
the engine sorts them.
`rewind-dev::configure` sets latency and failures, empties or resets the data, with
`code_change: true` applies the demo fix for bug 1, with `undeclared` reports the functions it
lists as having no effects, and with `answer_failures` makes that many of the next
`rewind::answer` calls fail. A recovery or an answer takes about a second to start a copy of the
agent, then as long as the rerun's live calls, so each run takes 1 to 3 s. The mock's newest
incident is six runs tools cut off at once: three in `email::send`, two in `calendar::find-slot`, whose recoveries pause there because tools died while running it, and one
whose `email::send` failed with `function_not_found` because tools was already gone. The
shoot script walks flows A to E against the mock, and D again with `email::send` undeclared, and
the schema checks, or A, B, D and the schema checks against the core with `TARGET=core`. Against
the core, D with unknown effects needs a tools worker that registers `email::send` with
`effects: []`.

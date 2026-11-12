# Rewind on iii 0.26.0: what the new observers change

iii 0.26.0 (Observe v2, iii PR #2433) replaced triggers with functions and observers. An observer's
`capture` now decides when it fires, the 0.25 `on` and `deliver` fields are gone, and the worker
that hosts a function can change how its calls reach observers with four hooks: `onObserverAdded`,
`onObserverRemoved`, `onObservationMatch` and `onObservationDeliver`. This file says what that does
for Rewind, measured the way `docs/spike.md` measured 0.25.

The short answer: 0.26 doesn't give Rewind anything new for durability. Observers still fire only
after a call finishes, a call cut off by a dead worker still doesn't produce an event, and the
host's hooks run only after the handler has finished. The port itself was small, and the end-to-end check passes on
0.26 with the same 74 checks as on 0.25.

The probes ran against the 0.26.0 release binary for aarch64-apple-darwin, with `iii-sdk` 0.26.0
from npm, on an engine of their own on 127.0.0.1:49834 whose observer grace period is 3 s instead
of 30 s (`experiments/observe-v2/config.yaml`). Each probe is a TypeScript file in
`experiments/observe-v2`, run with `npx tsx <file>` after `npm install` there. Workers that a probe
kills run as separate processes (`roles/owner.ts`). Output is in `experiments/observe-v2/results`.

| # | Question | Answer | Probe |
|---|---|---|---|
| a | An observer hears about a call cut off by a dead worker | No. The engine now counts it as a `CANCELLED` drop | `q1KillMidCall.ts` |
| b | An observer fires when a call starts, or sees it before the handler runs | No | `q2CallStart.ts` |
| c | The host or a third party can hold or redirect a call | The host can hold or replace the answer, after its handler ran. A third party can't | `q3HoldRedirect.ts` |
| d | Rewind's observers survive the observed worker, or Rewind, going away | Yes, and the SDK now observes again after a long absence. Calls made while Rewind is away are lost | `q4Reconnect.ts` |
| b, c | Anything outside observers sees a call before dispatch | The worker manager's middleware does, at a cost to the call tree | `q5Middleware.ts` |

## a. A call cut off by a dead worker: still no event

The recorder observed `probe::slow` with Rewind's capture (`input`, `output`, `error`, `caller`),
plus a second observer for failures only (`capture: ["input", "error"]` with the filter
`{ "error": { "$exists": true } }`), and an observer of `probe::parent`, which calls `probe::slow`
from another worker. The owner was SIGKILLed 600 ms into two 60 s calls, one direct and one from
`probe::parent`.

```
t+ 2386ms SIGKILL owner (pid 96057)
t+ 2397ms EVENT observers-changed {"function_id":"probe::slow",...,"reason":{"code":"OWNER_UNAVAILABLE",...},"state":"pending","target":"probe::record-failures"}
t+ 2397ms EVENT workers-changed {"event":"worker_disconnected",...}
t+ 2399ms EVENT observers-changed {"function_id":"probe::slow",...,"state":"pending","target":"probe::record-complete"}
t+ 2409ms direct call ERROR {"code":"invocation_stopped","message":"invocation_stopped: Invocation stopped"}
t+ 2410ms parent call ERROR {"code":"invocation_failed","message":"invocation_failed: invocation_stopped: Invocation stopped"}
t+ 2410ms EVENT parent {"function_id":"probe::parent","status":"error","input":{"hold_ms":60000,"label":"via-parent"},...}
t+12411ms events for probe::slow in the 10 s after the kill: 0
t+12413ms observer rows for probe::slow [{..."state":"pending","fires":1,"dropped":{"CANCELLED":2}}, {..."state":"pending","fires":0,"dropped":{"CANCELLED":2}}]
```

Neither observer of `probe::slow` got an event, not even the one that asks only for failures. The
parent's observer got an error event, as on 0.25, which says some call stopped but not which one.
What changed is the counter. On 0.25 the engine counted each lost call as `INACTIVE`. On 0.26 it
counts `CANCELLED`, which is what the 0.25 docs promised. With the owner on the 0.25 SDK
(`OWNER_SDK=0.25`, in `results/q1KillMidCall-owner-on-0.25-sdk.txt`) the counter still says
`INACTIVE`. Either way the counter doesn't say which invocation was lost or what its input was.

This is by design. iii's Observe v2 decisions (`tech-specs/2026-10-29-observe-v2/decisions.md` at
`iii/v0.26.0`) say that a routed call of an `observe.v2` host that ends without its answer
activates nothing, and each of its observers counts a `CANCELLED` drop. In 0.26 the host decides
which observers a call reaches and sends that list with the call's result, so a host that dies
never sends the list.

`engine::on-observers-changed` is new in 0.26, and the engine calls it once per observer state
change. It reported the observers going `pending` 1 to 12 ms before the callers heard
`invocation_stopped`, over three runs. That tells Rewind which recorded functions lost their worker, at the same
moment `engine::on-workers-changed` does, but it doesn't say anything about the calls in flight.

What it means for Rewind: Rewind still can't learn an interrupted call's input from iii. It still
finds a lost run from the parent's error event and the worker changes around it, as it does on
0.25. A start record written before each call goes out, in the preloads, is still the way to know
which call was cut off and with what input.

## b. A call starting: no event, and the hooks run after the handler

The owner hosted `probe::step`, whose handler waits 1.5 s, with an `onObservationMatch` hook that
logs when it runs and what the call has in it. Three observers watched it with different captures.

```
t+  371ms CALL sent, routed through the engine
t+  378ms HANDLER start routed
t+ 1879ms HANDLER end routed
t+ 1880ms HOOK match for observer d9e53115 on routed: call has function_id, invocation_id, status, input, output, caller; status success
t+ 1881ms CALL answered {"done":"routed"}
t+ 1882ms EVENT input-error: status success, started_at_ms 1794456061866, duration_ms 1505, ...
t+ 1882ms EVENT input: ...
t+ 1882ms EVENT default: ...
```

The match hook ran after the handler finished, with the output already in the call. Every observer
fired after the caller had its answer. A call the owner made to itself, which runs in-process, went
the same way. Asking for a start event was refused:

```
observe with on: "start" refused {"code":"INVALID_ARGS","message":"observe: `source.on` was removed: `source.capture` decides which outcomes fire the target and what it receives"}
observe with capture ["caller"] refused {"code":"INVALID_ARGS","message":"`source.capture` must name at least one of `input`, `output`, `error` (or be `[]`): `caller` and `metadata` alone fire on nothing"}
engine-hosted event sources ["configuration::on-updated","engine::on-functions-changed","engine::on-observers-changed","engine::on-workers-changed",...,"observability::on-log","observability::on-span"]
```

None of the engine's event sources is about a call starting. iii's original observe spec
(`tech-specs/2026-10-13-observe/README.md` at `iii/v0.26.0`) lists `on: start` as optional work
under a phase marked "Not shipped", so 0.26 doesn't have a call-start event.

The console's harness has functions such as `harness::hook::on-pre-call`, which its workers
observe before a tool call. That is a convention of the harness worker, which calls those functions
itself before it runs a tool. It covers only the harness's own tool calls.

What it means for Rewind: an observer can't record a call before it runs, so it can't give Rewind
a start record.

## c. Holding or redirecting a call: only the host, and only its answer

The owner hosted `probe::pay`, whose handler logs a side effect, with an `onObservationDeliver`
hook that picks what to do from the input.

```
t+  535ms HANDLER side effect: charged order o-hold
t+  535ms HOOK deliver for o-hold (mode hold): handler output {"charged":true,"order":"o-hold"}, 2 observers matched
t+ 2538ms CALL hold answered after 2003 ms {"charged":true,"order":"o-hold"}
t+ 2839ms HANDLER side effect: charged order o-redirect
t+ 2839ms EVENT probe::alt got order o-redirect
t+ 2840ms CALL redirect answered after 2 ms {"charged":false,"handled_by":"probe::alt","order":"o-redirect"}
t+ 3141ms HANDLER side effect: charged order o-refuse
t+ 3147ms CALL refuse failed after 6 ms {"code":"invocation_failed","message":"invocation_failed: the deliver hook refused order o-refuse"}
observer rows for probe::pay [{"target":{"function_id":"probe::record-pay"},"fires":0,...},{"target":{"function_id":"probe::alt"},"fires":1,...}]
```

The deliver hook runs after the handler, so the side effect has already happened by the time it
decides anything. The hook can keep the caller waiting, give the caller another function's answer,
or turn a success into a failure. It can't stop the handler from running or send the call
somewhere else first.

With a deliver hook set, iii stops delivering that function's calls itself. The recorder, observing
the way Rewind does, didn't get a single event (`fires: 0`), and `probe::alt` got only the call the
hook passed to it. A function whose host sets a deliver hook, such as `http::on-request` or `ade::ui::asset`,
reaches Rewind only if its host passes calls on.

A third party, a worker that does not host `probe::pay`, could do none of this:

```
CALL after the third party set a deliver hook answered {"charged":true,"order":"o-third"}
third party call through its own observer failed {"code":"NOT_FUNCTION_OWNER","message":"NOT_FUNCTION_OWNER: only the worker hosting `probe::pay` calls through its observers"}
[iii] Function registration rejected: function "probe::pay" in namespace "default" is already exported by worker 8aee1723-...
```

Its deliver hook never ran, its call through an observer was refused, and its registration of the
same function id was refused while the owner was connected.

What it means for Rewind: the hooks give a worker control over what its own functions return,
which a worker could already have in its handler. Rewind can't use them on the app's functions,
and they don't help it keep a call waiting before it runs.

## d. Disconnects and reconnects

The recorder observed `probe::slow` with Rewind's capture and logged every state change of its
handle.

When the owner was killed, the observer went `pending` (`OWNER_UNAVAILABLE`) and stayed `pending`
for as long as the owner was away, 1 s or 6 s. The grace period only applies to the observing
worker. When an owner with the same name came back, the same observer went `active` again with its
counter kept, and the next call reached the recorder:

```
t+ 3349ms STATE recorder's handle fa5a213c: pending {"code":"OWNER_UNAVAILABLE",...}
t+ 9347ms rows while the owner is away for 6000 ms [{"id":"fa5a213c","state":"pending","fires":2,...}]
t+ 9717ms STATE recorder's handle fa5a213c: active
t+10106ms EVENT recorder got owner-back-6s (success)
```

When the recorder itself was cut off through a proxy, the engine held its observer as `suspended`
(`OBSERVER_DISCONNECTED`). A call made while it was away never reached it, even after it came back,
and the engine didn't count a drop for it. Past the grace period the engine disposed the observer, and
the SDK observed it again with the same id, which is the 0.26 fix for observers disposed while
their worker was away. The new observer's counter started at 0:

```
t+15058ms while the recorder is away the recorder's handle says active [{"state":"suspended","fires":4,"dropped":{},"reason":{"code":"OBSERVER_DISCONNECTED",...}}]
[iii] Observer fa5a213c-...: the engine disposed it while this worker was away past the grace period; observing it again
t+21872ms STATE recorder's handle fa5a213c: active
t+22974ms CHECK during-recorder-cut-6000: the recorder got it after reattaching false
t+23527ms CHECK recorder-back-6000: recorder got it true; handle active [{"state":"active","fires":1,"dropped":{}}]
```

The recorder's own handle said `active` the whole time the engine said `suspended`. A worker can't
tell from its handle that it is missing calls.

Last, the owner's connection went through a proxy that dropped it 0 ms into a 3 s call. The caller
got `invocation_stopped` at once, the observer counted a `CANCELLED` drop, and the handler in the
still running owner process finished 3 s later with nowhere to send its answer:

```
t+24216ms [owner] HANDLER start in-flight ...
t+24216ms in-flight call ERROR {"code":"invocation_stopped","message":"invocation_stopped: Invocation stopped"}
t+27218ms [owner] HANDLER end in-flight ...
t+30218ms CHECK in-flight: recorder got it false [{"state":"active","fires":1,"dropped":{"CANCELLED":1}}]
```

What it means for Rewind: Rewind's observers follow a worker that restarts, as on 0.25. Calls made
while Rewind is down or cut off are still lost, so "When Rewind itself stops" in DESIGN.md is still
true. A short network drop is enough to stop a call whose handler goes on to finish, so a call cut
off mid-call may well have done its work. Recovery is right to ask before sending such a call again.

## Outside observers: the worker manager's middleware

`docs/spike.md` left the worker manager's `middleware_function_id` as the next thing to probe. It
is not new in 0.26. A listener with a middleware runs that function on every call made by a worker
connected through it, and the function forwards the call or refuses it. The app worker connected
through such a listener (`config-middleware.yaml`), and the middleware wrote a start record before
each forward.

```
t+  939ms HOOK middleware start probe::slow plain: input keys action, context, function_id, namespace, payload; its own caller undefined
t+  943ms [owner] HANDLER start plain ...
t+  947ms EVENT recorder got plain (success), caller {"function_id":"probe::middleware","invocation_id":"98e031d3-...","worker_name":"probe-middleware"}
t+ 1555ms HOOK middleware start probe::slow hold: ...
t+ 3057ms HOOK middleware done holding hold
t+ 3061ms [owner] HANDLER start hold ...
t+ 3366ms CALL redirect answered after 2 ms {"handled_by":"probe::alt","label":"redirect"}
t+ 4174ms HOOK middleware saw probe::slow killed fail; its start record is {"at":1794456433611,"function_id":"probe::slow","payload":{"hold_ms":60000,"label":"killed"}} {"code":"invocation_stopped",...}
t+ 4181ms CALL killed failed after 514 ms {"code":"invocation_failed","message":"invocation_failed: invocation_stopped: Invocation stopped"}
```

The middleware sees each call before it is dispatched, with its input. It can keep a call waiting
before the handler runs, send it elsewhere, and it knows which call a dead worker cut off. That is
everything durable resume needs from iii, and it doesn't need an engine change.

It costs three things. The forwarded call's `caller` is the middleware's own invocation, and the
middleware's input doesn't include the original caller's ids, so Rewind would lose the tree it
builds from `caller.invocation_id`. The middleware's own error replaces the callee's: the app saw
`invocation_failed` where it would have seen `invocation_stopped`, and the agent decides whether to
retry `email::send` by the error code, so the middleware would change the app's behavior unless it
passed codes through. And every call takes another hop, with local dispatch off for workers on that
listener.

## The port

The port to 0.26.0 is on this branch. What it needed:

- Rewind's observers drop `on: "complete"` and capture
  `["input", "output", "error", "caller", "metadata"]`. The default capture fires on success only,
  so `error` has to be there for Rewind to record failed calls.
- `rewind::changed` was an owner-delivered function that kept its own list of observers and served
  a `rewind::changed` trigger type for pages. It is now a private function that returns its event,
  and Rewind calls it once per event; iii hands each call to every observer. The page observes it
  with the console's `iii.observe`, and the end-to-end check observes it with
  `capture: ["input"]`.
- The page and styles were triggers of type `console:script` and `console:style`. They are now
  observers of `ade::ui::asset` with `{ kind, path }` args. The engine logs a warning for each such
  observer, that `ade::ui::asset` declares no `args_format`; the console serves the assets anyway.
- The 0.26 console is ADE 1.10.4, which needs a 0.26 engine. The compose lock had resolved `latest`
  to 1.9.72, and the 0.26 CLI kept that resolution until the lock was removed and built again. Its
  functions moved from `console::` to `ade::`, so the page calls `ade::workspace::open`, and pages
  build against `@iii-dev/console-ui` 0.4.0, which has `observe` and no `registerTrigger`.
- Everything that called `trigger` calls `call`. Node and Python keep `trigger` as an alias; Rust
  marks `trigger` and `TriggerRequest` deprecated. `iii trigger` is `iii call`.

A 0.25 worker that binds with `registerTrigger` doesn't get events from a 0.26 engine, and doesn't
get an error either. The engine logs one `dropping` warning per connection, so a page left on the 0.25 console
would stop updating without saying why.

## Which workarounds can go

- **Rewind's own list of page observers** went in the port. iii delivers `rewind::changed` to its
  observers now.
- **Re-observing a disposed observer** in the record list's refresh is no longer needed after a
  long disconnect, since the SDK now does it. The check is harmless and still covers an observer
  the engine refused, so it stays.
- **Finding a lost run from the parent's error event** stays. 0.26 still drops the interrupted
  call's event.
- **Starting the record list again when Rewind restarts** stays. Calls made while Rewind is away
  are still lost.
- **Exiting when another worker owns `rewind::record`**, waiting for registered functions to show
  up, and reading the caller's outcome next to the callee's were not probed here, so they stay.

## Durable resume

Durable resume means finishing an interrupted run on the live workers, with each call's start
recorded before it is dispatched. 0.26's observers can't record that start: they fire only after
the handler finishes, the host's hooks run after it too, and the interrupted call itself is
dropped.
So 0.26 does not make durable resume possible on its own.

It is possible without an engine change in two ways, neither of them new in 0.26. A preload in each
worker can write a start record before each call goes out, which keeps the call tree and the error
codes as they are, and covers only the languages the preloads cover. The worker manager's
middleware can write the same record for every worker on its listener, in any language, but it
hides the caller from Rewind's tree, changes error codes, and adds a hop to every call.

## What I would probe next

- `observability::on-span` for a killed call: whether the engine ends the call's span with an
  error, which would name the interrupted invocation without the preload, though without its input.
- A middleware that passes the callee's error code through and adds the original caller to the
  forwarded call's metadata, to see whether the call tree and the agent's retry survive.
- Whether a refused `rewind::record` registration still gets events on 0.26, now that one worker
  hosts each function.
- Rewind's recording under a burst on 0.26, where routed calls carry their observer matches in the
  answer instead of a separate frame.

# Rewind on iii 0.25.0: spike results

All probes ran against the verified 0.25.0 binary (`scratchpad/iii-0.25.0/iii`), listening on
127.0.0.1:49434 only, with `iii-sdk` 0.25.0 from npm and PyPI. The engine config is five lines
(`config.yaml`: one `iii-worker-manager` with host 127.0.0.1 and port 49434). Each probe is a
TypeScript file in this directory, run with `node --import tsx <file>`. Probes start their workers
as separate processes from `roles/`, so they can be killed or stopped one at a time. Raw output is
in `logs/` (`logs/<probe>-run.log`, one log per role, `logs/engine.log`, `logs/pids.log`). The
machine's load average was around 20 during the runs, so worker startup took several seconds and
small latencies are approximate.

| # | Question | Answer | Probe |
|---|---|---|---|
| 1 | Cancelled calls are observable | No | `q1CancelObserved.ts`, `q1bParentError.ts` |
| 2 | Shadow namespace | Yes, with one connection per namespace | `q2ShadowNamespace.ts` |
| 3 | Keeping a call waiting | Yes, up to the caller's own timeout | `q3HoldAnswer.ts` |
| 4 | Rebuilding the call tree | Yes from `caller`; trace id is partial | `q4CallTree.ts` |
| 5 | Kill versus freeze | Kill is seen at once, a freeze is never seen by the engine | `q5KillVsFreeze.ts`, `q5bQueue.ts` |
| 6 | Python SDK | Yes | `q6PythonFromNode.ts`, `py/pyWorker.py` |
| 7 | Outbound fetch from a Node worker | Yes, fetch only | `q7FetchPreload.ts`, `record.ts` |
| 8 | Observing a call that stays in process | Yes, with `localDispatch` on or off | `q8LocalDispatch.ts` |
| 9 | Observing without owner hooks | Yes, input and output are there | `q9OwnerHooks.ts`, `roles/q9Owner.ts` |

## 1. Cancelled calls are observable: no

The recorder observed `tools::find-slot` with `on: "complete"` and capture
`["input", "output", "error", "caller", "metadata"]`. A control call produced an event. Then the
owner was SIGKILLed 550 ms into a 60 s call. The caller got `invocation_stopped` 13 ms after the
kill. The recorder got nothing. The engine counted the event as dropped with reason `INACTIVE`. The
result was the same on a second run and again in the Q5 kill run.

```
PROBE SIGKILL owner pid 97384 at +552ms
PROBE caller ERROR after 565ms {"code":"invocation_stopped","message":"invocation_stopped: Invocation stopped"}
PROBE NO recorder event for the cancelled call within 10 s
PROBE observer counters [{"state":"pending","reason":{"code":"OWNER_UNAVAILABLE",...},"fires":1,"dropped":{"INACTIVE":1}}]
```

The reason is the order of cleanup. When the owner's connection goes away, the engine unregisters
its functions first, which moves every observer of them to `pending`. Then it fails the in-flight
call with `invocation_stopped`. The completion does match the observer (`on: "complete"`, filter
empty), but `activate()` in `engine/src/observer/dispatch.rs` drops it because the observer is no
longer active. The docs say a cancelled call counts as `CANCELLED`. That code path is for a call
whose engine future is dropped, which a worker death does not cause.

One full envelope, from the control call (ids shortened):

```json
{
  "observer_id": "0c0e295e-...", "activation_id": "2a2b4bec-...",
  "function_id": "tools::find-slot", "namespace": "default",
  "invocation_id": "03c43468-...", "status": "success",
  "input": { "day": "mon", "hold_ms": 0 },
  "output": { "answered_by": "owner-a", "input": { "_caller_worker_id": "31bb1410-...", "day": "mon", "hold_ms": 0 }, "ns": "default" },
  "caller": { "worker_id": "31bb1410-...", "worker_name": "q1-caller" },
  "started_at_ms": 1793403372720, "duration_ms": 2.41
}
```

Fields in the envelope: `observer_id`, `activation_id`, `function_id`, `namespace`,
`invocation_id`, `status`, `input`, `output` (success only), `error` (failure only, and only when
captured), `caller` (`worker_id`, `worker_name`, plus `function_id`, `invocation_id` and a one
level `parent` when the call was made inside a handler), `metadata` (only when the call had
metadata), `started_at_ms`, `duration_ms`. Missing from the envelope: the trace id, the id of the
worker that ran the call, and an attempt number.

The target gets more outside the envelope. `worker.currentInvocation()` inside the target returns
its own invocation id, `observe_depth: 1`, `caller: { worker_name: "iii-engine", function_id,
invocation_id }` of the observed call, and `activation: { observer_id, activation_id }`. The trace
id is only available as the OTel span the SDK starts from the activation's `traceparent`
(`trace.getActiveSpan().spanContext().traceId`). See Q4 for when that matches the observed call.

Follow-up (`q1bParentError.ts`): when `agent::turn` calls `tools::find-slot` from its handler and
the tools owner is killed, the observer on `agent::turn` does get an error event. It has the
parent's input, and the error says only that some call stopped. It does not say which child or
with what input. The child itself still produces no event.

```
{"fn":"agent::turn","status":"error","input":{"turn":7},"error":{"code":"invocation_failed","message":"invocation_stopped: Invocation stopped",...}}
```

What Rewind has to change: observers cannot be the source for recovering killed calls. Rewind
needs its own record of each call as it starts, because observers only fire on completion. The
fewest moving parts is a preload in the worker under test that appends `{function_id,
invocation_id, input}` to disk synchronously when a handler starts. An entry with no completion
after an `engine::on-workers-changed` `worker_disconnected` event is a cancelled call. The parent's
error event (`invocation_stopped` in the message) can tell Rewind which turn to re-run, but not
which child failed.

## 2. Shadow namespace: yes, with one connection per namespace

`owner-a` in `default` and a stub with the same worker name, `owner-a`, in `rewind-1` both
registered `tools::find-slot` with no conflict. Two copies of an `agent` worker, one per namespace,
call `tools::find-slot` without naming a namespace. Each reached the owner in its own namespace.

```
PROBE direct, no namespace         {"answered_by":"owner-a",...,"ns":"default"}
PROBE direct, namespace rewind-1   {"answered_by":"owner-a",...,"ns":"rewind-1"}
PROBE agent::turn in default    {...,"next":{"answered_by":"owner-a","fn":"tools::find-slot",...,"ns":"default"},"ns":"default"}
PROBE agent::turn in rewind-1   {...,"next":{"answered_by":"owner-a","fn":"tools::find-slot",...,"ns":"rewind-1"},"ns":"rewind-1"}
PROBE missing, namespace rewind-9 ERROR {"code":"function_not_found","message":"... not found in namespace rewind-9. It is registered in namespace(s): default, rewind-1, rewind-2, rewind-3."}
```

Both conflict codes behave as described, and they only apply inside one namespace. The SDK sends
these warnings to the engine through OTel logs, so they appear in `logs/engine.log` and not on the
worker's stderr:

```
[WARN] iii::engine Function 'tools::find-slot' in namespace 'rewind-1' is already owned by live worker 'owner-a' (...); rejecting registration from worker 'dup'
[ERROR] iii-node [iii] Registration rejected by engine: WORKER_NAMESPACE_CONFLICT: registration rejected for worker "owner-a" in namespace "rewind-1"
```

One connection cannot register in more than one namespace. The `RegisterFunction` frame does not
have a namespace field (`engine/src/protocol.rs`), the Node and Python `registerFunction` do not
take a namespace option, and the docs say a connection's namespace is fixed by its first
`engine::workers::register`. One process can open several connections, though.
`roles/multiNs.ts` opened two `registerWorker` connections, in `rewind-2` and `rewind-3`, from a
single process, and both stubs served calls:

```
PROBE multi, namespace rewind-2 {"answered_by":"rewind-stubs","ns":"rewind-2","stub":true}
PROBE multi, namespace rewind-3 {"answered_by":"rewind-stubs","ns":"rewind-3","stub":true}
```

What Rewind has to change:

- Rewind opens one connection per shadow namespace. They can share a process.
- Resolution never falls back to `default`. Every function the copy calls must have a stub in the
  shadow namespace, including calls to other workers such as state or queue, or the copy gets
  `function_not_found`. Engine builtins (`engine::*`) resolve in `default` automatically.
- Start the copy with `III_NAMESPACE=rewind-1`. The SDK reads it when the code does not pass a
  `namespace` option. A worker that hardcodes `namespace` cannot be moved this way.
- `registerFunction` returns before the engine has registered the function. Rewind should confirm
  its stubs (for example with `engine::functions::list`) before it starts the copy. Two probes lost
  this race and got `function_not_found`.
- The engine adds `_caller_worker_id` to the handler's input. The observed `input` does not have
  it. Replay should compare against the observed input, not what a handler printed.

## 3. Keeping a call waiting (holding an answer): yes, up to the caller's own timeout

A stub slept before replying. With the SDK default, the caller gave up at 30 s with a client side
`TIMEOUT`. The per call option is `timeoutMs` on `worker.trigger({ ..., timeoutMs })`. The worker
wide option is `invocationTimeoutMs` in `registerWorker` options. With `timeoutMs: 130000`, a stub
that waited 120 s before replying returned normally.

```
PROBE A (40 s sleep, default timeout) ERROR after 30006ms {"code":"TIMEOUT","message":"TIMEOUT: invocation timed out after 30000ms"}
PROBE B (120 s sleep, timeoutMs 130000) RESULT after 120018ms {"answered_by":"q3-stub",...}
```

The engine imposes no limit of its own on an ordinary call. In `engine/src/invocation/mod.rs` a
call routed to a worker waits on a oneshot receiver with no timer, and nothing in the engine pings
the worker. The only engine timeouts are for observer targets (`observers.activation_timeout_ms`,
30 s) and the queue worker's target timeout (`timeout_ms`, 30 min by default).

The recorder logged run A as a success, with `duration_ms: 40030`, even though its caller had
already failed with `TIMEOUT`. The SDK timeout is local to the caller, so the engine keeps the call
open and records the callee's outcome.

```
{"status":"success","input":{"hold_ms":40000,"run":"A"},"duration_ms":40030.18,...}
```

What Rewind has to change: stepping is limited by the timeout in the code of the worker under
test, not by iii. The Node SDK has no environment variable for it. Rewind either replies before the
caller's timeout (30 s unless the code sets one), or needs the copy to read its timeout from
configuration that Rewind can set. Recordings also need the caller's view of each call. A recorded
`success` whose `duration_ms` is longer than the caller's timeout was a failure for the caller.

## 4. Rebuilding the call tree: yes from `caller`; the trace id only partly

Remote case: `tree::a` (worker `wa`) calls `tree::b` (worker `wb`). Local case: `tree::a2` calls
`tree::b2` in the same worker, so the SDK runs it in process and reports it. In both, B's event
identifies A by function id and invocation id. In the remote case the events arrive in completion
order, B before A.

```
event tree::b   inv 5f27a414  caller: tree::a/29e9e0ce  activation trace 7708402f
event tree::a   inv 29e9e0ce  caller: (none)            activation trace 42f0f20d
handler tree::a inv 29e9e0ce  handler trace 7708402f
handler tree::b inv 5f27a414  handler trace 7708402f
```

The trace id depends on whether the root call came with trace context. A and B ran under one trace
(`7708402f`), and B's activation has the same trace. A's own activation got a fresh trace
(`42f0f20d`). That happened for every root call made outside a span (`tree::a`, `tree::a2`, the
cross namespace call). When the root call was made inside an OTel span, all of them matched:

```
PROBE root span trace id ce7dc2a0...
event tree::b  remote, root inside a span  caller: tree::a/799bdc60  activation trace ce7dc2a0
event tree::a  remote, root inside a span  caller: (none)            activation trace ce7dc2a0
```

`caller.function_id` and `caller.invocation_id` are enough to rebuild parent and child links
without the observability worker. A call made outside any handler has no `caller.function_id`, and
that marks a root. `caller.parent` goes up one level only, with the parent's worker and, when there
is one, its function. The engine stamps `worker_id` and `worker_name`. The SDK asserts the function
and invocation ids, so they are fine for building a tree and not for authorization.

Events from local dispatch arrive late. `tree::b2` reached the recorder after its parent
`tree::a2`, and after the events of two calls made later, because the hosting SDK reports local
calls in batches. The docs also say these reports are at most once and can be lost with a dropped
connection.

One observer can watch another namespace. The recorder in `default` observed
`{ function_id: "tools::find-slot", namespace: "rewind-x" }`, went active, and got the event with
`"namespace":"rewind-x"`.

What Rewind has to change: key the tree on `caller.invocation_id`, not the trace id. Sort by
`started_at_ms` rather than arrival. If Rewind wants a trace id per request, the root call has to be
made inside a span, or Rewind takes the trace id from the first child event.

## 5. Kill versus freeze: kill is seen at once, a freeze is never seen by the engine

`q5KillVsFreeze.ts`, direct calls:

```
t+1.4s SIGKILL q5-owner-k
t+1.4s K1 ERROR after 1006ms {"code":"invocation_stopped"}          5 ms after the kill
t+1.4s K2 (after kill) ERROR after 0ms {"code":"function_not_found"}
recorder events for kill-me: []

t+3.4s C1 (default timeout) and C2 (timeoutMs 150000) start, owner sleeps 3 s per call
t+4.4s SIGSTOP q5-owner-f
t+14.4s C3 (timeoutMs 150000) sent while frozen
t+33.4s C1 ERROR after 30001ms {"code":"TIMEOUT"}
t+94.4s recorder events before SIGCONT: []   counters: state active, fires 0
t+94.4s SIGCONT
t+94.4s C2 RESULT after 91007ms
t+94.4s C3 ERROR after 80008ms {"code":"invocation_stopped"}
recorder after SIGCONT: C1 success duration_ms 91005, C2 success duration_ms 91005
counters after SIGCONT: fires 2, dropped {"INACTIVE":1}
```

- Kill: the caller sees `invocation_stopped` within a few milliseconds. New calls fail at once
  with `function_not_found`. The observer gets no event (same as Q1).
- Freeze: the engine never noticed. It does not ping workers, and the TCP connection stays open.
  It kept routing new calls (C3) to the frozen worker. Callers wait until their own timeout. The
  observer neither fired nor counted a drop during the freeze.
- After SIGCONT: the handlers finished and their replies went out. Both were recorded as success
  with a 91 s duration, including C1, whose caller had given up 60 s earlier. Then the SDK's own
  watchdog fired, because its 60 s timer had run out during the stop:
  `[iii] No inbound data for 60000ms, terminating connection to force reconnect`. The worker
  reconnected, and the engine cancelled C3, which had never reached the handler, with
  `invocation_stopped`. A freeze shorter than 60 s does not trip this watchdog, as the 45 s
  freeze in the queue run below shows.

Through the queue worker (`q5bQueue.ts`). The queue worker was built from the workers repo clone
(`queue-target/release/queue`) and seeded with `queue.yaml`: named queue `rewindq`, in-memory
store, concurrency 1, 3 retries, `timeout_ms` 600000. Jobs were enqueued with
`TriggerAction.Enqueue({ queue: "rewindq" })`.

```
t+4.0s  enqueued J1
t+7.2s  SIGKILL q5b-owner-k                     (J1 was in its handler)
t+12.2s stats after kill {"depth":0,"delivered":0,"failed":0,"dlq_depth":0}
        a second owner of tools::qjob starts
t+16.5s J1 was delivered again to the new owner  (INVOKED J1, ANSWER J1)
t+17.1s SIGSTOP q5b-owner-f                     (F1 in its handler), then F2 enqueued
t+62.1s stats while frozen {"delivered":1,"depth":1,"failed":0}
t+62.1s SIGCONT
        ANSWER F1 23:53:17.191, INVOKED F2 23:53:17.197, ANSWER F2 23:53:20.199
```

- A killed job is retried. It waited for the function to be registered again instead of using up
  its retries (`failed` stayed 0), and ran on the new owner about 4 s after that process started.
  J1's handler ran twice on the same input, partly on the first owner and fully on the second.
  Observers only saw the second run, but a start log like the one proposed in Q1 would have two
  entries for J1.
- A frozen job keeps its slot. With concurrency 1, F2 waited behind F1 for the whole 45 s freeze
  (`depth: 1`). Only the queue's `timeout_ms` bounds that wait (30 min by default). After SIGCONT,
  F1 finished and F2 ran at once. This freeze was shorter than 60 s, and the owner did not
  reconnect.

What Rewind has to change: Rewind cannot rely on any engine signal for a frozen worker. It needs
its own liveness check on the processes it starts, such as a health function with a short timeout,
or the process state from the OS. A frozen worker also keeps receiving new calls, so a replay
should not send work to a copy that has stopped responding. Late completions after a resume are
recorded as success, so the recording has to be checked against the caller's outcome (Q3).

## 6. Python SDK: yes

`iii-sdk` 0.25.0 on PyPI has `observe` on the worker class:

```
III.observe(self, source: ObserveSource | dict[str, Any], target: Target,
            options: ObserverOptions | dict[str, Any] | None = None) -> ObserverHandle
```

`handle.ready()` blocks until the observer is active, and `await handle.ready_async()` is the
asyncio form. `worker.current_invocation()` gives the same context as Node's
`currentInvocation()`. `py/pyWorker.py` registers `py::find-slot` and an observer on it. Node
called it:

```
PROBE Node got {"answered_by":"python","input":{"_caller_worker_id":"dea1030c-...","day":"wed"},"slot":"tue 10:00"}
INVOKED {"input": {...,"day": "wed"}, "inv": "InvocationContext(function_id='py::find-slot', invocation_id='8ecc28e1-...', observe_depth=0, caller={'worker_id': 'dea1030c-...', 'worker_name': 'q6-node-caller'}, activation=None)"}
EVENT {"envelope": {"function_id": "py::find-slot", "status": "success", "input": {"day": "wed"}, "caller": {...}, ...}}
```

What Rewind has to change: nothing for Python workers under test. The envelope is the same.

## 7. Outbound fetch from a Node worker: yes, for fetch

`record.ts` is a preload (`node --import tsx --import ./record.ts roles/fetcher.ts`). In record mode
it calls undici's `setGlobalDispatcher` with an `Agent` subclass that copies each response to a
tape file. In replay mode it installs a `MockAgent` built from the tape, with network access turned
off. Node 20.19.5's built-in fetch (undici 6.21.2) used the dispatcher set from npm `undici`
6.21.0. The replay served the recorded body with the test server closed:

```
REWIND recorded GET http://127.0.0.1:54608/weather?day=thu -> 200
PROBE replay run result {"day":"thu","forecast":"rain","served_at":1793403904114} server hits=1 (server closed)
FETCHED {"status":200,"replayed":"true",...}
PROBE same body on replay? true
```

The Node SDK does patch fetch. With OTel on (the default), `registerWorker` replaces
`globalThis.fetch` with a wrapper that starts a client span, adds `traceparent` and `baggage`
headers, and calls the fetch it found at startup (`patchGlobalFetch` in
`@iii-dev/helpers/observability`). The probe saw `replaced_by_sdk: true` in both runs. It does not
conflict with a dispatcher, because the wrapper still calls the built-in fetch, which uses the
global dispatcher. The SDK does not patch `node:http` unless the user passes OTel instrumentations.

What Rewind has to change: the recorded request headers include the SDK's `traceparent`, which is
different on every run, so the replay matcher must ignore `traceparent` and `baggage`. The
dispatcher only covers fetch and undici. Clients built on `node:http` (axios, many vendor SDKs) need
a separate hook.

## 8. Observing a call that stays in process: yes, with `localDispatch` on or off

One worker owns `a::outer` and `a::inner`, and outer calls inner. One copy ran with the default
(`localDispatch` on) in `default`, and one with `localDispatch: false` in `q8-off`. The recorder
started after both owners, so its observers were added after the engine had confirmed local
dispatch. The handler input shows which path each call took: the engine adds `_caller_worker_id`
to routed calls only.

```
a::inner handler, default: {"from":"a::outer","input":{...,"case":"localDispatch on"}}                           in process
a::inner handler, q8-off:  {"_caller_worker_id":"c6edceb2-...","from":"a::outer","input":{...}}                    routed
23:58:27.111 event a::outer default  duration_ms 17.3
23:58:27.118 event a::inner default  caller a::outer  duration_ms 2.9
23:58:27.139 event a::inner q8-off   caller a::outer  duration_ms 5.5
23:58:27.144 event a::outer q8-off   duration_ms 18.2
```

Both inner calls produced an event with the same envelope fields and `caller` set to `a::outer`.
The only difference is timing. The in-process event came from the SDK's batched report and
arrived after its parent's event, while the routed one arrived before its parent, as in Q4.

What Rewind has to change: nothing to get the events. The tree builder must not assume children
arrive before parents. The SDK reports local calls at most once, so a dropped connection can lose
them. A worker under test can be started with `localDispatch: false` per function, but there is no
environment switch for it. The engine wide switch is `observers.local_dispatch: false`.

## 9. Observing without owner hooks: yes, input and output are there

`roles/q9Owner.ts` registers three functions in one worker: `q9::plain` with no `observe` option,
`q9::hooked` with only an `onObserverAdded` hook, and `q9::owned` with `delivery: "owner"`, whose
handler calls `obs.emit(input)` for each observer. All three envelopes, ids shortened:

```
q9::plain   {"function_id":"q9::plain","status":"success","input":{"case":"plain"},
             "output":{"by":"plain","echoed":{...}},"caller":{"worker_name":"q9-caller",...},"duration_ms":6.9,...}
q9::hooked  {"function_id":"q9::hooked","status":"success","input":{"case":"hooked"},
             "output":{"by":"hooked","echoed":{...}},"caller":{"worker_name":"q9-caller",...},"duration_ms":1.7,...}
q9::owned   called from another worker: FORBIDDEN: `q9::owned` is owner-delivered: only the worker that hosts it invokes it; observe it instead
q9::owned   called from its own worker: {"function_id":"q9::owned","status":"success",
             "input":{"_caller_worker_id":"07d6a084-...","case":"owned, called from its own worker"},
             "output":null,"caller":{"function_id":"q9::kick",...},"duration_ms":0,...}
```

A function registered with no `observe` option uses auto delivery. Its envelope has the call's
`input` and `output`, the same as every other probe in this spike, none of which passed hooks. An
`onObserverAdded` hook changes nothing in the envelope. Owner delivery is worse for recording.
Other workers cannot call the function at all, and the envelope's `input` is whatever the handler
chose to emit, with `output: null` and `duration_ms: 0`.

What Rewind has to change: nothing. Rewind can record any ordinary function without touching the
worker that owns it. Functions that use owner delivery, such as the queue worker's
`queue::on-message`, are the exception: their events are whatever the owner emits, so a recording
of them only has what the owner chose to send.

## Surprises

1. A killed owner's in-flight call is dropped as `INACTIVE`, where the docs say `CANCELLED`. An
   observer does not see it, whatever `on` is set to.
2. An observer's target is a function id, not a handler. When the Q4 recorder's target
   registration was refused (the Q3 recorder already owned `rewind::record`), its five observers
   still went `active` and delivered to the Q3 process. Four `tree::*` events landed in
   `logs/q3-recorder.log`. Each Rewind recorder needs a unique target id, and it must treat the
   `FUNCTION_NAMESPACE_CONFLICT` warning as fatal.
3. The observed `status` is the callee's outcome. A caller that timed out is recorded as a success.
4. SDK warnings and errors, including both conflict codes and the idle watchdog, go to the engine
   log through OTel and not to the worker's own stderr.
5. A worker refused with `WORKER_NAMESPACE_CONFLICT` stops its SDK, but the Node process keeps
   running (`exitCode` was still null 4 s later).
6. What happens after a long freeze is decided by the SDK's 60 s idle watchdog, not by the engine.
7. The queue worker ran a killed job a second time on the new owner without counting a failure,
   so a handler can see the same job input twice.

## What I would probe next

- The worker manager's `middleware_function_id`, as a place to record each call's input before it
  is dispatched. That would answer Q1 without changing the worker under test.
- Calls that start from an HTTP or cron trigger: what `caller` and trace id look like for the root.
- Recorder load: `max_in_flight`, `OVERFLOW` drops, and the 8 MiB local dispatch report buffer
  under a burst of calls, since Rewind needs every event.
- PR #1929's `dispatch_timeout_ms` once it lands, rerunning the freeze probe against it.
- Whether a preload can raise `invocationTimeoutMs` in the copy without code changes, so stepping
  can go past 30 s.

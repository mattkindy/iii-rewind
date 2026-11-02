# Rewind across two engines

The agent's Python tools ran on a second iii 0.25.0 engine behind iii's `bridge` worker, and the
agent on the first engine kept working: every run finished, and each bridged call cost about 0.2 ms
more than on one engine. A replay on engine A still answered every call from the recording and sent
nothing to engine B. What broke is everything Rewind learns from its own engine. The bridge
registers the tools on A with no metadata, so Rewind sees no effects for them: by default it does
not record them, a fork cannot run them live, a live check borrows another run's answer for them,
and a recovery offers to run `email::send` live without marking it irreversible, which sent an
invite in two of my runs. The trace id crosses the bridge, but the spans, the requests around iii
and the tools worker's comings and goings all stay on engine B, where Rewind on A never looks. With
Rewind's defaults, the end-to-end check passed 30 of the 38 checks that could run, and 22 never ran.
With recording turned on for the bridged tools, it passed 54 of 60.

No change to Rewind or to the app's workers was needed to run any of this. The experiment is in
`experiments/multi-engine/`, and the raw output of every command below is in its `results/` folder.

## The setup

Engine A (127.0.0.1:50034) runs clock, model, agent, traffic, Rewind, the ADE (4033) and the
bridge. Engine B (127.0.0.1:50134) runs the tools, a probe worker, and a second Rewind. The fair
rival is the same app on one engine at 50034 (`experiments/multi-engine/single`), measured on the
same machine with the same scripts. Both setups use the providers on 50036.

In 0.25.0 the engine no longer has a built-in bridge. An engine config that lists `iii-bridge` is
refused with "move to worker-compose.yaml as 'bridge'". The bridge is the registry package
`bridge` 0.1.18, built on the Rust SDK 0.24.6. It opens two connections: one to its own engine, from
`III_URL`, and one to the peer, from `url` in its configuration entry. Compose delivers the
`config_override` to the configuration worker and tells the bridge which entry is its own with
`III_CONFIG_NAME`. This is the whole bridge config the experiment needed:

```yaml
bridge:
  worker: package://bridge
  version: "0.1.18"
  config_override:
    url: ws://127.0.0.1:50134
    forward:
      - local_function: calendar::find-slot
        remote_function: calendar::find-slot
      - local_function: email::send
        remote_function: email::send
      - local_function: probe::echo
        remote_function: probe::echo
```

Each `forward` entry registers a function on A that calls the same id on B. The bridge registers
it with a description and nothing else:

```
A: calendar::find-slot worker=bridge metadata=null description="Forward to remote function calendar::find-slot"
B: calendar::find-slot worker=tools metadata={"effects":["read-only"]} description="Finds an afternoon slot for an attendee on a given day"
```

## 1. Calls across the bridge

The agent works end to end. A burst of 30 runs ended the same ways on both setups, with the mix
set by the seeded model rather than by the bridge (`npx tsx measure/latency.ts single|split`):

```
single  traffic::burst {"count":30,"interval_ms":150}: {"booked":26,"errors":1,"failed":3}   and   {"booked":22,"errors":4,"failed":4}
split   traffic::burst {"count":30,"interval_ms":150}: {"booked":24,"errors":2,"failed":4}   and   {"booked":22,"errors":6,"failed":2}
```

To see what a call costs, `probe::echo` returns at once, so its round trip is the cost of routing.
I called it 200 times in a row on each setup, after 20 calls to warm up, and repeated each setup
once. The load average on the machine was between 2.6 and 5.2, from other stacks.

| `probe::echo`, 200 calls | mean | p50 | p90 | p99 |
| --- | --- | --- | --- | --- |
| one engine, run 1 | 0.22 ms | 0.22 | 0.29 | 0.42 |
| one engine, run 2 | 0.22 ms | 0.22 | 0.30 | 0.43 |
| two engines, run 1 | 0.39 ms | 0.35 | 0.57 | 0.73 |
| two engines, run 2 | 0.41 ms | 0.38 | 0.59 | 0.72 |

The bridge adds about 0.18 ms to the mean and 0.3 ms to the p99 on loopback, which nearly doubles
the cost of a call. The call goes agent to engine A, A to the bridge, the bridge to engine B, B to
the worker, and back, so it makes two extra hops.

For the tool itself I called `calendar::find-slot` 40 times on each setup and subtracted the time
the tool spent inside its handler, read from the Rewind on the tools' engine. The tool sleeps 0.4 to
0.9 s, so only the difference means anything:

| `find-slot`, round trip minus time in the tool, 40 calls | mean | p50 | p90 | p99 |
| --- | --- | --- | --- | --- |
| one engine, runs 1 and 2 | 0.69, 1.06 ms | 0.67, 1.03 | 1.06, 1.29 | 1.32, 1.95 |
| two engines, runs 1 and 2 | 1.18, 0.84 ms | 0.85, 0.83 | 2.22, 0.94 | 3.69, 1.16 |

That overhead includes observers and the Python SDK, and its run-to-run spread is larger than the
bridge's 0.2 ms. A booked run makes two bridged calls, so the bridge adds well under a millisecond
to a run that takes 2 to 3 s. Everything here ran on one machine, so these are loopback numbers.

## 2. What Rewind on A records

`observe` on A sees the bridged calls. An observer on A with every capture on got an envelope for
each call the agent made to `calendar::find-slot` and `email::send` (`measure/envelope.ts split`):

```json
A saw {"function_id":"calendar::find-slot","namespace":"default","invocation_id":"6c23e105-...","status":"success",
       "caller":{"worker_name":"agent","function_id":"agent::run","invocation_id":"f1654ff9-...","parent":{"worker_name":"envelope-probe"}},
       "input":{"attendee":"dana@example.com","day":"2026-11-03","duration":30},
       "output":{"attendee":"dana@example.com","start":"2026-11-03T15:30:00-06:00","end":"2026-11-03T16:00:00-06:00"},
       "started_at_ms":1793461986837,"duration_ms":714.03}
B saw {"function_id":"calendar::find-slot","namespace":"default","invocation_id":"2bbc2c8c-...","status":"success",
       "caller":{"worker_id":"7a015a84-...","worker_name":"bridge"},
       "input":{...the same...},"output":{...the same...},"started_at_ms":1793461986837,"duration_ms":713.48}
```

- **The function** has the same id on both engines, and the input and output match.
- **The worker** is not in the envelope on either engine. The function list says the worker on A
  is `bridge`, so Rewind shows `bridge` as the owner of both tools.
- **The caller** on A is the agent, with the run's invocation id, the same as on one engine. On B
  the caller is only the worker `bridge`, with no function, no invocation id and no parent.
- **The outcome** on A is the bridge's. A success passes through unchanged and A's `duration_ms`
  is about 0.6 ms longer. An error does not. The bridge turns every remote error into
  `bridge_error` and puts the original code in the message text, and it drops the stacktrace:

```
caller on one engine   {"code":"invocation_failed","message":"invocation_failed: unsupported type for timedelta minutes component: str","stacktrace":"Traceback ..."}
caller on A            {"code":"bridge_error","message":"bridge_error: remote error (invocation_failed): unsupported type for timedelta minutes component: str"}
A's envelope           "error":{"code":"bridge_error","message":"remote error (invocation_failed): unsupported type for timedelta minutes component: str"}
B's envelope           "error":{"code":"invocation_failed","message":"unsupported type for timedelta minutes component: str","stacktrace":"..."}
```

- **Effects.** The bridged functions on A have no `metadata`, so Rewind gives them no effects:

```
Rewind A: {"effects":[],"function_id":"calendar::find-slot","recording":false,"worker":"bridge"}
Rewind A: {"effects":[],"function_id":"email::send","recording":false,"worker":"bridge"}
Rewind A records: agent::run, clock::now, model::complete, traffic::burst
```

Rewind records a function only when its metadata says `effects` at all, so by default the two
tools are left off the record list and a run's recording has no tool calls in it: about 4.7 calls
per run instead of 6.7. With no effects, a fork offers only `typed`, `inject` and `stop` for them, a
live check never runs them, and recovery never runs them without asking. Recovery does allow
`live` for any call, and with no `irreversible` marker nothing tells a person that `email::send`
sends mail. Turning recording on with `rewind::record-toggle` works, and Rewind A then records both
tools with `caller_worker=agent`, `caller_function=agent::run` and the run's invocation id. The
effects stay empty.

## 3. Trace context

The run stays one trace, split across two trace stores (`measure/traces.ts split`). The trace id
from Rewind A's run is the one engine B used, and B's spans hang off the bridge's spans on A:

```
engine A has 16 spans in trace eb49c8b3...: execute traffic::burst, execute agent::run, execute clock::now,
  3 x execute model::complete, 5 x rewind: execute rewind::record, 2 x parseArgs, GET /holidays,
  bridge: execute calendar::find-slot, bridge: execute email::send
engine B has 6 spans in trace eb49c8b3...: execute calendar::find-slot, find_slot, 2 x rewind: execute rewind::record,
  execute email::send, POST /email
  B span iii-python-sdk: execute calendar::find-slot, parent on A bridge: execute calendar::find-slot
  B span iii-python-sdk: execute email::send, parent on A bridge: execute email::send
```

On one engine the same run is 20 spans in one store. Across two, neither engine has the whole
trace: `engine::traces::spans` on A returns none of B's spans, and B's returns none of A's. The ADE
on A reads A's store, so I expect its Traces view to stop at the bridge's spans.

## 4. Recording on both sides

The two recordings can be joined, but only loosely. With a Rewind on each engine and recording on
for the bridged tools on A, one booked run gave these rows (`measure/envelope.ts split`, step 5):

```
Rewind A row: calendar::find-slot inv=87d094a7-... caller_worker=agent caller_function=agent::run caller_inv=fe219d41-... trace=88a11218... start=1793461991841
Rewind A row: email::send         inv=2e9f46bd-... caller_worker=agent caller_function=agent::run caller_inv=fe219d41-... trace=88a11218... start=1793461993289
Rewind B row: calendar::find-slot inv=b302217a-... caller_worker=bridge caller_function=null caller_inv=null trace=88a11218... start=1793461991841
Rewind B row: email::send         inv=d0291f07-... caller_worker=bridge caller_function=null caller_inv=null trace=88a11218... start=1793461993290
```

- **By invocation id:** no. Each engine gives the call its own id, and B's caller has none.
- **By trace id:** only to the run. Both of B's rows match both of A's, so the trace id says which
  run a call on B belongs to, but not which call.
- **By input and start time:** yes, here. Each B row matched exactly one A row with the same input
  and a start within 50 ms (0 and 1 ms apart). Two identical calls close together, such as bug 3's
  double send, would make this ambiguous.
- **By span:** the trace stores have a key for each call. B's `execute` span has the bridge's
  `execute` span on A as its parent, and Rewind A already stores that span's id for each call.
  Rewind B would need to keep the parent span id to use it.

B sees the caller as worker `bridge` and nothing more, so every call reaches Rewind B as a root call
with no run. Rewind B also records the calls Rewind A makes live through the bridge, because they
arrive from `bridge` too. On one engine Rewind leaves its own calls out (0 rows with
`caller_worker=rewind` in the baseline's store). On B, the recovery's live `find-slot` and
`email::send` for one lost run are ordinary rows:

```
calendar::find-slot|success|bridge|{"attendee":"omar@example.com","day":"2026-11-02","duration":45}|15:57:22.051
email::send|success|bridge|{"start":"2026-11-02T13:00:00-06:00","subject":"45 minutes, Monday","to":"omar@example.com...|15:57:23.420
```

## 5. Replay and forks

A replay on A works and sends nothing across the bridge. The stubs in the fork's namespace cover
the bridged functions, because they are in A's function list (`measure/replay.ts split`):

```
a run with its tool calls recorded: replayed as f8 in rewind-f8: done {"reply":"Booked Tuesday 3 Nov at 3:30 pm with Dana ...","status":"booked"}
  calls 0:clock::now=recorded 1:model::complete=recorded 2:fetch GET .../holidays=recorded 3:calendar::find-slot=recorded
        4:model::complete=recorded 5:email::send=recorded 6:model::complete=recorded
  outbox 186 -> 186 lines, tools' Rewind 420 -> 420 tool rows, observer on the tools' engine saw 0 call(s)
```

The outbox is written by the email provider in the clock worker, which is on engine A, so it is
A's file. A run recorded with Rewind's defaults cannot be replayed past its first tool call:

```
a run recorded before the bridged tools were on the record list:
  replayed as f9: paused at seq 3 calendar::find-slot, effects [], choices typed, inject, stop
```

A debug fork cannot run `calendar::find-slot` live, because Rewind sees no effects for it:

```
seq 3 find-slot, choice live refused: REWIND_CHOICE_NOT_ALLOWED: live is not allowed for calendar::find-slot; choose one of ["typed", "inject", "stop"]
```

On one engine the same fork ran it live: `seq 3 find-slot answered live`, from worker `rewind`. A
recovery fork does allow live for any call, and there the live call reached B and came back with a
slot (`measure/failure.ts split`, bridge kill):

```
seq 3 calendar::find-slot answered live: {"value":{"attendee":"omar@example.com","end":"2026-11-02T13:45:00-06:00","start":"2026-11-02T13:00:00-06:00"}}
the tools' engine ran 2 call(s) during the recovery: calendar::find-slot success, email::send success; outbox 206 -> 207
```

When the fork's namespace has no stub for a bridged function, the copy gets `function_not_found`,
the same as on one engine. I killed the bridge, waited until `calendar::find-slot` left A's list
(23 ms), and replayed. The agent passed the error to the model, whose input no longer matched the
recording, so the fork paused there:

```
replayed as f11: paused at seq 3 model::complete, input {"messages":[...,{"name":"calendar::find-slot","result":{"error":
  "function_not_found: Function calendar::find-slot not found in namespace rewind-f11. It is registered in namespace(s): default, rewind-f2, rewind-f9."}}]}
calendar::find-slot is back on engine A 2075 ms after the kill
replay once it is back: replayed as f12: done ... (every call recorded)
```

Rewind registers stubs when a fork starts, so a fork started while the bridge is down stays
without them until it runs again.

## 6. Failure across the boundary

The agent hears about a dead worker within a few milliseconds in both cases. What it hears is
different in each, and when engine B itself stops answering it hears nothing for 30 s.

| Case | In-flight call gets | Within | Next call gets | Calls work again |
| --- | --- | --- | --- | --- |
| One engine, tools killed | `invocation_stopped`: "invocation_stopped: Invocation stopped" | 1.7 to 2.3 ms | `function_not_found`: "Function calendar::find-slot not found in namespace default." | 1.0 to 1.25 s |
| Tools killed on B | `bridge_error`: "bridge_error: remote error (invocation_stopped): Invocation stopped" | 2.0 to 4.4 ms | `bridge_error`: "bridge_error: remote error (function_not_found): Function calendar::find-slot not found in namespace default." | 0.97 to 1.27 s |
| Bridge killed on A | `invocation_stopped`: "invocation_stopped: Invocation stopped" | 1.6 to 2.2 ms | `function_not_found`: "Function calendar::find-slot not found in namespace default." | 0.64 to 1.16 s |
| Engine B frozen (SIGSTOP) | `bridge_error`: "bridge_error: invocation timed out" | 29.8 to 30.0 s | the same, 30 s later | 0.86 s after SIGCONT |
| Engine B killed (SIGKILL) | `bridge_error`: "bridge_error: invocation timed out" | 29.8 s | the same, 30 s later | 2.8 s after B's compose started again |

Each row is three killed `find-slot` calls, except the two engine B rows, which are one each
(`measure/failure.ts`, `measure/unreachable.ts`). The 30 s is the bridge's default `timeout_ms` for
a forward. The bridge does not fail fast when B's socket closes, and killing B's engine also took
down B's compose daemon and every worker on B, which nothing restarted.

**Did it run?** In every case where an `email::send` was in flight, the invite went out:

```
one engine, tools killed 100 ms in:  caller got invocation_stopped; outbox lines with this subject 4 s later: 1
tools killed on B:                   caller got bridge_error (invocation_stopped); outbox: 1
bridge killed on A:                  caller got invocation_stopped; outbox: 1; B recorded email::send as error invocation_stopped after 125 ms
engine B killed:                     caller got bridge_error: invocation timed out; outbox: 1
```

When the bridge died, engine B ended the call as `invocation_stopped` because its caller went away,
and Rewind B recorded an error, but the tools process kept going and its POST succeeded. B's own
recording says the send failed while the invite went out.

**Can a caller tell "the callee failed" apart from "nobody knows whether it ran"?** On one engine,
mostly yes, by code: `invocation_failed` means the callee ran and raised, `function_not_found` means
it never ran, and `invocation_stopped` means it died partway. Across the bridge, every remote
outcome has the code `bridge_error`, and the difference survives only as text in the message. An
unreachable engine gives "invocation timed out", which says nothing about B, and a dead bridge
gives A's own `invocation_stopped`, which looks like a local worker death although the call kept
running on B.

**Lost-work detection** still works in all three kill cases, because it reads the text and the
messages still contain `invocation_stopped` or `function_not_found` with a function Rewind knows:

```
tools killed on B:  rewind::lost lists 8 new run(s), lost at seq 4: "... failed: bridge_error: remote error (invocation_stopped): Invocation stopped"
bridge killed:      rewind::lost lists 7 new run(s), lost at seq 3: "... failed: invocation_stopped: Invocation stopped"
one engine:         rewind::lost lists 8 new run(s), lost at seq 3
```

I did not send agent runs through a frozen engine B, but "bridge_error: invocation timed out" has
neither mark, so Rewind would not count those runs as lost.

**Recovery** works only when the bridge dies:

- *Bridge killed.* The killed call is missing from the recording, as on one engine, so the
  recovery replays seq 0 to 2 and pauses at `find-slot`. A live answer reaches B. Then it pauses at
  `email::send` with `effects []` and `live` among the choices, and answering live sent the invite
  (outbox 206 to 207). On one engine the recovery runs `find-slot` live without asking and stops at
  `email::send` marked irreversible.
- *Tools killed on B.* The bridge's forward function completed on A with an error, so with
  recording on, A recorded the lost call as an ordinary `bridge_error` at seq 3. The recovery
  replays that recorded error and ends where the run ended: `done {"reply":"I couldn't book it,
  because calendar::find-slot failed: bridge_error: remote error (function_not_found) ..."}`, with
  no call to B. With recording off, the call is missing, and the recovery behaves like the bridge
  case, including the live send (the e2e failed "recovering wrote nothing to the outbox").
- *Worker changes.* Rewind A shows the bridge disconnecting and connecting again, but nothing at
  all when tools die on B: `worker changes Rewind A has around the kill: none`.

Compose also matters here. The agent starts after the bridge, and compose gives up on a container
after 5 restarts unless it stays up for 60 s. After the sixth kill of the bridge it stopped what
depended on it, including Rewind A (`results/compose-a-gave-up-on-bridge.txt`):

```
[compose:default] bridge did not stay up after 5 restart attempts: giving up
[compose:default] stopping what depended on bridge: rewind, traffic, agent
```

The two-engine compose files raise `max_attempts` so the measurements could go on.

## 7. The 60 e2e checks

`experiments/multi-engine/e2e.ts` is `scripts/e2e.ts` with only the addresses changed: Rewind and
the outbox are on A, and the tools worker it kills and waits for is on B. The baseline ran the
original script against the one-engine stack and passed all 60.

**With Rewind's defaults** (`results/e2e-split-defaults.txt`), 30 of 38 checks passed, and 22 never
ran. Rewind A does not record `email::send`, so the script never finds a booked run with one send,
or one with two, and every check that needs one is skipped. These failed:

1. a booked run was recorded
2. TypeError: the replay ends the way the recording did (paused at the unrecorded `find-slot`)
3. TypeError: every call came from the recording (3 of 4)
4. a sent twice run was recorded
5. with live calls, every SyntaxError run runs through to a reply on the patched code (26 stopped at
   `find-slot`, choices typed, inject, stop)
6. the lost run shows tools disconnecting and a new tools worker connecting again
7. the recovery replays the finished calls, runs the rest live, and stops at the irreversible call
8. recovering wrote nothing to the outbox (the recovery sent an invite)

These 22 never ran: the replay, every-call and both-sends checks for the booked and sent-twice
runs, rerun timing, the holiday fetch, the email POST and the POST not being a run call, trace and
span ids for calls and forks, bug 2's span, all seven holiday-server and holiday-fork checks, and
the three inbound request checks.

**With recording on** for the two bridged tools (`results/e2e-split-recording-on.txt`), 54 of 60
passed. These failed:

1. the Python POST to the email provider is recorded under `email::send`. The tools' preload
   writes it to engine B's capture file, and Rewind A reads only its own.
2. bug 2: `find-slot` shows `find_slot` raising TypeError. That function span is also in B's file.
3. filled lists the one `email::send` of each run that booked. The live check filled
   `calendar::find-slot` too (84 fills), because with no effects it never runs live. It took another
   run's slot: run 9f00b377 "Booked Thursday 5 Nov at 1:00 pm with Sofia" with the slot
   `{"attendee":"omar@example.com","start":"2026-11-05T13:00:00-06:00"}` from run 4233fc45.
4. the lost run shows tools disconnecting and connecting again (nothing on A).
5. the recovery replays the finished calls, runs the rest live, and stops at the irreversible call
   (it replayed the recorded `bridge_error` instead).
6. the recovered run books once the send is answered (it failed again the same way).

In both runs, "the repaired fork ends done with status booked" passed, with the replies "Booked
undefined with Omar" and "Booked undefined with Sofia". The fork could not run `find-slot` live, so
the script typed the send's answer into it, and the agent booked a slot with no time.

## What each builder has to know

**App workers (agent and tools).** No code changed. The branch has no diff under `workers/` or
`scripts/`. Every function id stayed the same, and the agent calls `calendar::find-slot` on A as
before. What changed is compose:

- the tools moved from A's compose file to B's;
- the agent's `start_after` lists `bridge` instead of `tools`, because the tools no longer exist on
  A and the forwards have to be registered before the agent's first call;
- `EMAIL_URL` on the tools has to be the email provider's address as B reaches it. Here both
  engines share a host, so it is the same `http://127.0.0.1:50036/email` the baseline uses.
  `PROVIDERS_PORT` and `HOLIDAYS_URL` changed only because the experiment uses other ports than
  the main stack, and they are the same in the baseline.

The agent did have to cope with different errors without being told. It retries `email::send` only
on the code `TIMEOUT`, which still comes from its own SDK because its 1.5 s timeout is shorter than
the bridge's 30 s. My probe, with a 45 s timeout, got `bridge_error: invocation timed out` at
30 s, so a caller whose timeout is longer than the bridge's gets `bridge_error` instead of
`TIMEOUT` and would not retry. Any code that branches on an error code now sees `bridge_error`.

**The person running the system.** The bridge config said three things: the peer's address, one
`forward` entry per function with its name on each side, and nothing else (it is quoted in full
above). There were no `expose` entries, because B never calls A. The config has no field for
namespaces: the forwards land in `default` on A, and the bridge's connection to B is in `default`
there too. It has no field for auth: the peer URL is plain `ws://`, and the only control is which
functions are listed. It has no field for metadata, so effects, schemas and descriptions from B do
not come across. The person also has to know each function id on B by name, since nothing lists
them, pick a forward timeout (30 s unless set), and order startup so the agent waits for the
bridge. The compose restart budget then decides what else goes down when the bridge flaps.

**Rewind, as a plugin that sees the whole system.** On one engine, Rewind learned everything from
one function list and one stream of events. Across two, it needed to know:

- which functions are bridged. They show up as owned by worker `bridge`, and nothing on A says
  where they go;
- their effects, which exist only on B. Without them Rewind does not record the tools, a fork
  cannot run them live, a check borrows another run's answer, and recovery does not mark
  `email::send` irreversible;
- that recording has to be turned on by hand for each bridged function;
- that a recorded `bridge_error` whose message says `remote error (invocation_stopped)` is lost
  work, so recovery should not replay it as an answer;
- when the tools worker on B comes and goes, which only B's engine reports;
- the requests around iii and the function spans from B's workers, which are in B's capture file;
- B's half of each trace, which is in B's trace store;
- that ids do not line up. A and B give one call two invocation ids, B's caller has no function or
  invocation id, and the trace id identifies only the run. The parent span id in B's trace store,
  or the input and start time, are the only ways to pair calls;
- that its own live calls reach B as ordinary calls from `bridge`, where B's Rewind records them.

Rewind did not need to know anything about namespaces. Forks stay on A, and the stubs cover the
bridged functions because they are in A's list.

**What each Rewind sees of the other side's payloads.** Each side keeps the other's payloads in
full, by default, with nothing in the bridge config to limit it.

- Rewind B and B's trace store keep the full input of every call A makes into B (attendee
  addresses, subjects) and the output B returns. B's trace store also has A's trace id and the span
  ids of A's bridge spans, through `traceparent`. B sees nothing of A's functions or invocation
  ids, only the worker name `bridge`.
- Rewind A, with recording on, and A's trace store keep B's outputs in full. A's trace store kept
  the bridge span's payloads as events:
  `iii.invocation.input: {"start":"...","subject":"15 minutes, Monday","to":"dana@example.com"}` and
  `iii.invocation.output: {"id":"msg_1b1202be48c0","status":"accepted"}`. A also sees B's internal
  error messages inside `bridge_error`, such as
  "unsupported type for timedelta minutes component: str", but not B's stacktraces, which the
  bridge drops. On one engine the caller got the Python stacktrace with absolute file paths.
- Neither side sees the other's requests around iii or its function spans. Those stay in each
  engine's own capture file and trace store.

Across companies, each side would be recording the other side's data and internal error text in
its own database and trace store.

## What Rewind would need across many engines

In the order I would build it:

1. **Effects that cross the bridge.** Everything else depends on this, and losing `irreversible`
   is what sent an invite. The fix belongs in the bridge: copy the remote function's metadata,
   description and formats onto each forward when it registers it. Until then, Rewind could read
   the bridge's configuration entry to find the forwards and the peer's URL, list the peer's
   functions, and take effects from there. As a stopgap, Rewind should treat a function with no
   declared effects as irreversible in recovery, the way a debug fork already refuses to run it.
2. **Peers as part of the system.** From the same bridge config, Rewind would connect to each peer,
   observe `engine::on-workers-changed` there, and show a peer worker's comings and goings in a run.
3. **Lost work behind the bridge.** Recognize `bridge_error` messages that quote
   `invocation_stopped` or `function_not_found` as lost calls, set `lost_at` to the failed call
   rather than the next one, and run that call again in recovery instead of replaying the error.
   Treat "invocation timed out" from the bridge as possibly lost too.
4. **One recording across engines.** Run a Rewind per engine, or one that connects to every engine,
   and join calls by trace id plus parent span id, which already links B's `execute` span to the
   bridge's span on A. Rewind would need to store each call's parent span id. Carrying the caller's
   invocation id across the bridge would be simpler, but the bridge drops it today.
5. **Rewind's own calls marked across the boundary.** Mark live calls Rewind makes, for example in
   baggage, so a Rewind on another engine can leave them out the way it does at home.
6. **Captures and spans over iii.** Send what the preloads capture through a function on the
   worker's own engine instead of a local file, and read B's trace store for B's half of a trace.
   On one host a shared capture file would work, but across hosts it cannot.
7. **A payload policy per peer.** Let the operator choose what each side records of the other's
   inputs, outputs and error text, and redact the rest before it is stored.

## What I would measure next

- The same numbers over a network between two hosts. Everything here ran on loopback.
- Many concurrent calls through the bridge, which sends everything over one connection to B:
  throughput and p99 at 100 and 1000 calls in flight.
- A network partition that drops packets, compared with the frozen engine, which gave 30 s per call.
- A caller whose own timeout is equal to or longer than the bridge's 30 s, to see which side gives
  up first and what code the caller gets.
- Three engines in a chain through two bridges: whether the trace still links, and how the error
  messages nest.
- The e2e copy again once effects come across the bridge, to see which failures go away.

## What I could not measure

- **Latency between hosts.** Both engines ran on one machine, so the numbers are loopback numbers.
- **The ADE's Traces view of B's half.** Rewind's page was not built for the experiment, so I did
  not open it. The finding that A's store has none of B's spans comes from `engine::traces::spans`.
- **Auth between engines.** The 0.25.0 bridge config has no field for TLS, tokens or per-peer
  rules, so there was nothing to turn on.
- **A partition separate from a frozen process.** I froze engine B's process with SIGSTOP instead,
  which keeps the socket open and sends nothing, as a partition would.

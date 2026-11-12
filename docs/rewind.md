# How Rewind works

Rewind is a Rust worker. It records calls between iii functions, and the HTTP requests that go
around iii, replays a recorded request against the worker's own code, and lets you fork the replay
by changing an answer. This file is the spec
for the worker and the functions its UI calls. Facts about iii come from the spikes in
`docs/spike.md` (0.25.0) and `docs/spike-0.26.md` (0.26.0).

## Where things are

The worker's code is in `workers/rewind/src`.

| Concept | Module |
| --- | --- |
| Recording | `recording.rs` observes functions and stores each call on a writer thread, `store.rs` keeps the events, `settling.rs` tells the page about a run once its calls have arrived |
| A run | `runs/`: `mod.rs` finds roots and summarizes, `steps.rs` rebuilds a run's calls, `inference.rs` works out what the caller saw, `search.rs` filters the list |
| Replay | `replay/session.rs` places each call a copy makes, `replay/stubs.rs` has the stub handlers and `run_in` |
| The decision | `replay/decision.rs`: `decide`, the `runs_live` table and `choices`; `effects.rs` parses declared effects |
| Forks | `forks/mod.rs` starts, edits, answers and reruns a fork; `forks/record.rs` is what the store keeps and the page sees |
| Recovery | `recovery.rs` lists lost runs and starts their recoveries, `runs/lost.rs` finds the call a dead worker cut off |
| Checks | `checks.rs` |
| Copies and the pool | `copies/`: `process.rs` runs one copy, `space.rs` opens a fork's namespaces and registers handlers, `spaces.rs` parks and closes them, `spares.rs` keeps the pool; `pool.rs`, `namespaces.rs`, `sources.rs`, `code.rs` |
| The preload bridge | `outside/` compares requests and sends one live, `captures.rs` reads the capture file, and `copies/space.rs` registers `rewind::outside` |
| The page's functions | `functions.rs` lists every `rewind::*` function and its handler; `changes.rs` is `rewind::changed`, `ui.rs` serves the page |
| Errors and their codes | `error.rs` |
| Saved tests, replayed requests | `fixtures.rs`, `inbound.rs` |

## Recording

Rewind lists the engine's functions with `engine::functions::list` and reads `metadata.effects`
from each. For every function in its record list, it calls `observe` with
`capture: ["input", "output", "error", "caller", "metadata"]`, targeting its own function
`rewind::record`. On iii 0.26 the capture also decides when an observer fires: `input` and
`output` fire it after a successful call and `error` after a failed one, so this capture hears both.
Every Rewind process needs a unique target id. If the engine rejects the target registration with
`FUNCTION_NAMESPACE_CONFLICT`, Rewind exits, because its observers would otherwise deliver to
whoever owns that id.

Each envelope becomes one row. `status` is `success` or `error`, and the JSON columns contain the
envelope's values as text.

```sql
create table events (
  invocation_id        text primary key,
  function_id          text not null,
  namespace            text not null,
  status               text not null,
  input                text,
  output               text,
  error                text,
  caller_worker        text,
  caller_function_id   text,
  caller_invocation_id text,
  started_at_ms        integer not null,
  duration_ms          double not null
);
```

A run starts at a root call in `default`. A call is a root when nothing recorded called it: a
call someone made with `iii call`, such as `calendar::find-slot` on its own, or a request that
arrived at a worker's own HTTP server. The entry function (`agent::run`) is always a root, even
though `traffic::burst` calls it, so the agent's runs stay runs. Rewind's own functions, `engine::*`
and functions with `metadata.internal` are never roots. A run's calls are the events whose
`caller_invocation_id` is the run's invocation id, ordered by `started_at_ms`. Arrival order is not
reliable, because in-process calls are reported in batches after their parent.

Listing roots reads a partial index on `started_at_ms` that has only the events with no caller, so
the thousands of calls a burst makes are never read to find them.

The observer records the callee's outcome, not the caller's. When two calls in a run have the same
function and input and the second starts before the first finished, the caller gave up on the
first one. Rewind marks the first call's answer, as the caller saw it, as a `TIMEOUT` error. That
is what makes bug 3 replay faithfully.

## Calls around iii

Some work never goes through iii: the agent's `fetch` of the holidays API, the email tool's POST
to its provider, a request that arrives at a worker's own HTTP server. A preload in each worker
captures these. Node loads `workers/rewind/preload/node/index.mjs` with `--import`, and Python
loads `workers/rewind/preload/python/sitecustomize.py` through `PYTHONPATH`.

- In Node, the preload replaces undici's global dispatcher, so every `fetch` goes through it. It
  also listens to `http.server.request.start` and `http.server.response.finish` for requests the
  worker's own server receives.
- In Python, it patches `http.client`, which covers urllib, urllib3 and requests. It patches
  httpx's transports when httpx is imported. urllib3 opens its sockets in its own `connect`, so in
  a copy the preload replaces that too, for urllib3 1.26 and 2.x, and a replayed request never
  opens a socket to its host. Python inbound requests aren't captured yet.
- Both wrap the functions a worker lists in its `rewind.json` (for example
  `src/worker.ts:parseArgs`), or in `REWIND_TRACE_FUNCTIONS`. Each call to one becomes a function
  span, and also an OpenTelemetry span under the current one, so it nests in the engine's traces.

Each capture belongs to the iii call it ran in. The Node SDK keeps the current invocation in an
`AsyncLocalStorage` it doesn't export, so the preload wraps `AsyncLocalStorage.prototype.run` and
remembers any storage entered with an invocation. Python has `iii.current_invocation()`, which
`asyncio.to_thread` copies into the handler's thread.

The preloads append one JSON line per capture to `data/captures.jsonl`:

```ts
{ v, kind, id, name, worker, namespace, invocation_id, function_id, trace_id, span_id,
  started_at_ms, duration_ms, input, output, error }
```

`kind` is `fetch`, `http_out`, `function` or `http_in`, and `name` is the function id Rewind shows.
A request's function id is its kind, method and URL, such as
`fetch GET http://127.0.0.1:49335/holidays?from=2026-11-03&weeks=2`. The preloads leave out the
`traceparent` and `baggage` headers, because the SDK adds them and they differ on every run.
Rewind reads new lines every 200 ms, remembers how far it got, and starts over when the file gets
shorter. `REWIND_CAPTURE=off` turns a preload off, and then it loads none of its modules.

Credentials in headers never reach the capture file, though a body is stored as it was sent.
`Authorization`, `Proxy-Authorization`, `Cookie`,
`Set-Cookie`, and any header whose name contains `api-key`, `apikey`, `token`, `secret` or
`password` are stored with their name and `[redacted]` as the value, in requests and responses.
`REWIND_REDACT_HEADERS` adds more names, comma separated. Matching ignores headers, so a replay
still finds each request. A copy's preload hands back no header whose recorded value is
`[redacted]`, and a copy's server never sees one either.

When a copy asks Rewind about a request, its preload leaves the secret headers out and lists
their names in `redacted_headers`. Rewind stores the question in the fork, and it may send the
request live, so it never gets a credential or the placeholder. A live call to a service that
needs a credential goes out without one, and the fork gets whatever the service says, usually a
401, unless Rewind's own environment has a value for that header. For each header the question
lists, and each one a capture stored as `[redacted]`, a live send adds the value of
`REWIND_LIVE_HEADER_<NAME>`, where `<NAME>` is the header's name in capitals with every
character that is not a letter or a digit turned into `_`, such as `REWIND_LIVE_HEADER_X_API_KEY`
for `x-api-key`. Rewind reads the variable for each send and never stores the value, so it
appears in no capture, fork or answer.

A body over `REWIND_MAX_BODY_BYTES`, 64 KiB by default, keeps its first bytes, cut on a UTF-8
character boundary when it is text. `body_truncated` gives the full length and a SHA-256 of the
whole body. A copy cuts the body of a request it asks about the same way, so the question matches
the recording. Matching compares the stored body and, when either body was cut, the SHA-256 of
the whole body too, so two requests that differ only after the cut don't match. Rewind never
sends a request with a cut body live, because only the start of the body would go out. Such a
call never runs live without asking, a pause on it doesn't offer `live`, a live send of it fails
with `REWIND_BODY_TRUNCATED`, and an inbound request with a cut body is not replayed.

Requests are stored in `events` with the iii calls, because replay needs them:

- A request the run's own handler made takes a `seq` in the run, the same as an iii call.
- A request made by a callee's worker, such as the POST inside `email::send`, is listed under that
  call as `inner` and never takes a `seq` of its own. A replay makes it only when the fork copies
  that worker, and then it is matched under its call, as described under "Where a call is".
  Otherwise the call it belongs to gets its recorded answer from a stub.
- An inbound request is the root of a run of its own.

Function spans go in `data/spans.sqlite`, on a connection of their own, written in one transaction
per read of the capture file. They're indexed by invocation and by trace id, kept for the newest
200 runs, and read only by `rewind::spans`. Listing, searching, replaying and checking runs never
reads them, and a burst of span writes never makes those queries wait.

Nobody declares effects for a request, so Rewind treats GET and HEAD as `read-only` and every other
method as `external` and `irreversible`.

## Replay and forks

A fork is a list of answers keyed by where each call is in the run, plus a namespace of its own
(`rewind-f<n>`). The original recording is fork zero and never changes.

A fork runs copies of one or more workers. It always copies the worker that owns the run's root
function, the agent for an `agent::run` run and the tools worker for a `calendar::find-slot` run.
`copy` lists any other workers to copy, for example `copy: ["tools"]` on an agent run. A call to a
copied worker's function runs that worker's code in its copy. Every other call goes to a stub.

Rewind finds each worker's folder from its `containers.<name>.worker: path://…` entry in
`worker-compose.yaml`, and its start command from `scripts.start` in the worker's own
`iii.worker.yaml`, or from `scripts.start` in its `package.json` when the manifest has none. A
worker is found by its container name or the `name` in its manifest. The worker that owns the
entry function is the code under test, so it keeps `REWIND_TARGET_DIR` and `REWIND_TARGET_START`.
`REWIND_COMPOSE_FILE` points Rewind at another compose file.

Running a fork:

1. Make sure each copied worker has a namespace with a connection. The root's worker uses the
   fork's namespace, and each other copied worker gets one of its own, such as `rewind-f3-tools`.
   A connection's namespace is fixed, so each namespace gets its own connection, and they share
   one process. In each namespace, register a handler for every function in `default` that the
   namespace's own copy doesn't run, leaving out `rewind::*` and `engine::*`. When a call arrives,
   the handler passes it on to the namespace of the copied worker that owns the function, or acts
   as its stub when no copy runs it. A copy's own functions are left alone, because the copy
   registers them. Nothing falls back to `default`, so a missing stub is a `function_not_found`.
2. Confirm the stubs are registered (`engine::functions::list` with the namespace) before going
   on. `registerFunction` returns before the engine has the function.
3. Make sure a copy of each worker runs in its namespace. Rewind starts it as a child process with
   `III_NAMESPACE` and `III_URL` set, using the worker's start command, and waits until the
   worker's functions show up in the namespace. If a worker's code has changed since its copy
   started, Rewind stops that copy, waits for its functions to leave the namespace, and starts a
   new one, so a replay always runs the code on disk. A rerun that registers no new handler and
   finds every copy still running on the same code skips the waits in steps 2 and 3. Rewind hashes
   a worker's folder at most once every half second, so reruns back to back reuse the version it
   read last, and an edit shows up on the next rerun after that.
4. Call the root function in the fork's namespace with the run's recorded input and a long
   timeout (120 s). Rewind makes the call with a caller of its own, a token it makes up for the
   rerun, so it can tell which invocation in the copy is the run.
5. Each stub call takes the next place under the call that made it, and picks its answer in this
   order:
   - the fork already has an answer at this place for this function: return it;
   - the original recording has a call at the same place under the matching recorded call, with
     the same function and the same normalized input: return the recorded answer and add it to
     the fork as `recorded`;
   - the function is one of the fork's `stops`: pause, with reason `stop`;
   - the fork has `auto` on: pick a safe default, as described under "Auto and stops";
   - the fork has "run read-only calls live" on and the function's effects are `pure` or
     `read-only`: call the function in `default`, and add the result as `live`;
   - otherwise the fork is paused. Store `{ seq, path, function_id, input, reason }` as the fork's
     pending call and fail the stub call with code `REWIND_PAUSED`, so the copy's run ends
     quickly.
6. When the root call returns, the fork's outcome is `paused` if a pending call was stored,
   otherwise `done` with the output or `crashed` with the error.

Answering a pending call (`rewind::answer`) adds the answer at that place and runs the fork again
from step 4. Nothing waits on a caller's timeout while a person decides, because every rerun takes
milliseconds when the answers are known.

### Spare copies

Starting a copy and waiting for its functions to show up is most of the time a new fork takes, so
Rewind keeps a few spares ready. A spare is a fork namespace, `rewind-f<n>` with a fork number
reserved for it, where steps 1 to 3 have already run for the worker under test: the connection is
open, the handlers are registered, and a copy of the worker is running. `REWIND_POOL_SIZE` says how
many spares Rewind keeps, 4 by default because the page recovers four runs at once. With 0, Rewind
keeps none and every fork starts its own copy.

- A new fork from `rewind::replay`, `rewind::fork` or `rewind::recover`, and each `rewind::test`,
  takes the oldest spare when its root runs in the worker under test. The fork gets the spare's
  number, so its namespace is still `rewind-f<n>`. If the spare is still starting, the fork waits
  for it. Rewind starts a new spare in its place straight away.
- The handlers can be registered ahead, because none of them depends on the fork. A stub looks up
  the recording and the fork's answers in the session that Rewind installs right before each
  rerun. A handler decides on each call whether to stub it or pass it on. When a fork also copies other
  workers, it opens their namespaces and starts their copies itself, the way it always has, and
  the spare's handlers then pass those workers' functions on to them.
- A spare goes to one fork only. Once a fork has it, it is that fork's namespace and closes with
  the fork.
- Rewind checks the spares every second. When the code on disk has changed, each spare's copy
  restarts in place the same way a fork's copy does in step 3, and keeps its number. A fork also
  checks its copy in step 3, so a fork that takes a spare before the check still runs the code on
  disk.
- A spare that failed to start is tried again 10 s later. A fork that takes it in the meantime
  starts its own copy under the spare's number.
- Rewind stops every spare when it stops. A copy whose Rewind died stops by itself, as described
  under "Traces". Numbers reserved for spares no fork took are skipped, so fork numbers can jump
  by up to `REWIND_POOL_SIZE` after a restart.

Checks, inbound replays, forks of runs whose root is in another worker, and the other workers a
fork copies all start their copies cold. Each spare is an idle Node process of about 100 MB.

### Paused forks

A paused fork keeps its namespaces and copies open, so the rerun after an answer takes
milliseconds. Rewind closes them once the fork has waited `REWIND_PAUSED_IDLE_SECS` since its last
rerun, 300 s by default. It also keeps at most `REWIND_PAUSED_OPEN` paused forks open at once, 8 by
default, and closes the copies of the forks that paused longest ago first. The fork itself stays
paused. Answering it, or changing it with `rewind::fork-set`, opens its namespaces again and starts
its copies cold, which takes a few seconds.

Each namespace has a lock of its own, so a fork that opens its namespace never waits while another
fork's copy starts or stops.

### Where a call is

A call's place is its position among its caller's calls, for each caller from the run down. A call
the run made itself has one number, its `seq`, the same as before forks could copy more than one
worker. The POST inside a copied `email::send` at seq 5 is at `5.0`, and it shows in that call's
`inner` with `seq: 5` and `path: [5, 0]`. The recording has the same tree in `caller_invocation_id`,
so a call matches the recorded call at the same place under the matching recorded caller.

A stub learns who made a call from the SDK: the invocation's `caller` says the calling invocation
and, one level up, that invocation's own caller. A copy's preload also adds
`invocation: { invocation_id, caller_invocation_id }` to each request it asks `rewind::outside`
about, because a Python worker POSTs from a thread the SDK's caller does not reach. Rewind places
an invocation it has not seen by its caller:

- The rerun's caller is Rewind's token, so the copy's run is the run.
- When a call reaches a copied worker's function, the handler that passes it on is the call's
  caller in that worker's copy. Rewind places the handler's own invocation at the call's place, so
  the calls the copy makes inside it are placed under it.
- An invocation whose caller Rewind has placed takes its caller's place, so an in-process call
  inside a copy counts as its caller's.
- A call that says nothing about its caller, or whose caller Rewind has not seen, counts as the
  run's own. That is how a fork with one copy has always matched.

The copy's invocations have ids of their own, and some inputs quote them. The email body quotes
the invocation that called `email::send`. Before it compares inputs, Rewind replaces each id it has
placed with the recorded id it replays, so that body still matches the recording.

A call to a copied worker's function runs in the copy unless the fork has an answer a person
edited, typed or injected at its place. Its call shows with `source: "copy"` and the copy's answer.
When the recording says the caller gave up on that call, the handler waits as long as the recorded
call took before it replies, so the caller's own timeout fires the way it did. Stops don't pause a
copied function, because its code runs. The calls it makes still go through the stubs and
`rewind::outside`, so an irreversible POST inside a copied `email::send` follows the same rules as
any other call: the recording's answer, then a stop, a recovery's lost call, auto, or a pause.
A call inside the call a recovery lost runs again live when it is pure or read-only, and pauses
with reason `lost` otherwise.

### Auto and stops

A fork with `auto` off asks a person at every call that neither the fork nor the recording has an
answer for. With `auto` on, the fork runs to the end on safe defaults, and it pauses only at a stop
or where no safe default exists. For such a call, the stub goes through these steps in order:

1. If the function is in the fork's `stops`, the fork pauses with reason `stop`.
2. In a recovery, if this is the call the worker died while running, or a call inside it, the
   stub runs it again live when every effect it declares is `pure` or `read-only`, since running
   it twice changes nothing. Any other such call pauses with reason `lost`: one that writes, is
   `external` or `irreversible`, declares an effect Rewind doesn't know or none at all, or is a
   request whose body the preload cut.
3. If a person could run the call live in a debug fork, the stub runs it live without asking and
   adds it as `live`. That covers `pure`, `read-only`, and `external` without `irreversible`, and
   also GET and HEAD requests the preloads caught.
4. Otherwise the call is irreversible, writes, or has no declared effects. The stub never runs it.
   It returns the newest successful output the same function gave in another run, the same way a
   live check fills a call, and adds it as `filled`, with `filled_from` set to that run's id.
5. If no other run has such an output, the fork pauses with reason `no_answer`.

`auto` is off unless a caller turns it on, so older callers get the same forks as before. A stop
only matters for a call that has no answer yet. When the recording has the call, the stub returns
the recorded answer, stop or not. Stops also apply with `auto` off, so a stop pauses a call that
"run read-only calls live" or a recovery would otherwise run.

A fork keeps its `auto` and `stops` through `rewind::answer` and every rerun. A fork made with
`rewind::fork` and a `base` takes the base's settings unless the caller gives its own.

`rewind::fork-set` changes a fork's settings and runs it again from step 4. It keeps every answer a
person or the recording gave. Of the answers Rewind chose by itself, the calls it ran live without
asking and the calls it filled, it keeps the ones the new settings would choose again and drops
the rest. So a new stop on `email::send` pauses there, even after an earlier rerun filled the send.

A paused fork's `need.reason` says why it paused:

| Reason | When |
| --- | --- |
| `stop` | the function is one of the fork's stops |
| `no_answer` | nothing could answer the call without a person |
| `lost` | the call a recovery's worker died while running, when it does more than read, which only a person can settle |

A paused fork's `need` also has the paused function's `response_format`, exactly as
`engine::functions::info` reports it, so a page can build the answer a person types from the
schema. Rewind looks it up when the fork pauses and stores it with the fork. A request around iii,
a function that registered no response format, and a fork stored before Rewind passed formats on
have none.

Normalizing input for matching: drop `_caller_worker_id`, then compare as canonical JSON.

A copy starts with `REWIND_CAPTURE=replay`, and its preload sends every request to
`rewind::outside` instead of the network. Each of the fork's connections registers that function
in its namespace. It takes the next place under the call the request ran in and picks an answer
the same way a stub call does, matching the recording on method, URL and body only. When a request
runs live, Rewind makes it itself and returns the response. Copies inherit Rewind's environment, so
if compose sets `HOLIDAYS_URL` on the agent or `EMAIL_URL` on the tools, it has to set the same
values on Rewind, or every replayed request misses the recording.

`rewind::replay` on an inbound run starts a copy of the worker that received it, found the same way
in `worker-compose.yaml`, in a namespace of its own (`rewind-h<n>`). The copy's server listens on a port the system picks, and the preload
prints the address. Rewind sends the recorded request there, and the replay ends with the response.
The namespace gets the same stubs and `rewind::outside` as a fork's, so an iii call or a request
the handler makes gets the answer recorded under the inbound request. The replay never runs
anything live, so a call the recording doesn't have fails with `REWIND_PAUSED`, and the handler
sees that error. The replay's `calls` show what the handler called.
Only GET and HEAD requests are replayed. Anything else is refused with `REWIND_NOT_REPLAYABLE`,
because its handler could change something again.

Recorded errors are replayed as errors with the same message the caller saw. The agent copies a
tool's error message into its next model call, so a different message would make that model call
miss the recording.

### What each choice does

| Choice | Allowed when | Answer |
| --- | --- | --- |
| `live` | effects are `pure` or `read-only`, or `external` without `irreversible`; in a recovery fork, any call, because only a person can settle the calls a recovery pauses at, the `lost` call included (a lost call that only reads never pauses, since it runs again on its own) | the function's result, called in `default`. A function whose metadata says `idempotency_key: true` gets `rewind:<run id>:<place>:<hash of the input>` as `idempotency_key` in the call's metadata, so the same send from any fork or recovery of the run has the same key |
| `typed` | always | the JSON the person typed |
| `inject` | always | an error `{ code: "UNAVAILABLE", message: "injected by rewind" }` |
| `stop` | always | deletes the fork, its namespace connection and its copy |

## Recovery

Observers don't report a call cancelled because its worker died. The engine deactivates the
observer before it fails the call. What does get recorded is the run and its completed calls. The
agent catches tool errors and passes them to the model, so an interrupted run usually returns
`status: "failed"` instead of throwing. Rewind counts a run as stopped when `invocation_stopped`
appears in its error, its output, or the input of any of its calls. It also counts a run where
`function_not_found` appears there for a function in its catalog or recorded in `default`, because
that is what calls get while compose restarts the dead worker. A model that makes up a tool name
gets the same error, so a function Rewind doesn't know does not count.

The functions and fields call these runs lost: `rewind::lost` lists them, `lost_at` says where the
call would have been, and a recovery that pauses at a call cut off mid-call has reason `lost`. The
page calls them interrupted runs, and so does the rest of this file.

Recovering a run is a fork in recovery mode. It uses the recorded answers for the calls that
completed, then runs the rest. A call runs live without asking only when every effect its function
declares is `pure`, `read-only` or `external`, the same calls a person may run live in a debug
fork. Every other call pauses for a person to choose: an irreversible call, a call that writes, a
call with an effect Rewind doesn't know (a misspelled one included), and a call whose function
declares no effects. A pause on a function with no declared effects has `effects: []`, so the page
can say that the effects are unknown.

The call at the run's `lost_at` is the interrupted call, and a run can be interrupted in two ways:

- The worker died while it ran the call. The caller got `invocation_stopped`, and the call may
  have reached its provider. `rewind::lost` returns the run with `mid_call: true`. When every
  effect the call declares is `pure` or `read-only`, the recovery runs it again live without
  asking, because running it twice changes nothing. Any other such call pauses there with reason
  `lost`, because nobody can tell whether the provider got it before the worker died: a call that
  writes, is `external` or `irreversible`, declares an unknown effect or none, or is a request
  whose body the preload cut. A call a copy makes inside it follows the same rule.
- The worker was already gone when the run made the call. The caller got `function_not_found`,
  and the call never reached a worker. `rewind::lost` returns the run with `mid_call: false`, and
  the recovery treats the call like any later one: a read-only call runs live, and an
  irreversible or writing one pauses with reason `no_answer`.

Rewind finds the interrupted call from the first call whose input quotes one of the two errors. If
that input quotes `invocation_stopped` at all, the call counts as cut off mid-call, so a person
decides whenever it's unclear. A pause at any call after the interrupted one has reason
`no_answer`, or `stop` at a stop.

With `auto` on, a recovery runs live the same calls it would run with `auto` off, and fills
irreversible, writing and undeclared calls from another run instead of pausing. A call cut off
mid-call is the exception. Unless it only reads, the recovery still pauses there with reason
`lost`, because running or filling it would hide the one question a person has to answer. An interrupted call that failed with
`function_not_found` is filled like any other. `rewind::recover` returns a run's existing
recovery as it is, and `rewind::fork-set` changes that recovery's settings.

## Workers coming and going

Rewind observes `engine::on-workers-changed`, which fires `{ event, worker_id }` when a worker
connects or disconnects, and stores each change in `worker_changes`. The event has only an id, so
Rewind looks names up with `engine::workers::list` while the worker is connected and remembers them,
because a worker that's gone can't be looked up. It keeps workers in `default` and leaves out its
own connections and the copies. A worker that compose restarts comes back with a new id and the
same name. `rewind::run` returns the changes from the run's start to 5 s after it ends, which is
how the player shows tools stopping in the middle of a run.

## Traces

`rewind::record` saves each call's trace id from the invocation's `traceparent`. The engine gives
an observer the trace context the observed call arrived with, so a call is recorded in its
caller's trace. A run that arrived with no trace context, such as each run `traffic::burst` starts,
is the root of its own trace and has nothing to pass on, so a run's `trace_id` is the trace its
calls ran in. The first time someone asks `rewind::run` for a run, Rewind pages through `engine::traces::spans` to find the
`execute` span of the run and of each call, matching on name and a start within 2.5 ms, and stores
the span ids it finds. A fork's calls keep their stub's trace and span on every rerun. Rewind calls
the entry without trace context, so each rerun is a trace of its own, and `rewind::fork-get` fills
in the fork's `span_id` with that rerun's root span.

Stopping a copy sends SIGTERM and waits up to 3 s for the copy's process group to exit before it
kills the group, so the copy's spans reach the engine. In a copy, the preload flushes its tracer
on the first SIGTERM, for at most 1.5 s, and ignores a second one. A fork that finishes returns its
result first and stops its copy afterwards, so its caller doesn't wait for that. If the same
namespace is opened again before the old copy has stopped, Rewind waits for it before starting a
new one.

## Storing and dropping data

`rewind::record` hands each observed call to a writer thread, which stores whatever has arrived in
one transaction, so a burst of calls never waits on SQLite on the SDK's connection thread. Both
databases use WAL with `synchronous = normal`. `data/rewind.sqlite` has one connection that writes,
shared by the writer thread and every other write, and each query takes a read connection of its
own. Rewind keeps four read connections open and opens another when all four are busy. A query
reads the last commit without waiting for the writer, and a slow runs list never makes the writer
wait either. The writer checkpoints the WAL every 10,000 pages, about 40 MB, with a 16 MB page
cache. At SQLite's default of 1,000 pages, half of the writer's time in a burst went to
checkpoints, most of it in fsync.

Up to 20,000 calls wait for the writer. When that many are already waiting, `rewind::record` drops
the call and counts it, because waiting for room would stall the SDK's connection thread, and the
engine would then drop calls for every observer. `rewind::status` returns the count as
`recorder.dropped`, next to `recorder.waiting` and `recorder.limit`. Once Rewind has dropped a call,
the recording menu on the page gets a dot and says how many, and Rewind's log says it at most every
5 seconds while the count goes up. The count starts at 0 each time Rewind starts.

The limit trades memory against dropped calls. A waiting call takes about 5 KB of memory at the
size the scale bench makes, 1.5 KB of which is stored: Rewind grew from 66 MB to 328 MB when its
writer fell 55,611 calls behind at 16,000 calls a second. So 20,000 waiting calls are about 100 MB,
and one to two seconds of the writer's work. That covers a checkpoint or a slow commit. A queue
that stays fuller than that means the writer has fallen behind for good, and a longer one would
only grow memory and lose more calls if Rewind stops. The limit counts calls, so calls with bodies
much larger than the bench's take more memory each.

Every 10 minutes Rewind drops the calls that started more than `REWIND_KEEP_DAYS` ago, 7 by
default, or before the newest `REWIND_KEEP_RUNS` runs of the entry function, 20000 by default. A
value of 0 turns that limit off. The same pass drops the worker changes from before then, and every
fork that was made before then or whose run is gone. Spans are kept for the newest 200 runs.

Once `data/captures.jsonl` is longer than `REWIND_CAPTURE_MAX_MB`, 64 by default, and Rewind has
read all of it, Rewind renames it to `captures.jsonl.moved`. The preloads open the file by name for
each line, so the next line starts a new file. Rewind waits a second for a line that was being
written as the file moved, reads the rest of the moved file, starts its offset over at 0, and
deletes the moved file. If Rewind stops in between, it finishes the moved file when it starts.

A code version is a hash of the files in a folder: the target folder every second, and a copied
worker's folder before a rerun. It leaves out `node_modules`, `.venv`, `dist`, `__pycache__` and
`.git`, and every file Rewind writes: both databases with their `-wal`, `-shm` and `-journal`
files, the capture file and its `.moved` file, and `tests/rewind`. Rewind compares resolved paths,
so its files stay out whatever `REWIND_TARGET_DIR` points at, `..` and links included.

Reading its own database would also crash Rewind. When a process closes any descriptor of a file,
it loses every POSIX lock it had on that file, including the ones SQLite took. After Rewind hashed
its own `-shm` file, the next process to open the database didn't find a lock on it, decided it was
the only connection, and truncated the file. Rewind still had the file mapped, so its next read of
the WAL index was a SIGBUS.

## Tests

`rewind::save-test` writes a finished fork to `tests/rewind/<name>.json`:

```ts
{ entry, input, answers: [{ seq, path?, function_id, input, match?, answer, source, hold? }], expect }
```

`entry` is the run's root function and `input` its recorded input. Each answer is a call the
fork's latest rerun made: its place, its function, the input it sent without `_caller_worker_id`,
the answer it got and where that answer came from. A call the caller gave up on also has a `hold`,
so the test waits as long as the recorded call took and the caller's timeout fires again. `expect`
is `{ status }` when the fork returned an output with a `status` string, `{ output }` with the
whole output when it returned anything else, and `{ throws }` with the error message when it
crashed. A paused fork is refused with `REWIND_FORK_PAUSED`.

`rewind::test` runs the file in a copy of the root's worker, on a spare when there is one, and
nothing runs live. A call gets the saved answer at its place when it is for the same function and
sends the same input, compared the way a replay compares an input with the recording. An answer
with `"match": "function"` in the file skips the input, for a call whose input changes on every
run. Any other call pauses the run. The test passes when the run returns the expected `status`, or
exactly the expected `output`, or crashes with the expected message. A paused run fails, and the
result's `diverged` says where: the call's place, function and input, what the file has at that
place under `saved`, and under `differences` each field of the input that changed, as a JSON
pointer with the value the file saved and the one the call sent. `saved` is left out when the file
has no call at that place, and `differences` is empty when the file has another function there.
Rewind doesn't store a test run as a fork.

A file whose answers have no `input`, saved before tests compared inputs, is refused with
`REWIND_BAD_FIXTURE` until someone saves it again or adds `"match": "function"` to each of those
answers. A test copies only the root's worker, so a call that ran in another worker's copy in the
fork gets the copy's answer back from a stub.

`rewind::test` takes a test's name, a path from the project folder, or an absolute path, and the
file has to be inside `tests/rewind`. A path that leads anywhere else, with `..` or through a
link, is refused with `REWIND_BAD_INPUT`. `npm run saved-tests` calls it for every file in the
folder and exits with 1 when any test fails.

## Functions

Every function takes and returns JSON. The UI only talks to Rewind through these.

| Function | Input | Output |
| --- | --- | --- |
| `rewind::status` | `{}` | `{ engine, entry, recording: [function_id], recorder: { waiting, limit, dropped }, runs, inbound_runs, forks, target_code: CodeVersion \| null }` |
| `rewind::functions` | `{}` | `[{ function_id, worker, effects, recording, request_format?, response_format? }]` |
| `rewind::record-toggle` | `{ function_id, enabled }` | the function's new row |
| `rewind::runs` | `{ filter?: "all" \| "failed" \| "stopped", q?, limit?, root?: "entry" \| "http_in" \| "all" \| "any", function_id?, before_ms?, since_ms? }` | `[Run]` |
| `rewind::run` | `{ run_id }` | `{ run: Run, calls: [Call], forks: [ForkSummary], worker_changes: [WorkerChange] }` |
| `rewind::spans` | `{ invocation_id }` | `[Span]`, in start order |
| `rewind::replay` | `{ run_id, auto_read?, auto?, stops?, copy?: [worker] }` | `Fork` with `edit_at: null` |
| `rewind::fork` | `{ run_id, base?: fork_id, at_seq, answer: { value } \| { error }, source: "edited" \| "injected", auto_read?, auto?, stops?, copy? }` | `Fork` |
| `rewind::fork-get` | `{ fork_id }` | `Fork` |
| `rewind::fork-set` | `{ fork_id, auto?, stops? }`; a setting left out stays as it is | `Fork`, after running it again from the start |
| `rewind::answer` | `{ fork_id, choice, value?, auto_read? }`; for `typed`, `value` is the raw JSON | `Fork`; `stop` returns it crashed with `REWIND_STOPPED` |
| `rewind::lost` | `{}` | `[Run & { lost_at, mid_call, recovery: ForkSummary \| null }]` |
| `rewind::recover` | `{ run_id, auto?, stops?, copy? }` | `Fork` in recovery mode, or the run's existing one |
| `rewind::save-test` | `{ fork_id, name? }` | `{ path, fixture }`, with `path` from the project folder |
| `rewind::test` | `{ path }`, a path or a test name | `{ pass, expected, outcome, diverged? }`, with `diverged: { seq, path?, function_id, input, saved?: { function_id, input? }, differences: [{ field, saved?, sent? }] }` when the run paused |
| `rewind::check` | `{ run_ids, live?, copy? }`, at most 500 runs | `[CheckResult]`, in input order |

`copy` lists the workers to copy besides the root's own. A fork made with a `base` takes the base's
`copy` unless the caller gives its own. A worker that isn't in `worker-compose.yaml` is refused with
`REWIND_NOT_FOUND`. A check runs every run on the same copies, so its runs have to be runs of one
worker's functions.

A function row's `request_format` and `response_format` are the JSON schemas the function
registered, exactly as `engine::functions::info` reports them, where they're called
`request_schema` and `response_schema`. `engine::functions::list` has no formats, so Rewind asks
`engine::functions::info` for them, 32 functions at a time, each time it builds the rows. A
function that registered none has neither field, and a lookup that fails leaves both out.
`rewind::record-toggle` returns its row the same way.

The `failed` filter also matches runs where any call returned an error. `q` is matched without
case against a prefix of the run id, a prefix of any of its calls' invocation ids, and the text of
its input, output and error, so an id copied from the traces view finds its run. `root` defaults to
`entry`, the agent's runs. Every fetch the agent makes also arrives at the clock worker as an
inbound request, so including inbound runs by default would bury the agent's runs. `all` adds the
inbound runs, and `any` lists every root. `function_id` lists only the roots of one function, such
as `calendar::find-slot` calls made with `iii call`, and `root` is ignored then. A function that
has to start a copy of a worker takes from half a second to a few seconds longer. A fork that
takes a spare skips that wait, but a recovery's live calls take time of their own, so callers
should pass a timeout of about 120 s.

A list returns at most 500 runs, from the newest 2000 that start inside the window. `before_ms`
and `since_ms` set that window on `started_at_ms`. `before_ms` leaves out runs that started at that
millisecond or later, so passing the oldest `started_at_ms` of one page gets the next one.
`since_ms` keeps runs that started at that millisecond or later. `rewind::status` gives the total.

`rewind::check` replays each run against the code on disk, one after another on a single copy in
a namespace of its own (`rewind-c<n>`), which is deleted afterwards. Checks are not stored as
forks. A result is `stopped` if the replay reached a call it couldn't answer, `same` if it ended
like the recording, and `different` otherwise. Fields that differ between two replays of the same
recording are ignored when comparing. The second replay reuses the first one's answers, so it
makes no live calls of its own.

By default a check makes no live calls, so any call the recording doesn't have stops it. With
`live: true`, such a call runs live in `default` when its effects allow it (pure, read-only, or
external without irreversible). Anything else, meaning irreversible, writes or undeclared, never
runs. Rewind returns the newest successful output of the same function from another run instead,
and lists it in `filled`. If there is no such output, the run stops at that call. A fork with
`auto` on fills calls the same way.

`rewind::changed` sends `{ kind, id }` with `kind` one of `run`, `fork`, `lost`, `code` (the id is
the new code version), `recorder` (the id is how many calls Rewind has dropped since it started)
and `check` (the id is the run, and the event also has the `check` result).
A `fork` event also has the rerun's `trace_id`. It is a private function that returns the event it
is called with, so a page observes it (`iii.observe('rewind::changed', handler)` from the console)
and Rewind calls it once per event.

A run's `run` event waits for the run's calls, because in-process calls are reported in batches
after their parent. It goes out once no call or capture for the run has arrived for 300 ms, and
never later than 2 s after the run itself arrived. A `lost` event for a stopped run goes out with it.
A capture that lands after that sends a `run` event of its own.

```ts
type CodeVersion = { version: string; changed_at_ms: number }

type CheckResult = {
  run_id: string
  result: "same" | "different" | "stopped"
  recorded: Fork["outcome"]
  outcome: Fork["outcome"]
  stopped_at?: { seq: number; path?: number[]; function_id: string }
  code: CodeVersion
  live_calls: number
  live: { seq: number; path?: number[]; function_id: string }[]
  filled: { seq: number; path?: number[]; function_id: string; from_run_id: string }[]
}

type WorkerChange = {
  at_ms: number               // epoch milliseconds
  worker: string
  worker_id: string
  event: "connected" | "disconnected"
}

type Span = {
  id: string
  name: string                // the traced function, such as "parseArgs"
  worker?: string
  invocation_id?: string      // the iii call it ran in
  function_id?: string
  trace_id?: string
  span_id?: string
  started_at_ms: number
  duration_ms: number
  status: string
  input: unknown
  output?: unknown
  error?: unknown
}

type Run = {
  run_id: string
  function_id: string          // the root's function, such as agent::run or calendar::find-slot
  status: "success" | "error" | "stopped"
  input: unknown
  output?: unknown
  error?: { code?: string; message: string }
  started_at_ms: number
  duration_ms: number
  calls: number
  code_version: string | null  // the agent's code on disk when Rewind recorded the run
  trace_id?: string
  span_id?: string             // the run's own execute span, once someone has asked for the run
}

type ForkSummary = Omit<Fork, "calls"> & { created_at_ms: number }

type Answer = { value: unknown } | { error: { code?: string; message: string } }

type Call = {
  seq: number                // for a call inside another call, the seq of the run's call it is in
  path?: number[]            // a call inside another call: its place under each caller, from the run down
  function_id: string
  worker: string
  effects: string[]
  input: unknown
  answer: Answer
  source: "recorded" | "edited" | "injected" | "live" | "typed" | "filled" | "copy"
  filled_from?: string       // for a filled call, the run its answer came from
  inferred?: string          // why the caller's view differs from the callee's outcome
  invocation_id?: string
  started_at_ms?: number
  duration_ms?: number
  kind: "iii" | "fetch" | "http_out" | "function" | "http_in"
  outside_iii: boolean
  method?: string            // for a request
  url?: string
  inner?: Call[]             // requests the callee's worker made while it ran, or in a fork, the calls a copied call made
  trace_id?: string
  span_id?: string           // the callee's execute span when recorded, the stub's in a fork
  rerun_at_ms?: number       // in a fork: ms from the start of the latest rerun to when the stub got the call
  rerun_ms?: number          // in a fork: how long the stub took to answer, including any wait
}

type Fork = {
  fork_id: string
  run_id: string
  parent: string | null      // fork id, or null for a fork of the original
  edit_at: number | null
  namespace: string
  mode: "debug" | "recover"
  auto_read: boolean
  auto: boolean                // run on safe defaults, and pause only at a stop or where there is none
  stops: string[]              // function ids to pause at whenever they have no answer
  copy: string[]               // the workers the fork runs copies of, the root's first
  code: CodeVersion | null     // the code of the root's worker this fork ran
  trace_id: string | null      // the latest rerun's trace
  span_id: string | null       // and its root span
  rerun: { started_at_ms: number; duration_ms: number } | null  // the latest rerun, from the entry call to its return
  calls: Call[]
  outcome:
    | { state: "done"; output: unknown }
    | { state: "crashed"; error: { code?: string; message: string } }
    | { state: "paused"; need: Need }
}

type Need = {
  seq: number
  path?: number[]            // for a call inside another call, the same as Call's
  function_id: string
  input: unknown
  effects: string[]          // empty when the function declares none
  choices: string[]
  reason: "stop" | "no_answer" | "lost"
  response_format?: unknown  // the paused function's response format, the same as in rewind::functions
  trace_id?: string          // the stub call that paused
  span_id?: string
}
```

A fork's calls keep their recorded `started_at_ms` and `duration_ms`. `rerun_at_ms` and `rerun_ms`
time them inside the latest rerun instead. The rerun's clock starts right before the entry call,
after any copy has started. When the stub waits before answering, to reproduce a caller's timeout,
that call can still be waiting when the rerun ends, so its `rerun_ms` is the whole wait.

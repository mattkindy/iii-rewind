# Rewind: design notes

Rewind is an iii worker that records the calls between functions. You can replay a recorded
request against the worker's own code, fork it by changing one answer, and recover requests that
were in flight when a worker died. Each function's declared effects decide what a fork may run
against the live system.

`iii compose --up` starts a scheduling agent in TypeScript, its tools in Python, a fake model, a
clock, Rewind in Rust, and the ADE, where Rewind's page lives. The agent has three planted bugs
(`BUGS.md`), each depending on an answer that won't come back if you ask again.

The mechanics are in `docs/rewind.md`, and the experiments behind them in `docs/spike.md`.

## How it works, briefly

- **Recording.** Rewind observes each function that declares effects, capturing `error` as well
  as `input` and `output`, so it hears about failed calls as well as successful ones. Each
  event has the input, the outcome and the caller's invocation id, which is enough to rebuild a
  request's tree of calls. The app's workers don't change.
- **Replay.** Rewind starts a copy of the agent with `III_NAMESPACE=rewind-f1`. iii resolves a call
  in the caller's namespace, so every call the copy makes reaches a stub that returns the recorded
  answer.
- **Forks.** A fork is the recording with one answer changed. When the code makes a call the
  recording doesn't have, the fork pauses, and you run it live, type an answer, inject an error,
  or stop. Effects decide which of those are offered.
- **No waiting on a person.** The agent's own timeout would expire while a debugger held a call
  open, so a replay always runs to the end in milliseconds. You step through it afterwards, and
  each new answer reruns the fork from the start.

## The five properties

- **Composable.** Rewind is a separate worker, and the copy it replays runs unchanged.
- **Observable.** Every recorded call comes from `observe`, and each one links to its span in the
  ADE's Traces screen.
- **Discoverable.** Rewind reads the function list and each function's effects at runtime, and
  follows workers connecting and disconnecting.
- **Extensible.** Rewind's page runs inside the ADE, effects are plain metadata, and a stub is an
  ordinary iii function.
- **Reactive.** Rewind sends `rewind::changed` as each call lands, so the page fills in live.

## What happens to in-flight work when a worker stops

The demo kills the Python tools worker during a burst. The spike measured what iii does:

- **The caller hears within milliseconds.** In-flight calls fail with `invocation_stopped`, and new
  ones with `function_not_found` until compose restarts the worker about a second later.
- **The work is gone.** Nothing retries a direct call, so the run fails, and the model answers
  that led to it are lost unless something recorded them.
- **Observers miss the interrupted call.** The engine deactivates the observer before failing the
  call, so the event is dropped as `INACTIVE`, though the docs say it should count as `CANCELLED`.
- **The queue redelivers.** A job on a killed worker ran again on the next owner, so handlers see
  repeats. That's why `email::send` needs an idempotency key.
- **A frozen worker is worse.** The engine never pings workers, so it keeps sending calls to a
  stopped process until each caller times out. iii's open PR #1929 (`dispatch_timeout_ms`) would
  limit part of that wait.

Recovery is a fork: completed calls get their recorded answers, and pure, read-only and external
calls run live. Anything that writes, is irreversible or declares nothing waits for a person. So
does the call the worker died in, unless it only reads, because nobody knows whether it reached
its provider. A call that failed with `function_not_found` never reached anyone, so the page
offers to send it.

### When Rewind itself stops

The app doesn't notice. Rewind is only an observer, and compose restarts it within seconds.

- **Calls made while it's down aren't recorded.** The engine drops their events. HTTP that
  bypasses iii is kept, because the preloads write it to disk.
- **One window can send an email twice.** A fork saves only when a rerun ends. If Rewind dies
  after sending `email::send` live but before then, the next rerun sends it again.
- **Forks survive.** A fork is a database record, so a paused recovery is still waiting after the
  restart.

## Why iii, and where it falls short

Rewind depends on one property: every call goes through one engine that knows who owns each
function. That's what lets it record any function without touching its code, and steer a replay's
calls to stubs.

- **Kafka plus services.** Kafka can replay a topic, but calls over HTTP or gRPC never touch it,
  and a replay reruns every consumer's side effects. You can't replay one request or swap one
  answer.
- **Temporal.** Its history is durable and every activity result is recorded, which is a stronger
  guarantee. But it covers only code written as deterministic workflows, and reset can't hand an
  activity a different answer. For exactly-once business processes I'd pick Temporal today.
- **A queue plus Lambdas.** Each function is on its own, traces don't show payloads, there's
  nowhere to intercept a call, and replaying means resending messages and rerunning their effects.

Other systems are closer to iii, and each already solves one of its gaps:

| System | How it's like iii | What iii could take from it |
| --- | --- | --- |
| Restate | Handlers call each other through one server | A journal of every call, so a crashed handler resumes |
| Inngest, Step Functions | Functions run by events or steps | Kept step results, so a failed run restarts at the failed step |
| Dapr | One runtime for invocation, pub/sub and state | Retries, timeouts and circuit breakers declared per call |
| NATS | Request and reply through one server | Accounts that export subjects to each other with permissions |
| Erlang/OTP | Processes that only talk by message | Monitors that see a death at once, and supervisors that restart |
| Envoy, service meshes | A proxy every call passes through | Health checks that eject a frozen host, and a per-call auth hook |
| rr, Replay.io, VCR | Replaying a run from what it got from outside | Recording at the effect boundary, which in iii is every call |

What I'd want before betting a production system on iii:

- **Durable history.** Temporal and Restate journal every step, and Kafka keeps messages to reread.
  iii's only record is what observers see, and they miss any call that never completes.
- **Retries.** SQS with Lambda retries and then parks failures in a dead-letter queue. A failed iii
  call stays failed, and only the queue redelivers.
- **Determinism.** Temporal enforces it and flags a replay that diverges. In iii, time has to come
  through a function, which is why the agent reads `clock::now`.
- **Checked schemas.** A schema registry or gRPC rejects a bad message. iii stores schemas and
  never checks them (bug 2).
- **Liveness.** Kafka heartbeats, SQS visibility timeouts and Erlang monitors notice a stopped
  worker. iii never pings one.
- **More than one engine.** Kafka and Temporal spread across machines. iii's single engine is a
  throughput limit and a single point of failure.

So today I'd use iii for agents, internal services and the development loop, where seeing and
changing a live system matters most, and keep anything that moves money on Temporal or a queue
with a dead-letter queue.

One more gap is inside each worker. iii passes trace context explicitly between workers, but
inside a Node worker the SDK patches `globalThis.fetch` to add `traceparent`, and finds the parent
span from implicit async context. That's the approach that gave Sentry's Node SDK years of context
leaking between requests, and a request started outside the handler's context gets the wrong
parent. Rewind's preload patches the same path, so it drops the SDK's trace headers, which change
on every run, and keeps the ids as fields instead.

## Scaling iii

I'd measure first: engine messages per second per core, p99 routing latency as workers grow, and
the cost of observers, which turn each call into two or more messages.

1. **Fail over by reconnecting.** Workers already reconnect and register again on their own, so an
   engine can fail over to a standby with no registry replication. Only in-flight calls are lost,
   as when a worker dies.
2. **Shard by namespace.** A call resolves only in its namespace, so a namespace can live on one
   engine, with cross-namespace calls going through a router or the bridge.
3. **Several instances behind one function id.** Retrying on another instance is safe only for
   idempotent functions, which is where effects start to matter.
4. **Liveness and deadlines.** Engine pings, plus a deadline that travels with each call, so a
   frozen worker costs a bounded wait.
5. **Recording under load.** Observers already drop events past `max_in_flight`. A recorder needs
   to choose what it samples, or the engine could record, since it sees every message.

## Federating iii

Today two deployments connect through the `bridge` worker's allowlists, with `rbac-proxy` gating
namespaces and registrations. Namespaces separate routing but don't isolate: any worker can call
into another namespace by naming it.

Each step here is useful on its own:

1. **Harden the bridge.** mTLS, an allowlist and quotas per peer, trace context across, and an
   audit log of every call that crosses.
2. **Check contracts at the boundary.** Enforce schemas on exported functions, even while they
   stay metadata inside a deployment.
3. **Engine peering.** Qualified names such as `acme.billing::invoice`, resolved by the engine,
   with provenance recorded across hops.
4. **Capabilities.** A signed token to call a function, which its holder can narrow but never widen
   before passing it on, as Macaroons and Biscuit do. A partner could call `billing::invoice` for
   one account and nothing else.

Questions to settle early:

- **Trust isn't transitive.** If A trusts B and B trusts C, A hasn't agreed to C.
- **The confused deputy.** A function with broad rights must know who is really asking. The engine
  stamps the caller's worker, but the caller's function and invocation ids come from its SDK,
  which can claim anything.
- **Idempotency keys** must cross with the call, or retries on either side repeat an effect.
- **Naming.** Who owns `billing::*` when two deployments both export it?

### Compared with GraphQL federation

Both route each part of a request to its owner through a registry. But GraphQL joins data into a
schema checked at build time, while iii joins functions that change things and composes live. A
failed iii call may already have had its effect, so idempotency matters far more. Three of
Apollo's ideas carry over:

- **Checks against recorded usage.** Apollo tests a schema change against the operations clients
  sent. Rewind's recordings would let iii replay a changed function against recorded traffic.
- **Contracts.** Apollo publishes a filtered graph per audience. iii could export a filtered set of
  functions per peer.
- **Progressive `@override`.** Apollo moves a field between subgraphs for a growing share of
  requests. iii could move a function between deployments the same way.

## Rewind across many engines

I moved the tools to a second engine behind the bridge (`docs/multi-engine.md`). The app didn't
notice, and replays still worked. What broke is everything Rewind learns from its own engine:

- **Effects don't cross.** The bridge drops metadata, so Rewind didn't know `email::send` was
  irreversible, and a recovery sent an invite without warning.
- **Errors lose their codes.** Every remote error becomes `bridge_error`, and a dead peer looks
  like a 30 s timeout, which says nothing about whether the call ran.
- **The far side's spans, captures and worker changes stay there.**

App authors needed to know nothing, and the operator wrote one forward entry per function. The
changes I'd ask of iii are all about what crosses the boundary: metadata travels with exported
functions, errors keep their codes with a separate code for "outcome unknown", the bridge fails
fast when its peer goes away, and each peer has a policy for which payloads the other may see.

## Effects as an iii primitive

Rewind needs each function to declare what it does: `pure`, `read-only`, `writes`, `external`,
`irreversible`, or `idempotent` with a key. Today that's free-form metadata. If iii understood it,
retries could skip what isn't safe to repeat, agent permissions could replace nearly 700 lines of
globs in `iii-permissions.yaml`, federation exports could default to read-only, and test stubs
would come for free.

A declaration is only a promise. It becomes a guarantee in a runtime where code can reach the
outside world only through iii, as in Cloudflare's workerd or a Wasm component under WASI, and
recording becomes complete too. Rewind's preloads get part of the way in Node and Python by
recording HTTP, but a raw socket or database driver still goes unrecorded.

## What belongs in iii's core

The core should own anything other parts of the system must rely on but can't check, because a
buggy worker could fake it. Workers can own what to do with those facts.

| The core owns it | Workers can own it |
| --- | --- |
| Who called, stamped by the engine at every hop | Who may call what (`rbac-proxy`) |
| Where a call goes: routing and namespaces | Which peers to bridge to |
| What happened to a call, including "outcome unknown" | Retries and compensation |
| A registry that reports declarations and whether a function is forwarded | What declarations mean: fork policy, caching, agent tools |
| Workers connecting, disconnecting and staying alive | Recording, replay, UIs and alerting |
| Trace context, and observer events that aren't dropped | Sampling, redaction and telemetry export |
| A hook every call passes through | The rules that run at that hook |

Schema checks and effect enforcement are policy, but a check that might not run can't be relied
on. The last row resolves that: the core guarantees the hook, and workers supply the rules, the
way Kubernetes runs admission webhooks and Linux runs security modules. Most of what I found in
iii falls on the core's side. Rewind needed no change to the core.

## What I found in iii along the way

Evidence for each is in `docs/spike.md`:

- **Observer events are dropped on worker death**, as above.
- **The engine never pings workers**, so a frozen worker keeps receiving calls.
- **A refused observer target still gets events.** A recorder refused with
  `FUNCTION_NAMESPACE_CONFLICT` still had its events delivered to the id's first owner.
- **`registerFunction` resolves early**, so an immediate call can get `function_not_found`.
- **Only `engine::functions::info` returns schemas.** `list` leaves them out.
- **The bridge drops metadata, flattens errors to `bridge_error`, and waits out a dead peer** for
  the full 30 s.
- **Compose gives up on a restarting bridge** after five restarts in 60 s, and stops the workers
  that start after it.
- **SDK warnings go to the engine log**, so a worker refused with `WORKER_NAMESPACE_CONFLICT` keeps
  running with its SDK stopped and says nothing locally.

## What I'd do next

- **Record each call's start** through the worker manager's middleware hook, so an interrupted
  call's input is known. It costs a second listener and in-process calls for workers on it.
- **Deterministic simulation.** A test engine that picks message order and time from a seed, as
  FoundationDB does, so races reproduce.
- **Replay across a federation boundary**, with copies on both engines joined by trace id.
- **Python inbound requests**, through WSGI and ASGI middleware.
- **Stub from the recording.** Stubs come from the live function list, so a worker that's down
  when a fork starts gets none, even though the recording has its answers.
- **Never resend a live call after Rewind dies.** Save a live answer as soon as it returns, and
  mark a call before sending it, so a crash leads to a question instead of a second send.
- **Say up front when a run can't be replayed**, because the root worker's code isn't in the
  compose file, instead of failing after the click.
- **Copy workers from outside the project** in a container whose only route is to the engine, so
  calls around iii fail instead of reaching live systems in languages the preloads don't cover.

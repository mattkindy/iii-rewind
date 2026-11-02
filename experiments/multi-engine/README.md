# Rewind across two engines

The scheduling agent's Python tools run on a second iii engine, behind iii's `bridge` worker, and
these scripts measure what Rewind can still do. The results are in `docs/multi-engine.md`, and the
raw output of each script is in `results/`.

| Folder | What runs there |
| --- | --- |
| `single/` | The baseline: the whole app on one engine at 50034, plus the probe worker |
| `engine-a/` | Engine A at 50034: clock, model, agent, traffic, Rewind, the ADE, and the bridge |
| `engine-b/` | Engine B at 50134: the tools, the probe worker, and a second Rewind |
| `probe/` | A worker with one function, `probe::echo`, which returns at once |

The bridge on engine A has a `forward` entry for `calendar::find-slot`, `email::send` and
`probe::echo`, so the agent calls them on A and the bridge calls them on B. The providers listen on
50036 and the ADE on 4033, both on 127.0.0.1. Rewind's page is not built, so the ADE shows its
placeholder.

## Run it

You need iii 0.25.0, and `iii` on your PATH may be another version, so set `III_BIN` to the 0.25.0
binary. Rewind must already be built (`cargo build --release` in `workers/rewind`).

```bash
cd experiments/multi-engine
npm install
export III_BIN=/path/to/iii-0.25.0

npx tsx start.ts --single            # the baseline
npx tsx measure/latency.ts single
npx tsx measure/traces.ts single
npx tsx measure/envelope.ts single
npx tsx measure/replay.ts single
npx tsx measure/failure.ts single
(cd ../.. && III_URL=ws://127.0.0.1:50034 III_COMPOSE_DIR=$PWD/experiments/multi-engine/single npx tsx scripts/e2e.ts)
npx tsx start.ts --stop

npx tsx start.ts                     # engine B, then engine A
npx tsx measure/latency.ts split
npx tsx measure/traces.ts split
npx tsx e2e.ts                       # with Rewind's defaults
npx tsx measure/envelope.ts split    # also turns recording on for the bridged tools in Rewind A
npx tsx measure/replay.ts split
npx tsx measure/failure.ts split
npx tsx e2e.ts                       # again, with recording on
npx tsx measure/unreachable.ts       # freezes, then kills engine B, and leaves it down
npx tsx start.ts --stop
```

Run the scripts in this order. `envelope.ts split` turns recording on with `rewind::record-toggle`,
and Rewind keeps that setting in `engine-a/data`, so delete that folder to go back to the defaults.
`failure.ts` kills workers, and `replay.ts` kills the worker that owns `calendar::find-slot` on
engine A, so compose restarts them. Compose gives up on a container after 5 restarts unless it
stays up for 60 s, so the two-engine compose files raise `max_attempts` for the bridge and the
tools. `e2e.ts` is `scripts/e2e.ts` with only the addresses changed: Rewind and the outbox are on
engine A, and the tools worker it kills is on engine B. `unreachable.ts` kills engine B's engine,
which takes B's compose daemon and workers with it, so stop and start both engines after it.

Each compose daemon writes to `compose.log` in its folder. Rewind's recordings are in
`<folder>/data/rewind.sqlite`, and the outbox is `engine-a/data/outbox.jsonl` (or
`single/data/outbox.jsonl`), because the email provider runs in the clock worker.

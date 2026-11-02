# Planted bugs

The scheduling agent has three bugs on purpose. Each one depends on data you can't get back by
running the request again, which is what Rewind is for. The traffic generator makes each one show
up at a known rate, so a demo never depends on luck.

## 1. The model returns truncated tool arguments

`model::complete` sometimes returns `tool_call.args` as a JSON string that is cut off, instead of
an object. `agent::run` calls `JSON.parse` on string arguments and throws `SyntaxError`. Asking the
model again gives a different answer, so the crash only reproduces from a recording.

Rate: about 1 in 7 first turns.

## 2. A string duration crosses from TypeScript into Python

`model::complete` sometimes sends `"duration": "30"` as a string. The agent passes it through, and
`calendar::find-slot` in Python calls `timedelta(minutes="30")`, which raises `TypeError`.
`calendar::find-slot` registers a request format that says `duration` is an integer, but the
engine stores function schemas and never checks a call against them, so nothing stops the string
at the boundary.

Rate: about 1 in 7 first turns.

## 3. A retry sends the same email twice

`email::send` is sometimes slow. The agent calls it with a short timeout and retries once on
`TIMEOUT`, with no idempotency key. The first call was still running, so the invite goes out twice.
`email::send` is declared irreversible, so a replay never sends anything, and the recording shows
both calls.

Rate: about 1 in 10 bookings.

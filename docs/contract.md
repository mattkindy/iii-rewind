# Function contract

What each worker registers, what it takes and returns, and the effect it declares. Rewind reads
effects from function `metadata`, so every function in the sample app sets `metadata.effects`.
The journal, listed last, keeps durable runs for the app, and its functions declare no effects.

Every function in the sample app also registers `request_format` and `response_format`, which are
JSON schemas of its input and output. They're listed under each function below. The engine stores
them as they were registered and never checks a call against them, so the planted bugs still get
through. `engine::functions::list` leaves them out. `engine::functions::info` returns them as
`request_schema` and `response_schema`, with each object's keys in alphabetical order.

The project runs on iii 0.26.0. The engine listens on `ws://127.0.0.1:49334`. Workers read the
engine address from `III_URL` and fall back to that address.

## Sample app

### `clock::now` (worker `clock`, TypeScript)

- Effects: `["read-only"]`
- Input: `{}`
- Output: `{ "now": "2026-10-27T15:02:11-05:00" }`, the current time in `America/Chicago` with its
  UTC offset. The agent reads the date from here and never from the system clock, so recorded time
  replays exactly.

Request format:

```json
{ "type": "object", "description": "Takes no arguments", "properties": {} }
```

Response format:

```json
{
  "type": "object",
  "properties": {
    "now": {
      "type": "string",
      "format": "date-time",
      "description": "The current time in America/Chicago with its UTC offset, such as 2026-10-27T15:02:11-05:00"
    }
  },
  "required": ["now"]
}
```

### Fake providers (worker `clock`, plain HTTP outside iii)

The clock worker also runs two fake providers on `http://127.0.0.1:<PROVIDERS_PORT>`, 49335 by
default. The agent and the tools worker call them over plain HTTP, around iii, so only Rewind's
preloads see those calls.

- `GET /holidays?from=2026-11-09&weeks=2` returns US federal holidays in that range:
  `{ "from": "2026-11-09", "to": "2026-11-22", "holidays": [{ "date": "2026-11-11", "name": "Veterans Day" }] }`.
  `weeks` is 1 to 52 and defaults to 2. A bad `from` or `weeks` gets a 400 with `{ "error": "..." }`.
- `POST /email` with `{ "to", "subject", "start", "caller_invocation_id" }` sends an invite. It
  appends the send to `data/outbox.jsonl`, so duplicates are visible, and returns
  `{ "status": "accepted", "id": "msg_<12 hex>" }`. About 1 in 10 sends takes 2.5 s (a slow
  provider), and the rest take 150 to 450 ms.

### `model::complete` (worker `model`, TypeScript)

- Effects: `["external"]`
- A fake model. It takes 300 to 900 ms, chosen at random.
- Input on the first turn:
  `{ "turn": 1, "today": "2026-10-27", "tools": ["calendar::find-slot", "email::send"], "messages": [{ "role": "user", "content": "..." }] }`
- Input on later turns: `{ "turn": n, "messages": [...] }`. Each tool result is a message
  `{ "role": "tool", "name": "<function id>", "result": <output or { "error": "<message>" }> }`.
- Output is either a tool call or a final answer:
  - `{ "tool_call": { "name": "calendar::find-slot", "args": { "attendee": "dana@example.com", "day": "2026-11-03", "duration": 30 } } }`
  - `{ "text": "Booked Tuesday 3 Nov at 2:00 pm with Dana and sent the invite.", "status": "booked" }`
- Choosing what to say:
  - First turn: read the attendee, the duration in minutes and the weekday from the request.
    The day is the next date with that weekday after `today`. Then call `calendar::find-slot`.
    Bugs 1 and 2 are injected here (see `BUGS.md`).
  - After a successful `calendar::find-slot`, call `email::send` with
    `{ "to": <attendee>, "subject": "<n> minutes, <Weekday>", "start": <slot start> }`.
  - After a successful `email::send`, return `status: "booked"`.
  - After any tool error, return `status: "failed"` with text that says which tool failed.
- Randomness comes from a PRNG seeded with `MODEL_SEED` and advanced on every call. A demo session
  is repeatable from its seed, but asking the same question twice gives different answers.

`tool_call.args` is usually an object. It can also be JSON text, which the agent parses, and that
is how bug 1 sends it, cut off partway. The schema describes `args` as either one and leaves what
goes inside to the named tool's own request format.

Request format:

```json
{
  "type": "object",
  "description": "The conversation so far. The first turn also says what day it is and which tools exist.",
  "properties": {
    "turn": { "type": "integer", "minimum": 1, "description": "Which turn this is, starting at 1" },
    "today": {
      "type": "string",
      "format": "date",
      "description": "Today's date in America/Chicago. Sent on the first turn only."
    },
    "tools": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["calendar::find-slot", "email::send"],
        "description": "The function id of a tool the agent can call"
      },
      "description": "The tools the model may call. Sent on the first turn only."
    },
    "messages": {
      "type": "array",
      "items": {
        "oneOf": [
          {
            "type": "object",
            "description": "The person's request",
            "properties": {
              "role": { "type": "string", "enum": ["user"] },
              "content": { "type": "string", "description": "The request in plain English" }
            },
            "required": ["role", "content"]
          },
          {
            "type": "object",
            "description": "What a tool call returned",
            "properties": {
              "role": { "type": "string", "enum": ["tool"] },
              "name": {
                "type": "string",
                "enum": ["calendar::find-slot", "email::send"],
                "description": "The function id of a tool the agent can call"
              },
              "result": {
                "description": "The tool's output, or { error } with the message the call failed with"
              }
            },
            "required": ["role", "name", "result"]
          }
        ]
      },
      "description": "The person's request, then one message for each tool call so far"
    }
  },
  "required": ["turn", "messages"]
}
```

Response format:

```json
{
  "type": "object",
  "description": "Either the next tool call or the final reply",
  "oneOf": [
    {
      "type": "object",
      "title": "Tool call",
      "properties": {
        "tool_call": {
          "type": "object",
          "description": "The tool the agent should call next, and what to call it with",
          "properties": {
            "name": {
              "type": "string",
              "enum": ["calendar::find-slot", "email::send"],
              "description": "The function id of a tool the agent can call"
            },
            "args": {
              "description": "The arguments for the tool, as an object or as JSON text that the agent parses. Bug 1 sends JSON text that is cut off partway.",
              "oneOf": [
                { "type": "object", "description": "The arguments as an object, in the shape of the tool's request_format" },
                { "type": "string", "contentMediaType": "application/json", "description": "The arguments as JSON text" }
              ]
            }
          },
          "required": ["name", "args"]
        }
      },
      "required": ["tool_call"]
    },
    {
      "type": "object",
      "title": "Reply",
      "properties": {
        "text": { "type": "string", "description": "The final reply to the person" },
        "status": { "type": "string", "enum": ["booked", "failed"], "description": "Whether the meeting was booked" }
      },
      "required": ["text", "status"]
    }
  ]
}
```

### `calendar::find-slot` (worker `tools`, Python)

- Effects: `["read-only"]`
- Takes 400 to 900 ms, so the failure demo can kill the worker mid-call.
- Input: `{ "attendee": "dana@example.com", "day": "2026-11-03", "duration": 30 }`
- Output: `{ "attendee": "...", "start": "2026-11-03T14:00:00-06:00", "end": "2026-11-03T14:30:00-06:00" }`
- Computes the end with `timedelta(minutes=duration)`, so a string duration raises `TypeError`
  (bug 2). The offset is America/Chicago's offset on that day.

The request format says `duration` is an integer. The model sometimes sends a string, and nothing
checks it before Python gets it.

Request format:

```json
{
  "type": "object",
  "description": "Who to meet, on which day, and for how long",
  "properties": {
    "attendee": { "type": "string", "format": "email", "description": "The attendee's email address" },
    "day": { "type": "string", "format": "date", "description": "The day to look for a slot on" },
    "duration": { "type": "integer", "minimum": 1, "description": "How long the meeting is, in minutes" }
  },
  "required": ["attendee", "day", "duration"]
}
```

Response format:

```json
{
  "type": "object",
  "description": "An afternoon slot on that day, in America/Chicago with its UTC offset",
  "properties": {
    "attendee": { "type": "string", "format": "email", "description": "The attendee the slot is for" },
    "start": { "type": "string", "format": "date-time", "description": "When the slot starts" },
    "end": { "type": "string", "format": "date-time", "description": "When the slot ends, duration minutes after the start" }
  },
  "required": ["attendee", "start", "end"]
}
```

### `email::send` (worker `tools`, Python)

- Effects: `["irreversible"]`, with `"idempotency_key": true` in its metadata.
- Input: `{ "to": "...", "subject": "...", "start": "..." }`
- Output: `{ "status": "accepted", "id": "msg_<12 hex>" }`, the provider's reply.
- POSTs the invite to the email provider at `EMAIL_URL` (default `http://127.0.0.1:49335/email`)
  with `urllib.request`, adding the run's invocation id. The provider writes the outbox.
- A call with an `idempotency_key` in its metadata sends once per key. A repeat of a key that
  went out returns the first send's reply, and a repeat of one that failed fails with the same
  message. A repeat of a key whose send was cut off mid-send fails too, because nobody knows
  whether that invite went out. The keys are in `data/email-sends.sqlite`, so they outlast a
  restart of the tools. A durable run's step sends `<workflow id>:<step>` as its key, and a live
  send from Rewind sends `rewind:<run id>:<place>:<hash of the input>`. A call without a key
  always sends.
- About 1 in 10 sends is slow at the provider, 2.5 s. That triggers bug 3.

Request format:

```json
{
  "type": "object",
  "description": "The invite to send",
  "properties": {
    "to": { "type": "string", "format": "email", "description": "Who gets the invite" },
    "subject": { "type": "string", "description": "The subject line, such as \"30 minutes, Tuesday\"" },
    "start": { "type": "string", "format": "date-time", "description": "When the meeting starts" }
  },
  "required": ["to", "subject", "start"]
}
```

Response format:

```json
{
  "type": "object",
  "description": "The email provider's reply",
  "properties": {
    "status": { "type": "string", "enum": ["accepted"], "description": "The provider took the invite" },
    "id": { "type": "string", "description": "The provider's id for the message, msg_ and 12 hex digits" }
  },
  "required": ["status", "id"]
}
```

### `agent::run` (worker `agent`, TypeScript)

- Effects: `["writes"]`, with `"durable": true` in its metadata. Rewind's Node preload keeps a
  journal of each run in the journal worker, and a run the agent died under starts again on the
  agent compose brings back ([durable-execution.md](durable-execution.md)).
- Input: `{ "request": "Book 30 minutes with Dana next Tuesday afternoon", "user": "matt" }`, and
  three optional fields:
  - `approval: true` makes the run wait for a person to approve each invite before it goes out.
  - `approval_timeout_ms` says how long it waits for that approval, 30 minutes by default.
  - `_workflow_id` is the run's id in the journal, such as `burst-1a2b3c4d-7`. A caller that
    starts the same run again sends the same id, and a run that comes without one gets
    `wf-<invocation id>`. The preload takes the field out before the agent's code sees the input.
- Loop:
  1. Call `clock::now` once.
  2. Call `model::complete`.
  3. If the answer has text, return it.
  4. Otherwise parse `tool_call.args` (`JSON.parse` when it is a string, which is bug 1), call the
     function in `tool_call.name`, append the result or error as a tool message, and loop. Stop
     after 6 turns.
  5. Before it calls `calendar::find-slot`, fetch `GET /holidays?from=<day>&weeks=2` from
     `HOLIDAYS_URL` (default `http://127.0.0.1:49335`). If the day is a holiday, the agent skips
     the call and appends the tool message `{ "error": "2026-11-11 is a US holiday (Veterans Day)" }`,
     so the model replies with `status: "failed"`. A fetch that fails is a tool error the same way.
  6. With `approval`, before it calls `email::send`, call `durable::wait` with the name
     `approval`, the timeout, the invite as `detail: { function_id: "email::send", input }`, and
     two choices: Approve, `{ "approved": true }`, and Decline, `{ "approved": false }`. The run
     parks there until someone resolves the wait. An approval sends the invite. A decline or the timeout sends nothing and gives the model the tool error
     "the invite was not approved" or "nobody approved the invite in time". A wait's name gets one
     value per run, so one answer covers every send in the run.
- Calls `email::send` with `timeoutMs: 1500` and retries once on `TIMEOUT` (bug 3). Other calls
  use a 30 s timeout.
- Output: `{ "status": "booked" | "failed", "reply": "...", "turns": n }`. A run that parks at a
  wait returns `{ "pending": true, "workflow_id": "...", "waiting_for": { ... } }` instead, and
  `journal::wait` returns its output once it finishes. The response format leaves that shape out,
  since every durable function can return it.

Request format:

```json
{
  "type": "object",
  "properties": {
    "request": {
      "type": "string",
      "description": "What to book, in plain English, such as \"Book 30 minutes with Dana next Tuesday afternoon\""
    },
    "user": { "type": "string", "description": "Who is asking" },
    "approval": {
      "type": "boolean",
      "default": false,
      "description": "Wait for a person to approve each invite before it goes out. Until then the run returns { pending: true }, and journal::resolve with name \"approval\" and { approved: true } lets it go on"
    },
    "approval_timeout_ms": {
      "type": "integer",
      "minimum": 0,
      "default": 1800000,
      "description": "How long to wait for the approval before the run goes on without sending"
    }
  },
  "required": ["request"]
}
```

Response format:

```json
{
  "type": "object",
  "properties": {
    "status": { "type": "string", "enum": ["booked", "failed"], "description": "Whether the meeting was booked" },
    "reply": { "type": "string", "description": "The model's final reply, or why the agent gave up" },
    "turns": { "type": "integer", "minimum": 1, "maximum": 6, "description": "How many times the agent asked the model" }
  },
  "required": ["status", "reply", "turns"]
}
```

### `traffic::burst` (worker `traffic`, TypeScript)

- Effects: `["writes"]`
- Input: every field is optional, and these are the defaults:
  `{ "count": 20, "interval_ms": 400, "start": "call", "retry": false, "approval": false, "detail": false }`
- Builds requests from a fixed list of attendees, durations and weekdays, and starts `agent::run`
  for each without waiting for the previous one to finish. Errors are counted, not thrown.
- Gives each run a workflow id, `burst-<8 hex>-<index>`, as `_workflow_id` in its input. When the
  journal is running and a run's call stops with `invocation_stopped`, `function_not_found` or
  `TIMEOUT`, the burst waits for the run in `journal::wait`, for up to 3 minutes, while it finishes
  on a restarted agent. Such a run counts as resumed.
- `start: "queue"` sends each run as a job on the `agent-runs` queue, which the burst defines,
  instead of calling `agent::run`. The queue delivers a job again when the agent dies under it, and
  the burst waits for each run in the journal.
- `retry: true` calls a run again with the same workflow id when its call stops and the journal
  never saw it, for up to 30 seconds, which covers a run sent while the agent was down.
- `approval: true` starts every run with `approval: true`. A run that parks returns
  `{ pending: true }`, and the burst counts it as waiting.
- `detail: true` also returns each run, with its workflow id, request, outcome, how many times it
  was started, whether it resumed, how long it took, and its output or error.
- Calls `agent::run` from the root OpenTelemetry context, so each run is the root of a trace of
  its own, the way a request from outside would arrive. The agent passes its trace on to every
  call it makes.
- Output: `{ "sent": 20, "booked": 14, "failed": 4, "errors": 2, "waiting": 0, "resumed": 0 }`,
  with `runs` when `detail` is true.

Request format:

```json
{
  "type": "object",
  "properties": {
    "count": { "type": "integer", "minimum": 0, "default": 20, "description": "How many requests to send" },
    "interval_ms": {
      "type": "integer",
      "minimum": 0,
      "default": 400,
      "description": "How long to wait between sending one request and the next, in milliseconds"
    },
    "start": {
      "type": "string",
      "enum": ["call", "queue"],
      "default": "call",
      "description": "How each run starts: a call to agent::run, or a job on the agent-runs queue, which delivers it again if the agent dies"
    },
    "retry": {
      "type": "boolean",
      "default": false,
      "description": "Call a run again, with the same workflow id, when its call stops and the journal never saw it"
    },
    "approval": {
      "type": "boolean",
      "default": false,
      "description": "Start each run with approval: true, so each invite waits for a person, and count those runs as waiting"
    },
    "detail": { "type": "boolean", "default": false, "description": "Also return each run with its workflow id and outcome" }
  }
}
```

Response format:

```json
{
  "type": "object",
  "properties": {
    "sent": { "type": "integer", "minimum": 0, "description": "How many requests were sent" },
    "booked": { "type": "integer", "minimum": 0, "description": "Runs that replied with status booked" },
    "failed": { "type": "integer", "minimum": 0, "description": "Runs that replied with status failed" },
    "errors": { "type": "integer", "minimum": 0, "description": "Runs that threw, or stopped and never finished" },
    "waiting": {
      "type": "integer",
      "minimum": 0,
      "description": "Durable runs waiting on a pending step: a wait for a value, a sleep, or a call a crash cut off that a person has to decide about"
    },
    "resumed": { "type": "integer", "minimum": 0, "description": "Runs whose call stopped and that finished on a restarted agent" },
    "runs": { "type": "array", "description": "Each run, when detail is true", "items": { "type": "object" } }
  },
  "required": ["sent", "booked", "failed", "errors", "waiting", "resumed"]
}
```

## Journal (worker `journal`, TypeScript)

The journal keeps the app's durable runs, such as `agent::run`, in `data/journal.sqlite`. Rewind's
Node preload calls it from inside a durable run, and Rewind's page calls `journal::list`,
`journal::resolve` and `journal::wait`. Its `journal::*` functions are internal and register no
effects or formats, so Rewind neither records nor lists them. A write the journal refuses comes
back as `{ rejected, message }`, with `rejected` one of `FENCED`, `DIVERGED`, `UNKNOWN_WORKFLOW` or
`WAITING`, instead of as an error. [durable-execution.md](durable-execution.md) has how a run uses
each one.

| Function | Input | Output |
| --- | --- | --- |
| `journal::begin` | `{ workflow_id, function_id, input, input_hash, started_by }` | `{ status: "running", epoch, steps }` for a run that starts or starts again, or `{ status, output }`, `{ status, error }` or `{ status, pending }` for one that finished, failed or waits |
| `journal::intent` | `{ workflow_id, epoch, step, function_id, input_hash }`, before the step's call goes out | `{ idempotency_key, outcome? }`, with a key when the callee is irreversible and the saved outcome when the step already has one |
| `journal::result` | `{ workflow_id, epoch, step, outcome }`, with `outcome` either `{ ok: true, value }` or `{ ok: false, error }` | `{ saved: true }` |
| `journal::park` | `{ workflow_id, epoch, step, function_id, input_hash, park }`, with `park` either `{ kind: "wait", name, timeout_ms?, detail?, choices? }` or `{ kind: "sleep", ms }` | `{ outcome }` when the step has its result already, or `{ pending }` with the run left waiting |
| `journal::resolve` | `{ workflow_id, name?, step?, value?, error?, action? }`: a wait by its name, or any pending step by its number. `action: "execute"` sends a call a crash cut off again | `{ resolved, resumed, step?, reason? }` |
| `journal::finish` | `{ workflow_id, epoch, outcome }` | `{ saved: true }` |
| `journal::wait` | `{ workflow_id, timeout_ms? }`, waiting at most 60 s | the run once it finishes, fails or starts waiting, or as it is when the time runs out, or `null` for a run the journal doesn't have |
| `journal::get` | `{ workflow_id }` | the run with its steps, executions, every attempt at each step, the values its waits got and the writes it fenced, or `null` |
| `journal::list` | `{ status? }`, one of `running`, `waiting`, `done` or `failed` | every run, oldest first, a waiting one with its `pending` step |
| `journal::on-workers-changed` | what `engine::on-workers-changed` reports, which the journal observes | `null`. A disconnect clears that worker as the owner of its running runs and starts the sweep that calls them again |

### `durable::wait` and `durable::sleep` (worker `journal`)

Inside a durable run, the preload turns these two calls into steps of the run and never sends
them:

- `durable::wait` with `{ name, timeout_ms?, detail?, choices? }` parks the run until someone
  resolves the wait with `journal::resolve`. It returns `{ timed_out: false, value }` with the value
  that resolved it, or `{ timed_out: true }` when `timeout_ms` passes first. `detail` and
  `choices`, a list of `{ label, value }`, are for the person who resolves it.
- `durable::sleep` with `{ ms }` parks the run until that time has passed, and returns
  `{ slept_ms }`.

The journal registers both as well, with no effects, and not as internal, so the engine lists them
and Rewind stubs them in its copies. A call that reaches the journal came from outside a durable
run, and fails at once with an error saying they only work inside one.

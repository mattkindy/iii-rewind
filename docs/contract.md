# Function contract

What each worker registers, what it takes and returns, and the effect it declares. Rewind reads
effects from function `metadata`, so every function sets `metadata.effects`.

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

- Effects: `["irreversible"]`
- Input: `{ "to": "...", "subject": "...", "start": "..." }`
- Output: `{ "status": "accepted", "id": "msg_<12 hex>" }`, the provider's reply.
- POSTs the invite to the email provider at `EMAIL_URL` (default `http://127.0.0.1:49335/email`)
  with `urllib.request`, adding the run's invocation id. The provider writes the outbox.
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

- Effects: `["writes"]`
- Input: `{ "request": "Book 30 minutes with Dana next Tuesday afternoon", "user": "matt" }`
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
- Calls `email::send` with `timeoutMs: 1500` and retries once on `TIMEOUT` (bug 3). Other calls
  use a 30 s timeout.
- Output: `{ "status": "booked" | "failed", "reply": "...", "turns": n }`

Request format:

```json
{
  "type": "object",
  "properties": {
    "request": {
      "type": "string",
      "description": "What to book, in plain English, such as \"Book 30 minutes with Dana next Tuesday afternoon\""
    },
    "user": { "type": "string", "description": "Who is asking" }
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
- Input: `{ "count": 20, "interval_ms": 400 }`. Both are optional.
- Builds requests from a fixed list of attendees, durations and weekdays, and calls `agent::run`
  for each without waiting for the previous one to finish. Errors are counted, not thrown.
- Calls `agent::run` from the root OpenTelemetry context, so each run is the root of a trace of
  its own, the way a request from outside would arrive. The agent passes its trace on to every
  call it makes.
- Output: `{ "sent": 20, "booked": 14, "failed": 4, "errors": 2 }`

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
    }
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
    "errors": { "type": "integer", "minimum": 0, "description": "Runs that threw instead of replying" }
  },
  "required": ["sent", "booked", "failed", "errors"]
}
```

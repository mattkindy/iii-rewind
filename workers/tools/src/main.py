"""The calendar and email tools for the scheduling agent.

calendar::find-slot picks an afternoon slot on the day asked for, and
email::send delivers an invite by POSTing it to the email provider, which
runs in the clock worker and appends each send to data/outbox.jsonl. That
POST is plain HTTP, outside iii, so only Rewind's preload sees it.

Bugs 2 and 3 in BUGS.md show up here. find-slot raises TypeError when the
duration arrives as a string, and about one send in ten is slow at the
provider, longer than the agent waits before it sends again.

A send that comes with an idempotency key in its metadata goes out once per
key. Durable runs send one with every irreversible step (Sends, below).

Run: III_URL=ws://127.0.0.1:49334 PYTHONPATH=../rewind/preload/python .venv/bin/python src/main.py
"""

import asyncio
import hashlib
import json
import os
import random
import signal
import sqlite3
import threading
import time as clock
import urllib.request
from collections.abc import Awaitable, Callable
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from formats import FIND_SLOT_REQUEST, FIND_SLOT_RESPONSE, SEND_REQUEST, SEND_RESPONSE
from iii import InitOptions, register_worker

ENGINE_URL = os.environ.get("III_URL", "ws://127.0.0.1:49334")
EMAIL_URL = os.environ.get("EMAIL_URL", "http://127.0.0.1:49335/email")
PROJECT_DIR = Path(os.environ.get("III_COMPOSE_DIR", Path(__file__).resolve().parents[3]))
SENDS_FILE = Path(os.environ.get("SENDS_FILE", PROJECT_DIR / "data" / "email-sends.sqlite"))
CHICAGO = ZoneInfo("America/Chicago")
AFTERNOON_SLOTS = [time(13, 0), time(13, 30), time(14, 0), time(14, 30), time(15, 0), time(15, 30), time(16, 0)]
EMAIL_TIMEOUT_S = 10

worker = register_worker(ENGINE_URL, InitOptions(worker_name="tools"))


class SendOutcomeUnknown(Exception):
    pass


class Sends:
    """The sends made so far, by idempotency key, so a call that repeats a key gets the first
    send's result back and no second invite goes out.

    The keys are kept in SQLite beside the outbox, so they outlast a restart of this worker. A
    key still marked `sending` belongs to a send this worker was killed in the middle of. Nobody
    knows whether the provider got that one, so a repeat of its key fails instead of guessing.
    """

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        # With isolation_level None each statement commits on its own, which is all this needs.
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.execute("pragma journal_mode = wal")
        self._db.execute("pragma synchronous = full")
        self._db.execute(
            """create table if not exists sends (
                 key            text primary key,
                 state          text not null,
                 result         text,
                 repeats        integer not null default 0,
                 started_at_ms  integer not null,
                 finished_at_ms integer
               )"""
        )
        # A repeat that arrives while the first send with its key is still going waits for it here.
        self._locks: dict[str, asyncio.Lock] = {}

    async def once(self, key: str, send: Callable[[], Awaitable[dict]]) -> dict:
        async with self._locks.setdefault(key, asyncio.Lock()):
            row = self._db.execute("select state, result from sends where key = ?", (key,)).fetchone()
            if row is not None:
                return self._repeat(key, row[0], row[1])

            self._db.execute("insert into sends (key, state, started_at_ms) values (?, 'sending', ?)", (key, _now_ms()))
            try:
                result = await send()
            except Exception as error:
                self._finish(key, "failed", {"error": str(error)})
                raise

            self._finish(key, "sent", result)
            return result

    def _repeat(self, key: str, state: str, result: str | None) -> dict:
        self._db.execute("update sends set repeats = repeats + 1 where key = ?", (key,))
        print(f"tools: email::send dropped a repeat of {key} ({state})", flush=True)
        if state == "sent":
            return json.loads(result)

        if state == "failed":
            raise RuntimeError(json.loads(result)["error"])

        raise SendOutcomeUnknown(f"the send for {key} was cut off before it finished, so it may or may not have gone out")

    def _finish(self, key: str, state: str, result: dict) -> None:
        self._db.execute(
            "update sends set state = ?, result = ?, finished_at_ms = ? where key = ?",
            (state, json.dumps(result), _now_ms(), key),
        )


def _now_ms() -> int:
    return int(clock.time() * 1000)


sends = Sends(SENDS_FILE)


def slot_start(attendee: str, day: date) -> datetime:
    # The same attendee and day always get the same slot, so a read-only call gives the same answer twice.
    digest = hashlib.sha256(f"{attendee}|{day.isoformat()}".encode()).digest()
    return datetime.combine(day, AFTERNOON_SLOTS[digest[0] % len(AFTERNOON_SLOTS)], tzinfo=CHICAGO)


async def find_slot(data: dict) -> dict:
    await asyncio.sleep(random.uniform(0.4, 0.9))
    start = slot_start(data["attendee"], date.fromisoformat(data["day"]))
    # A string duration raises TypeError here. The request_format says integer, but iii never checks it (bug 2).
    end = start + timedelta(minutes=data["duration"])
    return {"attendee": data["attendee"], "start": start.isoformat(), "end": end.isoformat()}


def caller_invocation_id() -> str | None:
    invocation = worker.current_invocation()
    caller = invocation.caller if invocation else None
    return (caller or {}).get("invocation_id")


def post_email(send: dict) -> dict:
    request = urllib.request.Request(
        EMAIL_URL,
        data=json.dumps(send).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=EMAIL_TIMEOUT_S) as response:
        return json.loads(response.read())


async def send_email(data: dict, metadata: dict | None = None) -> dict:
    # The run that asked for this send, so two sends from one run are easy to spot in the outbox.
    send = {"to": data["to"], "subject": data["subject"], "start": data["start"], "caller_invocation_id": caller_invocation_id()}

    # to_thread copies the context, so the preload still knows which invocation the POST belongs to.
    async def deliver() -> dict:
        return await asyncio.to_thread(post_email, send)

    key = (metadata or {}).get("idempotency_key")
    if not key:
        return await deliver()

    return await sends.once(key, deliver)


worker.register_function(
    "calendar::find-slot",
    find_slot,
    description="Finds an afternoon slot for an attendee on a given day",
    metadata={"effects": ["read-only"]},
    request_format=FIND_SLOT_REQUEST,
    response_format=FIND_SLOT_RESPONSE,
)
worker.register_function(
    "email::send",
    send_email,
    description="Sends a meeting invite through the email provider, which appends it to data/outbox.jsonl",
    metadata={"effects": ["irreversible"], "idempotency_key": True},
    request_format=SEND_REQUEST,
    response_format=SEND_RESPONSE,
)

print(f"tools ready on {ENGINE_URL}, sending email through {EMAIL_URL}", flush=True)

stop = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stop.set())
signal.signal(signal.SIGINT, lambda *_: stop.set())
stop.wait()
worker.shutdown()

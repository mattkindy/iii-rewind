"""The calendar and email tools for the scheduling agent.

calendar::find-slot picks an afternoon slot on the day asked for, and
email::send delivers an invite by POSTing it to the email provider, which
runs in the clock worker and appends each send to data/outbox.jsonl. That
POST is plain HTTP, outside iii, so only Rewind's preload sees it.

Bugs 2 and 3 in BUGS.md show up here. find-slot raises TypeError when the
duration arrives as a string, and about one send in ten is slow at the
provider, longer than the agent waits before it sends again.

Run: III_URL=ws://127.0.0.1:49334 PYTHONPATH=../rewind/preload/python .venv/bin/python src/main.py
"""

import asyncio
import hashlib
import json
import os
import random
import signal
import threading
import urllib.request
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from formats import FIND_SLOT_REQUEST, FIND_SLOT_RESPONSE, SEND_REQUEST, SEND_RESPONSE
from iii import InitOptions, register_worker

ENGINE_URL = os.environ.get("III_URL", "ws://127.0.0.1:49334")
EMAIL_URL = os.environ.get("EMAIL_URL", "http://127.0.0.1:49335/email")
CHICAGO = ZoneInfo("America/Chicago")
AFTERNOON_SLOTS = [time(13, 0), time(13, 30), time(14, 0), time(14, 30), time(15, 0), time(15, 30), time(16, 0)]
EMAIL_TIMEOUT_S = 10

worker = register_worker(ENGINE_URL, InitOptions(worker_name="tools"))


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


async def send_email(data: dict) -> dict:
    # The run that asked for this send, so two sends from one run are easy to spot in the outbox.
    send = {"to": data["to"], "subject": data["subject"], "start": data["start"], "caller_invocation_id": caller_invocation_id()}
    # to_thread copies the context, so the preload still knows which invocation the POST belongs to.
    return await asyncio.to_thread(post_email, send)


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
    metadata={"effects": ["irreversible"]},
    request_format=SEND_REQUEST,
    response_format=SEND_RESPONSE,
)

print(f"tools ready on {ENGINE_URL}, sending email through {EMAIL_URL}", flush=True)

stop = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stop.set())
signal.signal(signal.SIGINT, lambda *_: stop.set())
stop.wait()
worker.shutdown()

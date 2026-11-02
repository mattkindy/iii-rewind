"""What every kind of capture shares: the mode, the iii invocation the work ran
in, the capture file Rewind reads, and asking Rewind on replay.

Captures are the same JSON lines the Node preload writes. The Python SDK keeps
the current invocation in a context variable that ``iii.current_invocation()``
reads from anywhere, including a thread started with ``asyncio.to_thread``,
which copies the context.
"""

import base64
import functools
import hashlib
import json
import os
import sys
import threading
import uuid
from pathlib import Path

MODE = os.environ.get("REWIND_CAPTURE", "record")
WORKER = os.environ.get("REWIND_WORKER_NAME") or Path.cwd().name
NAMESPACE = os.environ.get("III_NAMESPACE", "default")
OUTSIDE_FUNCTION = "rewind::outside"
# A live call can take as long as the request it makes.
ASK_TIMEOUT_MS = 120_000


def current_invocation() -> dict | None:
    """The iii call running now, or None outside a handler."""
    try:
        from iii import current_invocation as current
    except ImportError:
        return None

    invocation = current()
    if invocation is None:
        return None

    return {"invocation_id": invocation.invocation_id, "function_id": invocation.function_id}


def current_call() -> dict | None:
    """The iii call running now and the call that made it, which Rewind uses to place a request a copy makes."""
    try:
        from iii import current_invocation as current
    except ImportError:
        return None

    invocation = current()
    if invocation is None:
        return None

    return {"invocation_id": invocation.invocation_id, "caller_invocation_id": (invocation.caller or {}).get("invocation_id")}


def current_trace() -> dict:
    """The trace and span ids of the OpenTelemetry span running now, the handler's when nothing else started one."""
    try:
        from opentelemetry import trace
    except ImportError:
        return {"trace_id": None, "span_id": None}

    context = trace.get_current_span().get_span_context()
    if not context.is_valid:
        return {"trace_id": None, "span_id": None}

    return {"trace_id": format(context.trace_id, "032x"), "span_id": format(context.span_id, "016x")}


def _project_dir() -> Path:
    if os.environ.get("III_COMPOSE_DIR"):
        return Path(os.environ["III_COMPOSE_DIR"])

    for folder in [Path.cwd(), *Path.cwd().parents]:
        if (folder / "worker-compose.yaml").is_file():
            return folder

    return Path.cwd()


@functools.cache
def _capture_file() -> Path:
    return Path(os.environ.get("REWIND_CAPTURE_FILE") or _project_dir() / "data" / "captures.jsonl")


_DEFAULT_MAX_BODY_BYTES = 64 * 1024


def _max_body_bytes() -> int:
    try:
        configured = int(os.environ.get("REWIND_MAX_BODY_BYTES", ""))
    except ValueError:
        return _DEFAULT_MAX_BODY_BYTES

    return configured if configured > 0 else _DEFAULT_MAX_BODY_BYTES


MAX_BODY_BYTES = _max_body_bytes()


def _encoded(data: bytes) -> dict:
    try:
        return {"body": data.decode("utf-8")}
    except UnicodeDecodeError:
        return {"body": base64.b64encode(data).decode("ascii"), "body_encoding": "base64"}


def _encoded_prefix(data: bytes) -> dict:
    # A cut can land inside a character of up to four bytes, so it may need to move back three.
    for drop in range(min(4, len(data))):
        try:
            return {"body": data[: len(data) - drop].decode("utf-8")}
        except UnicodeDecodeError:
            continue

    return _encoded(data)


def body_fields(data: bytes | None) -> dict:
    """A body as text, or as base64 with ``body_encoding`` when it is not UTF-8.

    A body longer than REWIND_MAX_BODY_BYTES keeps its first bytes, and ``body_truncated`` gives the
    full length and a SHA-256 of the whole body. A question to Rewind is cut the same way, so it still
    matches its recording.
    """
    if not data:
        return {"body": None}

    if len(data) <= MAX_BODY_BYTES:
        return _encoded(data)

    truncated = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    return {**_encoded_prefix(data[:MAX_BODY_BYTES]), "body_truncated": truncated}


def body_bytes(fields: dict) -> bytes:
    body = fields.get("body")
    if body is None:
        return b""

    if fields.get("body_encoding") == "base64":
        return base64.b64decode(body)

    return body.encode("utf-8")


def write_capture(capture: dict) -> None:
    line = json.dumps({"v": 1, "id": str(uuid.uuid4()), "worker": WORKER, "namespace": NAMESPACE, **capture})
    file = _capture_file()
    try:
        file.parent.mkdir(parents=True, exist_ok=True)
        # One write on a file opened for appending keeps lines from two processes apart.
        descriptor = os.open(file, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            os.write(descriptor, (line + "\n").encode("utf-8"))
        finally:
            os.close(descriptor)
    except OSError as error:
        print(f"rewind preload: could not write {file}: {error}", file=sys.stderr, flush=True)


_connection = None
# Requests made from several threads at once would each open a connection to the engine.
_connecting = threading.Lock()


def _rewind():
    global _connection
    with _connecting:
        if _connection is None:
            from iii import InitOptions, register_worker

            options = InitOptions(worker_name="rewind-preload", enable_metrics_reporting=False, otel={"enabled": False})
            _connection = register_worker(os.environ.get("III_URL", "ws://127.0.0.1:49334"), options)

    return _connection


def _question(request: dict) -> dict:
    # The SDK's own caller does not reach a request made from a thread, so the request says which call it ran in.
    return {"function_id": OUTSIDE_FUNCTION, "payload": {**request, "invocation": current_call()}, "timeout_ms": ASK_TIMEOUT_MS}


def ask_rewind(request: dict) -> dict:
    """What Rewind says the call returns. A pause or an injected error raises, with Rewind's code in the message."""
    return _rewind().trigger(_question(request))


async def ask_rewind_async(request: dict) -> dict:
    return await _rewind().trigger_async(_question(request))

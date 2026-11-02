"""Which headers Rewind keeps, and which values it hides, the same way the
Node preload does. A capture keeps a secret header's name with REDACTED as its
value, so the page still shows the request had one. A request a copy asks
Rewind about leaves secret headers out and lists their names, because Rewind
may send that request live, and it must never send REDACTED as a credential.

REWIND_REDACT_HEADERS adds names to the list, comma separated.
"""

import os

REDACTED = "[redacted]"

# The SDK adds these to every request, and they differ on every run.
TRACE_HEADERS = {"traceparent", "baggage"}

_SECRET_HEADERS = {
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    *(name.strip().lower() for name in os.environ.get("REWIND_REDACT_HEADERS", "").split(",") if name.strip()),
}

# Services send API keys and tokens in headers of their own, such as x-api-key and x-goog-api-key.
_SECRET_WORDS = ("api-key", "apikey", "token", "secret", "password")


def is_secret_header(name: str) -> bool:
    key = name.lower()
    return key in _SECRET_HEADERS or any(word in key for word in _SECRET_WORDS)


def recorded_headers(headers: dict) -> dict:
    """Headers as a capture stores them: no trace headers, and REDACTED for each secret."""
    return {name: REDACTED if is_secret_header(name) else value for name, value in headers.items() if name.lower() not in TRACE_HEADERS}


def asked_headers(headers: dict) -> dict:
    """Headers for a question to Rewind: no trace headers, no secrets, and the names of the secrets left out."""
    kept = {name: value for name, value in headers.items() if name.lower() not in TRACE_HEADERS}
    redacted = [name for name in kept if is_secret_header(name)]
    fields: dict = {"headers": {name: value for name, value in kept.items() if not is_secret_header(name)}}
    if redacted:
        fields["redacted_headers"] = redacted

    return fields


def without_redacted(headers: dict) -> dict:
    """Recorded headers without the ones whose value was hidden, so nothing receives REDACTED as a value."""
    return {name: value for name, value in headers.items() if value != REDACTED}

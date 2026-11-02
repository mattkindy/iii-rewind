"""Outbound HTTP, captured as ``http_out``. Patching ``http.client`` covers
urllib.request, urllib3 and requests, and httpx gets its own patch on its
transports if the worker imports it.

In record mode a request made inside an iii handler goes out as usual, and its
request and response become one capture. In replay mode every request goes to
Rewind instead, and the response Rewind returns is handed back as if it came
off the wire. Either way the caller gets a response it reads like any other.

urllib3 opens its sockets in its own ``connect``, so in replay mode the preload
replaces that too, along with http.client's. A replayed request never opens a
socket to its host.
"""

import http.client
import io
import socket
import time

from . import capture
from .headers import asked_headers, recorded_headers, without_redacted
from .imports import after_import

# The body is handed back whole, so its length is known and nothing is chunked.
DROPPED_RESPONSE_HEADERS = {"transfer-encoding", "content-length"}


class _Exchange:
    def __init__(self, invocation, method: str, url: str):
        self.invocation = invocation
        self.trace = capture.current_trace()
        self.method = method.upper()
        self.url = url
        self.headers: dict[str, str] = {}
        self.body = bytearray()
        self.headers_sent = False
        self.started_at_ms = int(time.time() * 1000)
        self.started = time.perf_counter()

    def add_header(self, name: str, value: str) -> None:
        key = name.lower()
        self.headers[key] = f"{self.headers[key]}, {value}" if key in self.headers else value

    def _request(self, headers: dict) -> dict:
        return {"method": self.method, "url": self.url, **headers, **capture.body_fields(bytes(self.body))}

    def question(self) -> dict:
        """The request as a copy asks Rewind about it, with the secret headers left out."""
        return {"kind": "http_out", "worker": capture.WORKER, **self._request(asked_headers(self.headers))}

    def finish(self, answer: dict | None, body: bytes = b"", error: Exception | None = None) -> None:
        """Writes the capture, with the response's secret headers hidden and its body cut to the cap."""
        output = None
        if answer is not None:
            output = {"status": answer["status"], "status_text": answer["status_text"], "headers": recorded_headers(answer["headers"]), **capture.body_fields(body)}

        failure = None if error is None else {"code": "HTTP_FAILED", "message": f"{type(error).__name__}: {error}"}
        capture.write_capture(
            {
                "kind": "http_out",
                "name": f"http_out {self.method} {self.url}",
                **self.invocation,
                **self.trace,
                "started_at_ms": self.started_at_ms,
                "duration_ms": (time.perf_counter() - self.started) * 1000,
                "input": self._request({"headers": recorded_headers(self.headers)}),
                "output": output,
                "error": failure,
            }
        )


def _begin(method: str, url: str) -> _Exchange | None:
    """An exchange to fill in, or None for a request that is neither inside a handler nor in a copy."""
    if capture.MODE == "replay":
        return _Exchange(capture.current_invocation() or {}, method, url)

    invocation = capture.current_invocation()
    if invocation is None:
        return None

    return _Exchange(invocation, method, url)


def _as_bytes(data) -> bytes:
    if data is None:
        return b""

    if isinstance(data, str):
        return data.encode("iso-8859-1")

    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data)

    return b""


def _text(value) -> str:
    if isinstance(value, str):
        return value

    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).decode("iso-8859-1")

    return str(value)


def _full_url(connection: http.client.HTTPConnection, target: str) -> str:
    if target.startswith(("http://", "https://")):
        return target

    # urllib3's HTTPSConnection does not subclass http.client's, but both default to port 443.
    default_port = getattr(connection, "default_port", http.client.HTTP_PORT)
    scheme = "https" if default_port == http.client.HTTPS_PORT else "http"
    port = "" if connection.port in (None, default_port) else f":{connection.port}"
    return f"{scheme}://{connection.host}{port}{target}"


def _connect_offline(self) -> None:
    """Gives the connection one end of a local socket pair, so a client that checks for a socket finds one."""
    if self.sock is not None:
        return

    self.sock, self._rewind_peer = socket.socketpair()
    # urllib3 warns on every request over HTTPS it thinks unverified, and a replay makes no TLS connection at all.
    self.is_verified = True


def _patch_urllib3(connection) -> None:
    for name in ("HTTPConnection", "HTTPSConnection"):
        getattr(connection, name).connect = _connect_offline


class _Socket:
    def __init__(self, data: bytes):
        self._file = io.BytesIO(data)

    def makefile(self, *_args, **_kwargs):
        return self._file


def _handed_back_headers(answer: dict) -> list[tuple[str, str]]:
    headers = without_redacted(answer.get("headers") or {})
    return [(name, value) for name, value in headers.items() if name.lower() not in DROPPED_RESPONSE_HEADERS]


def _response(answer: dict, body: bytes, method: str) -> http.client.HTTPResponse:
    """An http.client response that reads the given status, headers and body."""
    lines = [f"HTTP/1.1 {answer['status']} {answer.get('status_text') or 'OK'}"]
    lines += [f"{name}: {value}" for name, value in _handed_back_headers(answer)]
    lines.append(f"content-length: {len(body)}")
    head = ("\r\n".join(lines) + "\r\n\r\n").encode("iso-8859-1")
    response = http.client.HTTPResponse(_Socket(head + body), method=method)
    response.begin()
    return response


def _answer(status: int, reason: str, headers) -> dict:
    merged: dict[str, str] = {}
    for name, value in headers:
        key = name.lower()
        merged[key] = f"{merged[key]}, {value}" if key in merged else value

    return {"status": status, "status_text": reason, "headers": merged}


def _patch_http_client() -> None:
    connection = http.client.HTTPConnection
    original = {name: getattr(connection, name) for name in ("putrequest", "putheader", "endheaders", "send", "getresponse")}
    replaying = capture.MODE == "replay"

    def putrequest(self, method, url, *args, **kwargs):
        self._rewind = _begin(method, _full_url(self, url))
        if replaying:
            # http.client would connect on the first send, and urllib3 reads the socket before its response.
            _connect_offline(self)
            return None

        return original["putrequest"](self, method, url, *args, **kwargs)

    def putheader(self, header, *values):
        exchange = getattr(self, "_rewind", None)
        if exchange is not None:
            exchange.add_header(_text(header), ", ".join(_text(value) for value in values))

        if replaying:
            return None

        return original["putheader"](self, header, *values)

    def endheaders(self, message_body=None, **kwargs):
        exchange = getattr(self, "_rewind", None)
        if exchange is not None:
            exchange.body += _as_bytes(message_body)

        if replaying:
            if exchange is not None:
                exchange.headers_sent = True
            return None

        result = original["endheaders"](self, message_body, **kwargs)
        if exchange is not None:
            exchange.headers_sent = True
        return result

    # Headers go out through send too, so only what is sent after them is body.
    def send(self, data):
        exchange = getattr(self, "_rewind", None)
        if exchange is not None and exchange.headers_sent:
            exchange.body += _as_bytes(data)

        if replaying:
            return None

        return original["send"](self, data)

    def getresponse(self):
        exchange = getattr(self, "_rewind", None)
        self._rewind = None
        if exchange is None:
            return original["getresponse"](self)

        if replaying:
            answer = capture.ask_rewind(exchange.question())
            return _response(answer, capture.body_bytes(answer), exchange.method)

        try:
            real = original["getresponse"](self)
            body = real.read()
        except Exception as error:
            exchange.finish(None, error=error)
            raise

        answer = _answer(real.status, real.reason, real.getheaders())
        exchange.finish(answer, body)
        return _response(answer, body, exchange.method)

    for name, patched in [("putrequest", putrequest), ("putheader", putheader), ("endheaders", endheaders), ("send", send), ("getresponse", getresponse)]:
        setattr(connection, name, patched)

    if replaying:
        connection.connect = _connect_offline
        # http.client leaves HTTPSConnection out when Python was built without ssl.
        if hasattr(http.client, "HTTPSConnection"):
            http.client.HTTPSConnection.connect = _connect_offline


def _httpx_response(httpx, answer: dict, body: bytes, request):
    return httpx.Response(answer["status"], headers=_handed_back_headers(answer), content=body, request=request)


def _httpx_exchange(request) -> _Exchange | None:
    exchange = _begin(request.method, str(request.url))
    if exchange is None:
        return None

    for name, value in request.headers.multi_items():
        exchange.add_header(name, value)

    exchange.body += request.read()
    return exchange


def _patch_httpx(httpx) -> None:
    sync_send = httpx.HTTPTransport.handle_request
    async_send = httpx.AsyncHTTPTransport.handle_async_request

    # The raw bytes, still encoded, so the client decodes them once as usual.
    def handle_request(self, request):
        exchange = _httpx_exchange(request)
        if exchange is None:
            return sync_send(self, request)

        if capture.MODE == "replay":
            answer = capture.ask_rewind(exchange.question())
            return _httpx_response(httpx, answer, capture.body_bytes(answer), request)

        try:
            real = sync_send(self, request)
            body = b"".join(real.iter_raw())
        except Exception as error:
            exchange.finish(None, error=error)
            raise

        answer = _answer(real.status_code, real.reason_phrase, real.headers.multi_items())
        exchange.finish(answer, body)
        return _httpx_response(httpx, answer, body, request)

    async def handle_async_request(self, request):
        exchange = _httpx_exchange(request)
        if exchange is None:
            return await async_send(self, request)

        if capture.MODE == "replay":
            answer = await capture.ask_rewind_async(exchange.question())
            return _httpx_response(httpx, answer, capture.body_bytes(answer), request)

        try:
            real = await async_send(self, request)
            body = b"".join([chunk async for chunk in real.aiter_raw()])
        except Exception as error:
            exchange.finish(None, error=error)
            raise

        answer = _answer(real.status_code, real.reason_phrase, real.headers.multi_items())
        exchange.finish(answer, body)
        return _httpx_response(httpx, answer, body, request)

    httpx.HTTPTransport.handle_request = handle_request
    httpx.AsyncHTTPTransport.handle_async_request = handle_async_request


def install() -> None:
    _patch_http_client()
    after_import("httpx", _patch_httpx)
    if capture.MODE == "replay":
        after_import("urllib3.connection", _patch_urllib3)

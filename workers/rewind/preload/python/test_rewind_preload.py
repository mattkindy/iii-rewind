"""Tests for the Python preload that need no iii engine. A test that loads the
preload runs a child Python with this folder on PYTHONPATH, the way a worker
starts, and replaces the preload's call to Rewind with a canned answer.

The requests and urllib3 tests are skipped when those packages are missing,
and the tools venv does not have them, so the README runs this file with uv
and adds them, once with urllib3 1.26 and once with urllib3 2.x.
"""

import hashlib
import importlib.machinery
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

PRELOAD = Path(__file__).resolve().parent
sys.path.insert(0, str(PRELOAD))

from rewind_preload import capture, imports, outbound  # noqa: E402
from rewind_preload.headers import REDACTED, asked_headers, recorded_headers  # noqa: E402

HAS_REQUESTS = importlib.util.find_spec("requests") is not None
HAS_URLLIB3 = importlib.util.find_spec("urllib3") is not None
SECRETS = {"Authorization": "Bearer sk-test-secret", "Cookie": "session=cookie-secret", "X-Api-Key": "key-secret", "X-Tenant": "tenant-secret"}

# A server in the child that keeps the headers it got and sends a cookie and a body over the cap.
RECORD_PRELUDE = """
import http.server, json, threading
from rewind_preload import capture
capture.current_invocation = lambda: {"invocation_id": "inv-1", "function_id": "test::call"}
seen = {}

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        seen.update(self.headers.items())
        self.rfile.read(int(self.headers["content-length"]))
        body = b"x" * 200_000
        self.send_response(200)
        self.send_header("set-cookie", "session=set-cookie-secret")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_address[1]}/thing"
"""

# The child's answer from Rewind, which records every question it is asked.
REPLAY_PRELUDE = """
import json
from rewind_preload import capture
questions = []

def ask(request):
    questions.append(request)
    return {"status": 200, "status_text": "OK", "headers": {"content-type": "text/plain", "set-cookie": "[redacted]"}, "body": "from rewind"}

capture.ask_rewind = ask
"""


class _Trap:
    """A local server that a replayed request must never reach. It counts each connection and drops it."""

    def __init__(self):
        self.reached = 0
        self._server = socket.create_server(("127.0.0.1", 0))
        self._server.settimeout(0.1)
        self.port = self._server.getsockname()[1]
        self._open = True
        self._thread = threading.Thread(target=self._accept, daemon=True)
        self._thread.start()

    def _accept(self):
        while self._open:
            try:
                connection, _ = self._server.accept()
            except (TimeoutError, OSError):
                continue

            self.reached += 1
            connection.close()

    def close(self):
        self._open = False
        self._thread.join()
        self._server.close()


class _ChildTest(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="rewind-preload-"))
        self.addCleanup(shutil.rmtree, self.folder, ignore_errors=True)
        self.captures_file = self.folder / "captures.jsonl"

    def run_child(self, mode: str, source: str, **env) -> dict:
        child_env = {
            **os.environ,
            "PYTHONPATH": str(PRELOAD),
            "REWIND_CAPTURE": mode,
            "REWIND_CAPTURE_FILE": str(self.captures_file),
            "REWIND_REDACT_HEADERS": "x-tenant",
            **env,
        }
        done = subprocess.run([sys.executable, "-c", source], env=child_env, cwd=self.folder, capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("rewind preload", done.stderr)
        return json.loads(done.stdout.strip().splitlines()[-1])

    def captures(self) -> list[dict]:
        if not self.captures_file.exists():
            return []

        return [json.loads(line) for line in self.captures_file.read_text().splitlines()]


class HeaderTest(unittest.TestCase):
    def test_a_capture_keeps_secret_header_names_and_hides_their_values(self):
        stored = recorded_headers({"authorization": "Bearer x", "x-goog-api-key": "k", "x-csrf-token": "t", "accept": "*/*", "traceparent": "00-1"})
        self.assertEqual(stored, {"authorization": REDACTED, "x-goog-api-key": REDACTED, "x-csrf-token": REDACTED, "accept": "*/*"})

    def test_a_question_leaves_secret_headers_out_and_lists_their_names(self):
        self.assertEqual(
            asked_headers({"authorization": "Bearer x", "cookie": "a=b", "accept": "*/*", "baggage": "b"}),
            {"headers": {"accept": "*/*"}, "redacted_headers": ["authorization", "cookie"]},
        )
        self.assertEqual(asked_headers({"accept": "*/*"}), {"headers": {"accept": "*/*"}})


class BodyTest(unittest.TestCase):
    def test_a_body_under_the_cap_is_stored_whole(self):
        self.assertEqual(capture.body_fields(b"hello"), {"body": "hello"})
        self.assertEqual(capture.body_fields(b"\xff\x00"), {"body": "/wA=", "body_encoding": "base64"})
        self.assertEqual(capture.body_fields(b""), {"body": None})

    def test_a_body_over_the_cap_is_cut_and_says_how_long_it_was(self):
        whole = b"z" * (capture.MAX_BODY_BYTES + 10)
        stored = capture.body_fields(whole)
        self.assertEqual(len(stored["body"]), capture.MAX_BODY_BYTES)
        self.assertEqual(stored["body_truncated"], {"bytes": len(whole), "sha256": hashlib.sha256(whole).hexdigest()})

    def test_text_is_cut_on_a_character_boundary(self):
        whole = ("a" * (capture.MAX_BODY_BYTES - 1) + "é" + "b" * 10).encode("utf-8")
        stored = capture.body_fields(whole)
        self.assertEqual(stored["body"], "a" * (capture.MAX_BODY_BYTES - 1))
        self.assertNotIn("body_encoding", stored)

    def test_the_question_cuts_a_body_the_way_the_capture_does(self):
        exchange = outbound._Exchange({}, "post", "http://127.0.0.1:9/send")
        exchange.add_header("Authorization", "Bearer x")
        exchange.body += b"q" * (capture.MAX_BODY_BYTES * 2)
        question = exchange.question()
        self.assertNotIn("authorization", question["headers"])
        self.assertEqual(question["redacted_headers"], ["authorization"])
        self.assertEqual(question["body"], capture.body_fields(bytes(exchange.body))["body"])
        self.assertEqual(question["body_truncated"]["bytes"], capture.MAX_BODY_BYTES * 2)


class ConnectionLockTest(unittest.TestCase):
    def test_threads_asking_at_once_open_one_connection(self):
        opened = []

        def register_worker(url, options):
            time.sleep(0.05)
            opened.append(url)
            return object()

        fake = types.SimpleNamespace(InitOptions=lambda **options: options, register_worker=register_worker)
        with mock.patch.dict(sys.modules, {"iii": fake}), mock.patch.object(capture, "_connection", None):
            threads = [threading.Thread(target=capture._rewind) for _ in range(8)]
            for thread in threads:
                thread.start()

            for thread in threads:
                thread.join()

        self.assertEqual(len(opened), 1)


class ImportFinderTest(unittest.TestCase):
    def test_the_finder_goes_right_before_path_finder(self):
        with mock.patch.object(sys, "meta_path", list(sys.meta_path)):
            imports._listen()
            imports._listen()
            names = [type(finder).__module__ for finder in sys.meta_path]
            at = sys.meta_path.index(importlib.machinery.PathFinder)

        self.assertEqual(names.count("rewind_preload.imports"), 1)
        self.assertEqual(names[at - 1], "rewind_preload.imports")


class RecordTest(_ChildTest):
    def check_capture(self, reported: dict) -> None:
        for name, value in SECRETS.items():
            self.assertEqual(reported["seen"][name], value, f"the server got {name}")

        self.assertEqual(reported["length"], 200_000)
        text = self.captures_file.read_text()
        for value in [*SECRETS.values(), "set-cookie-secret"]:
            self.assertNotIn(value, text)

        [sent] = self.captures()
        self.assertEqual(sent["kind"], "http_out")
        self.assertEqual(sent["invocation_id"], "inv-1")
        for name in SECRETS:
            self.assertEqual(sent["input"]["headers"][name.lower()], REDACTED)

        self.assertEqual(sent["input"]["body_truncated"]["bytes"], 100_000)
        self.assertEqual(len(sent["input"]["body"]), capture.MAX_BODY_BYTES)
        self.assertEqual(sent["output"]["headers"]["set-cookie"], REDACTED)
        self.assertEqual(sent["output"]["body_truncated"]["bytes"], 200_000)
        self.assertEqual(len(sent["output"]["body"]), capture.MAX_BODY_BYTES)

    def test_urllib_sends_credentials_but_stores_none_and_caps_bodies(self):
        source = RECORD_PRELUDE + f"""
import urllib.request
request = urllib.request.Request(url, data=b"y" * 100_000, headers={SECRETS!r}, method="POST")
length = len(urllib.request.urlopen(request).read())
print(json.dumps({{"seen": seen, "length": length}}))
"""
        self.check_capture(self.run_child("record", source))

    @unittest.skipUnless(HAS_REQUESTS, "requests is not installed")
    def test_requests_sends_credentials_but_stores_none_and_caps_bodies(self):
        source = RECORD_PRELUDE + f"""
import requests
length = len(requests.post(url, data=b"y" * 100_000, headers={SECRETS!r}).content)
print(json.dumps({{"seen": seen, "length": length}}))
"""
        self.check_capture(self.run_child("record", source))


class ReplayTest(_ChildTest):
    def setUp(self):
        super().setUp()
        self.trap = _Trap()
        self.addCleanup(self.trap.close)

    def check_answers(self, reported: dict) -> None:
        self.assertEqual(self.trap.reached, 0, "a replayed request opened a socket to its host")
        self.assertEqual(reported["texts"], ["from rewind"] * 3)
        self.assertEqual(reported["set_cookie"], None)
        questions = reported["questions"]
        self.assertEqual([question["url"].split(":")[0] for question in questions], ["http", "http", "https"])
        self.assertNotIn("authorization", questions[0]["headers"])
        self.assertEqual(questions[0]["redacted_headers"], ["authorization"])
        self.assertEqual(self.captures(), [])

    @unittest.skipUnless(HAS_REQUESTS, "requests is not installed")
    def test_a_requests_call_never_reaches_its_host(self):
        source = REPLAY_PRELUDE + f"""
import requests
session = requests.Session()
first = session.get("http://127.0.0.1:{self.trap.port}/a", headers={{"Authorization": "Bearer sk-test-secret"}})
again = session.get("http://127.0.0.1:{self.trap.port}/b")
secure = requests.post("https://127.0.0.1:{self.trap.port}/c", data=b"hi")
texts = [response.text for response in (first, again, secure)]
print(json.dumps({{"texts": texts, "set_cookie": first.headers.get("set-cookie"), "questions": questions}}))
"""
        self.check_answers(self.run_child("replay", source))

    @unittest.skipUnless(HAS_URLLIB3, "urllib3 is not installed")
    def test_a_urllib3_call_never_reaches_its_host(self):
        source = REPLAY_PRELUDE + f"""
import urllib3
pool = urllib3.PoolManager()
first = pool.request("GET", "http://127.0.0.1:{self.trap.port}/a", headers={{"Authorization": "Bearer sk-test-secret"}})
again = pool.request("GET", "http://127.0.0.1:{self.trap.port}/b")
secure = pool.request("POST", "https://127.0.0.1:{self.trap.port}/c", body=b"hi")
texts = [response.data.decode() for response in (first, again, secure)]
print(json.dumps({{"texts": texts, "set_cookie": first.headers.get("set-cookie"), "questions": questions}}))
"""
        self.check_answers(self.run_child("replay", source))


class OffTest(_ChildTest):
    def test_off_installs_nothing_and_writes_no_capture(self):
        source = """
import http.client, json, sys, urllib.request
print(json.dumps({
    "loaded": sorted(name for name in sys.modules if name.startswith("rewind_preload")),
    "putrequest": http.client.HTTPConnection.putrequest.__module__,
    "finders": [type(finder).__module__ for finder in sys.meta_path],
}))
"""
        reported = self.run_child("off", source, REWIND_TRACE_FUNCTIONS="main.py:anything")
        self.assertEqual(reported["loaded"], [])
        self.assertEqual(reported["putrequest"], "http.client")
        self.assertNotIn("rewind_preload.imports", reported["finders"])
        self.assertEqual(self.captures(), [])


if __name__ == "__main__":
    unittest.main()

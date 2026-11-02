"""Function spans for the functions someone asked to trace, named as
``<file>:<function>`` with the file relative to the worker's folder. The list
comes from REWIND_TRACE_FUNCTIONS, comma separated, or else from
``trace_functions`` in rewind.json in the worker's folder.

Each call made inside an iii handler becomes a ``function`` capture with its
arguments, its result or exception, and its timing, and an OpenTelemetry span
in the current context, so the ADE's Traces view puts it under the iii span.

A function in a module that gets imported is wrapped right after the import.
The script Python was started with is never imported, so a function in it is
wrapped when it is registered as an iii handler, which covers find_slot.
"""

import contextlib
import functools
import inspect
import json
import os
import time
from pathlib import Path

from . import capture
from .imports import after_import, after_import_of_file

MAX_CHARS = 4_000


def _configured() -> list[str]:
    if os.environ.get("REWIND_TRACE_FUNCTIONS"):
        return os.environ["REWIND_TRACE_FUNCTIONS"].split(",")

    config = Path.cwd() / "rewind.json"
    if not config.is_file():
        return []

    return json.loads(config.read_text()).get("trace_functions", [])


def _targets() -> dict[tuple[str, str], str]:
    """Each traced function's real file path and name, with the id it was listed as."""
    found = {}
    for entry in _configured():
        target = entry.strip()
        if ":" not in target:
            continue

        file, name = target.rsplit(":", 1)
        found[(os.path.realpath(Path.cwd() / file), name)] = target

    return found


def _describe(value):
    if isinstance(value, BaseException):
        return {"$error": type(value).__name__, "message": str(value)}

    if hasattr(value, "isoformat"):
        return value.isoformat()

    return {"$type": type(value).__name__, "repr": repr(value)[:200]}


def summarize(value):
    """The value as JSON Rewind can store, described where JSON can't hold it, and cut to a preview when long."""
    try:
        text = json.dumps(value, default=_describe)
    except (TypeError, ValueError) as error:
        return {"$unserializable": type(value).__name__, "reason": str(error)}

    if len(text) > MAX_CHARS:
        return {"$truncated": len(text), "preview": text[:MAX_CHARS]}

    return json.loads(text)


def _span(name: str, target: str):
    try:
        from opentelemetry import trace
    except ImportError:
        return contextlib.nullcontext()

    attributes = {"code.function": name, "rewind.function": target}
    return trace.get_tracer("rewind").start_as_current_span(name, attributes=attributes)


class _Call:
    def __init__(self, target: str, invocation: dict, args, kwargs):
        self.target = target
        self.invocation = invocation
        self.trace = capture.current_trace()
        self.args = args
        self.kwargs = kwargs
        self.started_at_ms = int(time.time() * 1000)
        self.started = time.perf_counter()

    def finish(self, result=None, error: BaseException | None = None) -> None:
        if capture.MODE != "record":
            return

        arguments = {"args": summarize(list(self.args))}
        if self.kwargs:
            arguments["kwargs"] = summarize(self.kwargs)

        capture.write_capture(
            {
                "kind": "function",
                "name": f"function {self.target}",
                **self.invocation,
                **self.trace,
                "started_at_ms": self.started_at_ms,
                "duration_ms": (time.perf_counter() - self.started) * 1000,
                "input": arguments,
                "output": None if error is not None else summarize(result),
                "error": None if error is None else {"code": type(error).__name__, "message": str(error)},
            }
        )


def traced(target: str, function):
    name = target.rsplit(":", 1)[1]
    if inspect.iscoroutinefunction(function):

        @functools.wraps(function)
        async def wrapper(*args, **kwargs):
            invocation = capture.current_invocation()
            if invocation is None:
                return await function(*args, **kwargs)

            with _span(name, target):
                call = _Call(target, invocation, args, kwargs)
                try:
                    result = await function(*args, **kwargs)
                except BaseException as error:
                    call.finish(error=error)
                    raise

                call.finish(result)
                return result

        return wrapper

    @functools.wraps(function)
    def wrapper(*args, **kwargs):
        invocation = capture.current_invocation()
        if invocation is None:
            return function(*args, **kwargs)

        with _span(name, target):
            call = _Call(target, invocation, args, kwargs)
            try:
                result = function(*args, **kwargs)
            except BaseException as error:
                call.finish(error=error)
                raise

            call.finish(result)
            return result

    return wrapper


def _target_of(function, targets: dict) -> str | None:
    code = getattr(function, "__code__", None)
    if code is None:
        return None

    return targets.get((os.path.realpath(code.co_filename), code.co_name))


def _wrap_handlers(targets: dict):
    def patch(module) -> None:
        register = module.III.register_function

        @functools.wraps(register)
        def register_function(self, function_id, handler, *args, **kwargs):
            target = _target_of(handler, targets)
            if target is not None:
                handler = traced(target, handler)

            return register(self, function_id, handler, *args, **kwargs)

        module.III.register_function = register_function

    return patch


def _wrap_module(names: list[tuple[str, str]]):
    def wrap(module) -> None:
        for name, target in names:
            function = getattr(module, name, None)
            if callable(function):
                setattr(module, name, traced(target, function))

    return wrap


def install() -> None:
    targets = _targets()
    if not targets:
        return

    by_file: dict[str, list[tuple[str, str]]] = {}
    for (file, name), target in targets.items():
        by_file.setdefault(file, []).append((name, target))

    for file, names in by_file.items():
        after_import_of_file(file, _wrap_module(names))

    after_import("iii.iii", _wrap_handlers(targets))

"""Rewind's preload for Python workers. Python imports this module at startup
when its folder is on PYTHONPATH, and it captures what the worker does around
iii, the way the Node preload does.

REWIND_CAPTURE=record, the default, appends each capture to the capture file
for Rewind to read. Rewind starts its copies with REWIND_CAPTURE=replay, where
each request gets its response from Rewind. REWIND_CAPTURE=off turns the
preload off, and then it imports none of its modules and changes nothing.
"""

import os
import sys


def _install() -> None:
    from rewind_preload import outbound, spans

    outbound.install()
    spans.install()


# The worker should still start when the preload cannot.
if os.environ.get("REWIND_CAPTURE", "record") != "off":
    try:
        _install()
    except Exception as error:
        print(f"rewind preload: not installed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)

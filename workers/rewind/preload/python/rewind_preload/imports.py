"""Running a callback on a module right after it is first imported, found by
its name or by its file, so the preload can patch httpx or wrap a named
function without importing anything the worker never uses.
"""

import importlib.abc
import importlib.machinery
import os
import sys
from typing import Callable

_by_name: dict[str, list[Callable]] = {}
_by_file: dict[str, list[Callable]] = {}


class _Loader(importlib.abc.Loader):
    def __init__(self, loader, callbacks):
        self._loader = loader
        self._callbacks = callbacks

    def create_module(self, spec):
        return self._loader.create_module(spec)

    def exec_module(self, module):
        self._loader.exec_module(module)
        for callback in self._callbacks:
            callback(module)


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name not in _by_name and not _by_file:
            return None

        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if spec is None or spec.loader is None:
            return None

        origin = os.path.realpath(spec.origin) if spec.origin else ""
        callbacks = _by_name.pop(name, []) + _by_file.pop(origin, [])
        if not callbacks:
            return None

        spec.loader = _Loader(spec.loader, callbacks)
        return spec


def _listen() -> None:
    if any(isinstance(finder, _Finder) for finder in sys.meta_path):
        return

    # PathFinder would load the module without the callbacks, so this finder goes right before it.
    # Finders that already come first, such as the builtin and frozen ones, keep their turn.
    at = next((index for index, finder in enumerate(sys.meta_path) if finder is importlib.machinery.PathFinder), 0)
    sys.meta_path.insert(at, _Finder())


def after_import(name: str, callback: Callable) -> None:
    """Calls ``callback(module)`` once the module named ``name`` has run, or now if it already has."""
    if name in sys.modules:
        callback(sys.modules[name])
        return

    _by_name.setdefault(name, []).append(callback)
    _listen()


def after_import_of_file(file: str, callback: Callable) -> None:
    """Calls ``callback(module)`` once the module loaded from ``file``, a real path, has run."""
    _by_file.setdefault(file, []).append(callback)
    _listen()

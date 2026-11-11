"""One process lifetime for a native CLI, including terminal hangup."""
from __future__ import annotations

import signal
import subprocess


def run_child(binary: str, args: list[str], env: dict[str, str]) -> int:
    previous = {signal.SIGINT: signal.signal(signal.SIGINT, signal.SIG_IGN)}
    child: subprocess.Popen[bytes] | None = None

    def stopped(signum: int, frame: object) -> None:
        raise SystemExit(128 + signum)

    try:
        for name in ("SIGTERM", "SIGHUP"):
            signum = getattr(signal, name, None)
            if signum is not None:
                previous[signum] = signal.signal(signum, stopped)
        child = subprocess.Popen([binary, *args], env=env)
        return child.wait()
    finally:
        try:
            if child and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        finally:
            for signum, handler in previous.items():
                signal.signal(signum, handler)

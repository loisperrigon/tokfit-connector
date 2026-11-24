"""Process-local readiness for the standalone Antigravity plugin's hook."""
from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
import socket
import subprocess
import threading

OWNER = "TOKFIT_ANTIGRAVITY_OWNER"
PLUGINS = "PLUGIN_ROOT"
LOG = logging.getLogger(__name__)
TIMEOUT = 0.1


def plugin_enabled(root: Path, server: str) -> bool:
    # agy 1.5.16 can still spawn a plugin MCP after recording its explicit disable.
    registry = root.parent.parent / "mcp_config.json"
    try:
        with registry.open("rb") as config:
            settings = json.loads(config.read(1024 * 1024))
    except FileNotFoundError:
        return True
    except (OSError, ValueError, RecursionError):
        LOG.debug("Antigravity MCP registry could not be read")
        return True
    servers = settings.get("mcpServers") if isinstance(settings, dict) else None
    entry = servers.get(server) if isinstance(servers, dict) else None
    return not isinstance(entry, dict) or entry.get("disabled") is not True


def endpoint(root: str, owner: int) -> tuple[tuple[int, int], bytes]:
    identity = hashlib.sha256(f"tokfit-agy\0{root}\0{owner}".encode()).digest()
    ports = (11000 + int.from_bytes(identity[:2], "big") % 8000,
             19000 + int.from_bytes(identity[2:4], "big") % 8000)
    return ports, identity.hex().encode("ascii") + b"\n"


def available(root: str, owner: int) -> bool:
    ports, identity = endpoint(root, owner)
    for port in ports:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=TIMEOUT) as connection:
                connection.sendall(identity)
                with connection.makefile("rb") as stream:
                    if stream.readline(len(identity)) == identity:
                        return True
        except OSError:
            continue
    return False


def hook_available(root: str) -> bool:
    parent = os.getppid()
    if available(root, parent):
        return True
    # agy runs a command hook through a shell. MCP is a direct child of agy.
    try:
        ppid = subprocess.run(["ps", "-o", "ppid=", "-p", str(parent)], capture_output=True,
                              check=True, timeout=0.25).stdout
        owner = int(ppid)
    except (OSError, ValueError, subprocess.SubprocessError):
        return False
    return owner > 1 and available(root, owner)


class Readiness:
    def __init__(self, root: str, owner: int) -> None:
        self.listener: socket.socket | None = None
        self.thread: threading.Thread | None = None
        self.active = threading.Event()
        self.closed = threading.Event()
        self.lock = threading.Lock()
        self.ports, self.identity = endpoint(root, owner)

    def update(self, listed: bool) -> None:
        if not listed:
            self.active.clear()
            return
        with self.lock:
            if self.closed.is_set():
                return
            self.active.set()
            if self.listener is not None:
                return
            for port in self.ports:
                try:
                    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                except OSError:
                    break
                try:
                    listener.bind(("127.0.0.1", port))
                    listener.listen(4)
                    listener.settimeout(TIMEOUT)
                except OSError:
                    listener.close()
                    continue
                self.listener = listener
                self.thread = threading.Thread(target=self.serve, args=(listener,), daemon=True)
                self.thread.start()
                return
            LOG.warning("Antigravity kernel readiness endpoint unavailable")

    def serve(self, listener: socket.socket) -> None:
        while not self.closed.is_set():
            try:
                connection, _ = listener.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            with connection:
                connection.settimeout(TIMEOUT)
                try:
                    with connection.makefile("rb") as stream:
                        identity = stream.readline(len(self.identity))
                    if self.active.is_set() and identity == self.identity:
                        connection.sendall(self.identity)
                except OSError:
                    LOG.debug("Antigravity readiness check disconnected")

    def close(self) -> None:
        with self.lock:
            self.active.clear()
            self.closed.set()
            if self.listener is not None:
                self.listener.close()
        if self.thread is not None:
            self.thread.join(TIMEOUT * 2)

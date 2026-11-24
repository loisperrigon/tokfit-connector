"""One process lifetime for a native CLI, including terminal hangup."""
from __future__ import annotations

import http.client
import json
import re
import signal
import subprocess
import sys
from pathlib import Path
from typing import Callable, IO
from urllib.parse import urlsplit


# Full native Codex 0.171 messages. Scope the presentation change to chat
# notifications: prompts, tool results, JSON-RPC errors and stderr pass through.
_CHAT_NOTICE = re.compile(
    r"Loaded only [0-9]+ of [0-9]+ bytes from `.+` in environment `.+` under the "
    r"[0-9]+-byte project instruction budget\. Trim your project instructions to fit the budget\. "
    r"If you need to keep them all, increase `project_doc_max_bytes`\."
    r"|Combined user instructions use [0-9]+ bytes, above the [0-9]+-byte `project_doc_max_bytes` "
    r"setting\. The total includes global and thread instructions\. The limit applies only to project files\."
    r"|ignoring additionalContextLimit for (?:PreCompact|PostCompact) hook in .+"
    r": this event cannot emit additionalContext"
)
_FRAME_LIMIT = 16 * 1024


# Global and exec options whose value can resemble a subcommand or --json.
_VALUE_OPTIONS = frozenset(("-c", "--config", "--enable", "--disable", "-m", "--model", "-p", "--profile",
                            "-C", "--cd", "-i", "--image", "-s", "--sandbox", "-a", "--ask-for-approval",
                            "--local-provider", "--add-dir", "--remote", "--remote-auth-token-env",
                            "--output-schema", "-o", "--output-last-message", "--color", "--thread-source",
                            "--code-mode-host", "--cyber-access-program"))
_GLOBAL_FLAGS = frozenset(("--strict-config", "--search", "--no-alt-screen", "--no-daemon", "--worktree",
                          "--oss", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox",
                          "--dangerously-bypass-hook-trust"))


def codex_output_mode(args: list[str]) -> str | None:
    """Recognize the two native JSONL formats. A terminal keeps its own file descriptors."""
    mode = None
    json_output = False
    options = iter(args)
    for arg in options:
        key, sep, inline = arg.partition("=")
        if key in _VALUE_OPTIONS:
            if not sep:
                next(options, None)
        elif arg == "--":
            break
        elif arg in ("-h", "--help", "-V", "--version"):
            return None
        elif mode is None:
            if arg in ("app-server", "exec", "e"):
                mode = arg
            elif arg not in _GLOBAL_FLAGS:
                return None
        elif mode == "app-server":
            if key == "--listen":
                if (inline if sep else next(options, None)) != "stdio://":
                    return None
            elif not arg.startswith("-"):
                return None  # generate-ts, generate-json-schema, etc.
        elif arg in ("--json", "--experimental-json"):
            json_output = True
    if mode == "app-server":
        return "rpc"
    return "exec" if json_output else None


def _chat_notice(line: bytes, mode: str) -> bool:
    if b"project_doc_max_bytes" not in line and b"additionalContextLimit" not in line:
        return False
    try:
        event = json.loads(line)
    except (ValueError, RecursionError):
        return False
    if not isinstance(event, dict) or "id" in event:
        return False
    if mode == "rpc" and event.get("method") == "warning":
        params = event.get("params")
    elif mode == "exec" and event.get("type") == "item.completed":
        params = event.get("item")
        if not isinstance(params, dict) or params.get("type") != "error":
            return False
    else:
        return False
    message = params.get("message") if isinstance(params, dict) else None
    return isinstance(message, str) and _CHAT_NOTICE.fullmatch(message) is not None


def forward_chat(source: IO[bytes], output: IO[bytes], mode: str) -> None:
    """Forward original bytes; large frames stream in bounded chunks without inspection."""
    at_start = True
    while True:
        chunk = source.readline(_FRAME_LIMIT)
        if not chunk:
            break
        complete = chunk.endswith(b"\n")
        if not (at_start and complete and _chat_notice(chunk, mode)):
            output.write(chunk)
            output.flush()
        at_start = complete


def run_child(binary: str, args: list[str], env: dict[str, str], *,
              output_mode: str | None = None,
              pipe: Callable[[subprocess.Popen[bytes]], None] | None = None) -> int:
    previous = {signal.SIGINT: signal.signal(signal.SIGINT, signal.SIG_IGN)}
    child: subprocess.Popen[bytes] | None = None

    def stopped(signum: int, frame: object) -> None:
        raise SystemExit(128 + signum)

    try:
        for name in ("SIGTERM", "SIGHUP"):
            signum = getattr(signal, name, None)
            if signum is not None:
                previous[signum] = signal.signal(signum, stopped)
        child = subprocess.Popen([binary, *args], env=env,
                                 stdin=subprocess.PIPE if pipe else None,
                                 stdout=subprocess.PIPE if output_mode or pipe else None)
        try:
            if pipe:
                pipe(child)
            elif child.stdout is not None and output_mode:
                with child.stdout:
                    forward_chat(child.stdout, sys.stdout.buffer, output_mode)
        except BrokenPipeError:
            return 1  # The client has disconnected; reap the server below.
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


def _bridge_post(env: dict[str, str], payload: dict[str, object]) -> None:
    """Post a structured status event to Alfie's local bridge, outside ACP."""
    bridge, pane = env.get("OPEN_CODEX_BRIDGE"), env.get("OPEN_CODEX_PANE")
    if not (bridge and pane):
        return
    try:
        data = json.loads(Path(bridge).read_bytes())
        if not isinstance(data, dict):
            return
        url = data.get("url")
        token = data.get("token")
        if not isinstance(url, str) or not isinstance(token, str) or not token:
            return
        address = urlsplit(url)
        if (address.scheme, address.netloc, address.path) != (
                "http", f"127.0.0.1:{address.port}", "/hook"):
            return
        conn = http.client.HTTPConnection("127.0.0.1", address.port, timeout=0.3)
        try:
            body = {"pane": pane, "token": token, **payload}
            conn.request("POST", "/hook", json.dumps(body), {"Content-Type": "application/json"})
            conn.getresponse().close()
        finally:
            conn.close()
    except (OSError, ValueError, http.client.HTTPException):
        return


def report_tokfit(env: dict[str, str], reason: str) -> None:
    """Report a fixed launch outcome to Alfie's local bridge, outside ACP."""
    run = env.get("OPEN_CODEX_TOKFIT_RUN")
    if not run:
        return
    _bridge_post(env, {"event": "TokfitStatus", "tokfit": {"run": run, "reason": reason}})


def report_route(env: dict[str, str], route: dict[str, object]) -> None:
    """Report a routing decision outcome to Alfie's local bridge, outside ACP."""
    _bridge_post(env, {"event": "RouteStatus", "route": route})

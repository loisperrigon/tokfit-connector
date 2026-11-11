#!/usr/bin/env python3
"""Bounded native Stop adapter. Transcripts stay local and are never written.

Only native plan statuses leave this process. The service owns the decision
and continuation text; this adapter cannot grant permissions or change models.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import re
import shlex
import sys
from typing import Iterable, TextIO
from urllib.parse import urlsplit
import urllib.request

Json = dict[str, object]
MAX_INPUT = 64 * 1024
MAX_TRANSCRIPT = 4 * 1024 * 1024
LOG = logging.getLogger("tokfit.completion")


def pending(rows: Iterable[object]) -> int:
    """Latest supported plan in this turn; tool results are not user prompts."""
    count = 0
    tasks: dict[str, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        payload = row.get("payload", {})
        if row.get("type") == "event_msg" and isinstance(payload, dict) and payload.get("type") == "task_started":
            count = 0
            tasks.clear()
        message = row.get("message", {})
        content = message.get("content") if isinstance(message, dict) else None
        if row.get("type") == "user" and (isinstance(content, str) or isinstance(content, list) and any(
                isinstance(part, dict) and part.get("type") == "text" for part in content)):
            count = 0
            tasks.clear()
        # Claude records typed native task results outside tool_result.content.
        result = row.get("toolUseResult")
        if isinstance(result, dict):
            task = result.get("task")
            if isinstance(task, dict) and isinstance(task.get("id"), str) and len(tasks) < 10000:
                status = task.get("status", "pending")
                if status in ("pending", "in_progress", "completed", "deleted"):
                    tasks[task["id"]] = status
            change = result.get("statusChange")
            task_id = result.get("taskId")
            if result.get("success") is True and isinstance(task_id, str) and isinstance(change, dict) and (task_id in tasks or len(tasks) < 10000):
                status = change.get("to")
                if status in ("pending", "in_progress", "completed", "deleted"):
                    tasks[task_id] = status
        calls: list[Json] = []
        if row.get("type") == "response_item" and isinstance(payload, dict) and payload.get("type") == "function_call":
            calls.append(payload)
        if row.get("type") == "assistant" and isinstance(content, list):
            calls.extend(part for part in content if isinstance(part, dict) and part.get("type") == "tool_use")
        for call in calls:
            name = call.get("name")
            if name not in ("update_plan", "functions.update_plan", "TodoWrite"):
                continue
            value = call.get("input") if name == "TodoWrite" else call.get("arguments")
            if isinstance(value, str):
                try:
                    value = json.loads(value)
                except ValueError:
                    count = 0
                    continue
            items = value.get("todos" if name == "TodoWrite" else "plan") if isinstance(value, dict) else None
            if not isinstance(items, list) or len(items) > 10000 or any(
                    not isinstance(item, dict) or item.get("status") not in ("pending", "in_progress", "completed") for item in items):
                count = 0
                continue
            count = sum(item["status"] != "completed" for item in items)
    return min(10000, count + sum(status in ("pending", "in_progress") for status in tasks.values()))


def link(env: dict[str, str]) -> tuple[str, str] | None:
    url, key = env.get("TOKFIT_RELAY_URL"), env.get("TOKFIT_RELAY_TOKEN")
    relay = bool(url and key)
    if not url or not key:
        path = Path(env.get("TOKFIT_CONFIG") or str(Path.home() / ".config/tokfit/config.json"))
        try:
            with path.open("rb") as file:
                config = json.loads(file.read(MAX_INPUT))
            if not isinstance(config, dict):
                config = {}
        except (OSError, ValueError):
            config = {}
        # Claude passes plugin options in the hook environment, never in argv.
        url = env.get("CLAUDE_PLUGIN_OPTION_SERVICE_URL") or config.get("url")
        key = env.get("CLAUDE_PLUGIN_OPTION_API_KEY") or config.get("key")
    if not isinstance(url, str) or not isinstance(key, str) or not key:
        return None
    parsed = urlsplit(url)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        return None
    if parsed.scheme != "https" and not (parsed.scheme == "http" and (relay or parsed.hostname in ("localhost", "127.0.0.1"))):
        return None
    return url.rstrip("/"), key


def request(url: str, key: str, facts: Json) -> Json | None:
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req: urllib.request.Request, fp: object, code: int, msg: str,
                             headers: object, newurl: str) -> None:
            return None
    try:
        req = urllib.request.Request(url + "/v1/optimizations", json.dumps(facts).encode(),
                                     {"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=2) as response:
            value = json.loads(response.read(MAX_INPUT))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        LOG.debug("Completion policy unavailable; keeping native stop")
        return None


def decide(event: Json, env: dict[str, str], engine: str) -> Json:
    off = [word.strip() for word in env.get("TOKFIT_OFF", "").split(",") if word.strip()]
    if event.get("hook_event_name") != "Stop" or event.get("stop_hook_active") is not False or "persistence" in off:
        return {}
    to = link(env)
    path, session = event.get("transcript_path"), event.get("session_id")
    if not to or not isinstance(path, str) or not isinstance(session, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session):
        return {}
    try:
        with Path(path).open("rb") as file:
            size = file.seek(0, 2)
            file.seek(max(0, size - MAX_TRANSCRIPT))
            if size > MAX_TRANSCRIPT:
                file.readline(MAX_INPUT)  # discard the partial first row
            data = file.read(MAX_TRANSCRIPT)
        rows: list[object] = []
        for line in data.splitlines():
            if len(line) > MAX_INPUT:
                return {}
            rows.append(json.loads(line))
        if size > MAX_TRANSCRIPT and not any(isinstance(row, dict) and (
                row.get("type") == "user" or row.get("type") == "event_msg" and
                isinstance(row.get("payload"), dict) and row["payload"].get("type") == "task_started") for row in rows):
            return {}
        remaining = pending(rows)
    except (OSError, ValueError):
        LOG.debug("Native plan unavailable; keeping native stop")
        return {}
    if not remaining:
        return {}
    plan = request(*to, {"engine": engine, "model": "unknown", "session_id": session, "event": "stop",
        "capabilities": ["completion_guard"], "off": off, "context_tokens": 0, "idle_s": 0, "pings": 0,
        "pending_steps": remaining, "stop_hook_active": False})
    instruction = plan.get("completion_instruction") if plan and plan.get("version") == 1 else None
    return {"decision": "block", "reason": instruction} if isinstance(instruction, str) and 0 < len(instruction) <= 4096 else {}


def hook_args(args: list[str], script: Path) -> list[str]:
    # A user-supplied session layer must not be replaced by our own layer.
    if any(re.match(r"hooks(?:\.Stop(?:\W|$)|\s*=)", arg) for arg in args):
        return args
    command = shlex.join([sys.executable, str(script.resolve()), "codex"])
    value = 'hooks.Stop=[{hooks=[{type="command",command=' + json.dumps(command) + ',timeout=4}]}]'
    return ["-c", value, *args]


def main(source: TextIO, output: TextIO, env: dict[str, str], engine: str) -> None:
    data = source.read(MAX_INPUT + 1)
    result: Json = {}
    if len(data) <= MAX_INPUT:
        try:
            value = json.loads(data)
            if isinstance(value, dict):
                result = decide(value, env, engine)
        except (ValueError, OSError):
            LOG.debug("Unsupported Stop event; keeping native stop")
    output.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    main(sys.stdin, sys.stdout, dict(os.environ), sys.argv[1] if len(sys.argv) > 1 else "claude")

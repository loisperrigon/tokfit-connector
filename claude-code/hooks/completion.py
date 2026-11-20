#!/usr/bin/env python3
"""Bounded native Stop adapter. Transcripts stay local and are never written.

Only native plan statuses leave this process. The service owns the decision
and continuation text; this adapter cannot grant permissions or change models.
"""
from __future__ import annotations

import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import shlex
import sys
from typing import Collection, Iterable, TextIO
from urllib.parse import urlsplit
import urllib.error
import urllib.request

Json = dict[str, object]
MAX_INPUT = 64 * 1024
MAX_TRANSCRIPT = 4 * 1024 * 1024
# Adresse officielle du service, posée par connector/publish.py dans la copie publique, comme DEFAULT_URL
# de hooks/service.ts ; vide dans la copie de travail (rien ne part sans adresse configurée). Sans elle, une
# clé configurée sans adresse (option api_key seule, ou config.json sans `url`) laissait le noyau sans outil.
DEFAULT_URL = "https://api.tokfit.fr"
LOG = logging.getLogger("tokfit.completion")
# Key issued by the service, as KEY of hooks/key.ts.
ANONYMOUS_KEY = re.compile(r"ek_[A-Za-z0-9_-]{20,200}")
# Networks a relay may be reached over plain http: loopback, RFC 1918, shared address space (RFC 6598), IPv6
# unique local addresses (RFC 4193).
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(network) for network in (
    "127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"))


# Tailscale names: `*.ts.net`, or a short MagicDNS name (one label starting with a letter, so never a numeric
# address such as 134744072 or 0x8080808).
TAILSCALE_NAME = re.compile(r"[a-z][a-z0-9-]*|([a-z0-9-]+\.)+ts\.net")


def private_host(host: str) -> bool:
    """True for localhost, a Tailscale name (TAILSCALE_NAME) or an IP literal in PRIVATE_NETWORKS; no other name."""
    if host.lower() == "localhost" or TAILSCALE_NAME.fullmatch(host.lower()):
        return True
    try:
        address = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    return any(address in network for network in PRIVATE_NETWORKS)


def relay_address(url: str) -> bool:
    """True if a relay may be called at `url`: https, or http toward a private host; never with credentials."""
    try:
        parsed = urlsplit(url)
        host, port = parsed.hostname, parsed.port
    except ValueError:  # malformed host or port
        return False
    if not host or port == 0 or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return False
    return parsed.scheme == "https" or (parsed.scheme == "http" and private_host(host))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Redirects are refused: the Authorization header never follows them to another address."""
    def redirect_request(self, req: urllib.request.Request, fp: object, code: int, msg: str,
                         headers: object, newurl: str) -> None:
        return None


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


def store_folder(env: dict[str, str]) -> Path:
    """Folder of the plugin stores (`$.store`) under Claude Code's configuration directory."""
    return Path(env.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude")) / "plugins" / "store"


def stored_key(env: dict[str, str], url: str, refused: Collection[str] = ()) -> str | None:
    """The anonymous key the connector keeps in its plugin store (hooks/key.ts) for the service at `url`, if any;
    as in key.ts, an entry kept for another address, or a malformed key, is never used."""
    for path in sorted(store_folder(env).glob("tokfit_*.json")):
        try:
            with path.open("rb") as file:
                entry = json.loads(file.read(MAX_INPUT)).get("anonymous_key")
        except (OSError, ValueError, AttributeError):
            # Unreadable store: another copy's file may still hold the key.
            continue
        if not isinstance(entry, dict) or not isinstance(entry.get("url"), str):
            continue
        key = entry.get("key")
        if entry["url"].rstrip("/") == url and isinstance(key, str) and ANONYMOUS_KEY.fullmatch(key) and key not in refused:
            return key
    return None


def link(env: dict[str, str], refused: Collection[str] = ()) -> tuple[str, str] | None:
    """(url, key): the host's relay, else the configured key (plugin option, then config file), else the anonymous
    key of the plugin store; a configured or anonymous key in `refused` (401 or 403 from the service) is skipped,
    as in hooks/service.ts. The relay token is never skipped: nothing replaces it."""
    url, key = env.get("ECONOMISEUR_RELAY_URL"), env.get("ECONOMISEUR_RELAY_TOKEN")  # publish: keep
    relay = bool(url and key and relay_address(url))
    if not relay:
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
        key = next((value for value in (env.get("CLAUDE_PLUGIN_OPTION_API_KEY"), config.get("key"))
                    if value and value not in refused), None)
    if not isinstance(url, str) or not url:
        url = DEFAULT_URL
    if not relay and not key and url:
        key = stored_key(env, url.rstrip("/"), refused)
    if not isinstance(url, str) or not isinstance(key, str) or not key or not relay_address(url):
        return None
    # Outside a relay, plain http only toward this machine.
    if not relay and urlsplit(url).scheme == "http" and urlsplit(url).hostname not in ("localhost", "127.0.0.1"):
        return None
    return url.rstrip("/"), key


class KeyRefused(Exception):
    """The service refused the key (401, 403)."""


def request(url: str, key: str, facts: Json) -> Json | None:
    try:
        req = urllib.request.Request(url + "/v1/optimizations", json.dumps(facts).encode(),
                                     {"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=2) as response:
            value = json.loads(response.read(MAX_INPUT))
        return value if isinstance(value, dict) else None
    except urllib.error.HTTPError as error:
        error.close()
        if error.code in (401, 403):
            raise KeyRefused() from error
        LOG.debug("Completion policy unavailable (%s); keeping native stop", error.code)
        return None
    except (OSError, ValueError):
        LOG.debug("Completion policy unavailable; keeping native stop")
        return None


def ask(env: dict[str, str], facts: Json, to: tuple[str, str] | None = None) -> Json | None:
    """The service's answer to `facts`; a refused key gives way to the next one (see `link`)."""
    refused: set[str] = set()
    to = to or link(env)
    while to is not None:
        try:
            return request(*to, facts)
        except KeyRefused:
            refused.add(to[1])
            following = link(env, refused)
            to = following if following != to else None
    LOG.debug("Every key refused; keeping native stop")
    return None


def levers_off(env: dict[str, str]) -> list[str]:
    """Levers turned off by the host app (its embedded copy's variable) and by the user."""
    host = env.get("ECONOMISEUR_OFF", "")  # publish: keep
    user = env.get("TOKFIT_OFF", "")
    return [word.strip() for word in f"{host},{user}".split(",") if word.strip()]


def decide(event: Json, env: dict[str, str], engine: str) -> Json:
    off = levers_off(env)
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
    plan = ask(env, {"engine": engine, "model": "unknown", "session_id": session, "event": "stop",
        "capabilities": ["completion_guard"], "off": off, "context_tokens": 0, "idle_s": 0, "pings": 0,
        "pending_steps": remaining, "stop_hook_active": False}, to)
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

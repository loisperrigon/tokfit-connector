#!/usr/bin/env python3
"""Local Responses transport. Requests/credentials live in bounded memory only.

This module contains transport mechanics, never optimization policy. The same
relay is usable by a terminal launcher, an ACP host or another CLI adapter.
"""
from __future__ import annotations

import copy
import hashlib
from dataclasses import dataclass
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import re
import secrets
import socket
import sys
import threading
import time
from typing import BinaryIO, Callable
from urllib.parse import urlsplit
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from runtime.output import OutputPolicy, shorten_request
from runtime.process import run_child
from runtime.completion import hook_args as completion_hook_args

Json = dict[str, object]
MAX_REQUEST = 16 * 1024 * 1024
# Capture de diagnostic (TOKFIT_CAPTURE_DIR) : réponse gardée au plus.
MAX_CAPTURE = 32 * 1024 * 1024
MAX_EVENT = 1024 * 1024
HOP = frozenset({"connection", "transfer-encoding", "content-length", "host", "keep-alive", "upgrade", "proxy-authorization"})
LOG = logging.getLogger("tokfit.runtime")


class BoundedServer(ThreadingHTTPServer):
    daemon_threads = True
    slots = threading.BoundedSemaphore(16)

    def process_request(self, request: socket.socket | tuple[bytes, socket.socket], client_address: tuple[str, int]) -> None:
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request: socket.socket | tuple[bytes, socket.socket], client_address: tuple[str, int]) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class ResponsesProtocol:
    def ping(self, original: Json, prewarm: bool = False) -> Json:
        items = original.get("input")
        if not isinstance(items, list) or original.get("previous_response_id"):
            raise ValueError("A complete request is required")
        body = copy.deepcopy(original)
        body["store"] = False
        if prewarm:
            options = body.get("prompt_cache_options", {})
            if not isinstance(options, dict):
                raise ValueError("Invalid cache options")
            body["prompt_cache_options"] = {**options, "prewarm": True}
        else:
            # Keep tools, effort, system and every input item, including opaque
            # reasoning. Never insert this reply into the real conversation.
            body["input"] = [*items, {"role": "user", "content": "Reply only ok. Do not use tools."}]
            body["tool_choice"] = "none"
        return body


@dataclass(repr=False)
class Snapshot:
    protocol: str
    url: str
    headers: dict[str, str]
    body: Json
    context_tokens: int

    def facts(self, session: str, idle: int, pings: int, ttl: int, off: tuple[str, ...] = ()) -> Json:
        return {"engine": "codex", "session_id": session, "model": self.body["model"], "event": "idle",
                "capabilities": ["prefix_replay"], "off": list(off), "context_tokens": self.context_tokens,
                "idle_s": idle, "pings": pings, "cache_ttl_s": ttl}


class Session:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.generation = 0
        self.snapshot: Snapshot | None = None
        self.stop = threading.Event()

    def begin(self) -> int:
        with self.lock:
            self.stop.set()
            self.stop = threading.Event()
            self.generation += 1
            self.snapshot = None
            return self.generation

    def current(self, generation: int) -> bool:
        with self.lock:
            return generation == self.generation and not self.stop.is_set()

    def rest(self, generation: int, snapshot: Snapshot) -> bool:
        with self.lock:
            if not self.current(generation):
                return False
            self.snapshot = snapshot
            return True


class Groups:
    """Bounded first-step synchronization, with no content retained."""
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.leaders: dict[str, threading.Event] = {}
        self.seen: dict[str, None] = {}

    def enter(self, prefix: str, thread: str, wait_ms: int) -> Callable[[], None]:
        with self.lock:
            if thread in self.seen or not 0 < wait_ms <= 3000:
                return lambda: None
            if len(self.seen) >= 512:
                del self.seen[next(iter(self.seen))]
            self.seen[thread] = None
            leader = self.leaders.get(prefix)
            if leader is None:
                if len(self.leaders) >= 64:
                    return lambda: None
                own = threading.Event()
                self.leaders[prefix] = own

                def release() -> None:
                    with self.lock:
                        own.set()
                        if self.leaders.get(prefix) is own:
                            del self.leaders[prefix]
                return release
        leader.wait(wait_ms / 1000)
        return lambda: None


def post(url: str, token: str, body: Json) -> Json | None:
    request = urllib.request.Request(url, json.dumps(body).encode(),
                                     {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            value = json.loads(response.read(MAX_EVENT))
            return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        LOG.debug("Policy request failed")
        return None


class Events:
    """Bounded SSE metadata observer; original bytes always reach the client."""
    def __init__(self) -> None:
        self.buffer = b""
        self.completed: Json | None = None
        self.disabled = False
        self.output_types: list[Json] = []

    def feed(self, chunk: bytes) -> None:
        if self.disabled:
            return
        self.buffer += chunk
        if len(self.buffer) > MAX_EVENT:
            self.buffer = b""
            self.disabled = True
            return
        while b"\n\n" in self.buffer or b"\r\n\r\n" in self.buffer:
            separator = b"\r\n\r\n" if b"\r\n\r\n" in self.buffer else b"\n\n"
            event, self.buffer = self.buffer.split(separator, 1)
            data = b"\n".join(line[5:].strip() for line in event.splitlines() if line.startswith(b"data:"))
            try:
                value = json.loads(data)
            except (ValueError, UnicodeError):
                continue
            if isinstance(value, dict):
                if value.get("type") == "response.output_item.done" and isinstance(value.get("item"), dict):
                    if len(self.output_types) < 1024:
                        self.output_types.append({"type": value["item"].get("type")})
                    else:
                        self.disabled = True
                if value.get("type") == "response.completed" and isinstance(value.get("response"), dict):
                    self.completed = value["response"]
                    if not self.completed.get("output") and self.output_types:
                        self.completed["output"] = self.output_types


def number(body: Json, key: str) -> int:
    value = body.get(key, 0)
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def usage(response: Json) -> Json:
    raw = response.get("usage", {})
    if not isinstance(raw, dict):
        return {}
    detail = raw.get("input_tokens_details", {})
    detail = detail if isinstance(detail, dict) else {}
    read, write = number(detail, "cached_tokens"), number(detail, "cache_write_tokens")
    return {"input": max(0, number(raw, "input_tokens") - read - write), "cache_read": read,
            "cache_write": write, "output": number(raw, "output_tokens")}


def thinking(body: Json, instruction: str) -> bool:
    """Extend a native system prefix without rewriting user/tool messages."""
    prefix = body.get("instructions")
    if isinstance(prefix, str):
        body["instructions"] = prefix + "\n\n" + instruction
        return True
    items = body.get("input")
    if not isinstance(items, list):
        return False
    has_system = False
    for item in items:
        if not isinstance(item, dict) or item.get("role") not in ("developer", "system"):
            continue
        has_system = True
        content = item.get("content")
        if isinstance(content, str):
            item["content"] += "\n\n" + instruction
            return True
        if isinstance(content, list) and all(isinstance(part, dict) and part.get("type") == "input_text"
                                             and isinstance(part.get("text"), str) for part in content):
            content.append({"type": "input_text", "text": instruction})
            return True
        # Opaque system items stay untouched; later native text may be usable.
    if has_system:
        return False
    items.insert(0, {"role": "developer", "content": [{"type": "input_text", "text": instruction}]})
    return True


class Capture:
    """Diagnostic opt-in : corps exact envoyé et flux brut reçu, par requête.

    Seulement si l'utilisateur fournit un dossier absolu. Ni en-têtes ni
    jeton : le corps seul, tel que le relais l'envoie après ses leviers.
    Fichiers privés (0600) ; toute erreur d'écriture coupe la capture sans
    jamais toucher au trafic.
    """

    def __init__(self, root: Path, session: str) -> None:
        self.root = root
        self.prefix = time.strftime("%Y%m%d-%H%M%S") + "-" + session[:8]
        self.lock = threading.Lock()
        self.count = 0
        root.mkdir(mode=0o700, parents=True, exist_ok=True)

    def _open(self, name: str) -> BinaryIO:
        fd = os.open(self.root / name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        return os.fdopen(fd, "wb")

    def begin(self, body: bytes, main: bool) -> "CaptureEntry | None":
        try:
            with self.lock:
                self.count += 1
                name = "%s-%04d" % (self.prefix, self.count)
            with self._open(name + ".request.json") as out:
                out.write(body)
            return CaptureEntry(self, name, main, self._open(name + ".response.sse"))
        except OSError:
            LOG.warning("Diagnostic capture unavailable")
            return None

    def index(self, line: Json) -> None:
        try:
            with self.lock:
                fd = os.open(self.root / (self.prefix + ".index.jsonl"), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                with os.fdopen(fd, "a") as out:
                    out.write(json.dumps(line) + "\n")
        except OSError:
            LOG.warning("Diagnostic capture unavailable")


class CaptureEntry:
    def __init__(self, capture: Capture, name: str, main: bool, out: BinaryIO) -> None:
        self.capture, self.name, self.main = capture, name, main
        self.out: BinaryIO | None = out
        self.size = 0
        self.status = 0
        self.started = time.time()

    def feed(self, chunk: bytes) -> None:
        if self.out is None or self.size >= MAX_CAPTURE:
            return
        try:
            kept = chunk[:MAX_CAPTURE - self.size]
            self.out.write(kept)
            self.size += len(kept)
        except OSError:
            self.close()

    def close(self) -> None:
        if self.out is None:
            return
        try:
            self.out.close()
        except OSError:
            pass
        self.out = None
        self.capture.index({"name": self.name, "main": self.main, "status": self.status, "bytes": self.size,
                            "truncated": self.size >= MAX_CAPTURE, "seconds": round(time.time() - self.started, 3)})


class Relay:
    def __init__(self, upstream: str, policy: Callable[[Json], Json | None], counted: Callable[[Json], object],
                 session_id: str, off: tuple[str, ...] = (), ttl: int = 1800, prewarm: bool = False,
                 capture: Path | None = None) -> None:
        self.upstream = upstream.rstrip("/")
        parsed = urlsplit(self.upstream)
        if upstream != "auto" and (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password):
            raise ValueError("Invalid upstream")
        self.policy, self.counted, self.session_id, self.off = policy, counted, session_id, off
        self.ttl, self.prewarm = ttl, prewarm
        self.session = Session()
        self.main_key: object = None
        self.ping_lock = threading.Lock()
        self.plan_lock = threading.Lock()
        self.plan_loaded = False
        self.instruction: str | None = None
        self.execution_instruction: str | None = None
        self.output_policy: OutputPolicy | None = None
        self.fanout_ms = 0
        self.groups = Groups()
        self.token = secrets.token_urlsafe(32)
        self.protocol = ResponsesProtocol()
        self.capture: Capture | None = None
        if capture is not None:
            try:
                self.capture = Capture(capture, session_id)
            except OSError:
                LOG.warning("Diagnostic capture unavailable")
        self.server = BoundedServer(("127.0.0.1", 0), self.handler())
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d/%s" % (self.server.server_port, self.token)

    def close(self) -> None:
        self.session.begin()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def upstream_for(self, headers: dict[str, str]) -> str:
        if self.upstream != "auto":
            return self.upstream
        normalized = {k.lower(): v for k, v in headers.items()}
        oauth = "chatgpt-account-id" in normalized or normalized.get("authorization", "").startswith("Bearer eyJ")
        return "https://chatgpt.com/backend-api/codex" if oauth else "https://api.openai.com/v1"

    def connection(self, upstream: str, timeout: int = 300) -> http.client.HTTPConnection:
        parsed = urlsplit(upstream)
        cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        return cls(parsed.hostname or "", parsed.port, timeout=timeout)

    def prepare(self, data: bytes) -> bytes:
        try:
            body = json.loads(data)
            if not isinstance(body, dict) or not isinstance(body.get("model"), str):
                return data
            with self.plan_lock:
                if not self.plan_loaded:
                    plan = self.policy({"engine": "codex", "session_id": self.session_id, "model": body["model"],
                                        "event": "launch", "capabilities": ["prefix_replay", "thinking_instruction",
                                        "tool_output", "grouped_subagents", "execution_instruction"], "off": list(self.off),
                                        "context_tokens": 0, "idle_s": 0, "pings": 0})
                    self.plan_loaded = True
                    if plan:
                        instruction = plan.get("thinking_instruction")
                        if "thinking" not in self.off and isinstance(instruction, str) and 0 < len(instruction) <= 4096:
                            self.instruction = instruction
                        execution = plan.get("execution_instruction")
                        if "persistence" not in self.off and isinstance(execution, str) and 0 < len(execution) <= 4096:
                            self.execution_instruction = execution
                        rules = plan.get("output_policy")
                        if "output" not in self.off and isinstance(rules, dict):
                            self.output_policy = OutputPolicy(rules)
                        wait = plan.get("fanout_wait_ms")
                        if "fanout" not in self.off and isinstance(wait, int) and not isinstance(wait, bool) and 0 < wait <= 3000:
                            self.fanout_ms = wait
            changed = False
            instructions = [value for value in (self.instruction, self.execution_instruction) if value]
            if instructions:
                changed = thinking(body, "\n\n".join(instructions))
            if self.output_policy:
                short = shorten_request(body, self.output_policy)
                changed |= short is not body
                body = short
            return json.dumps(body).encode() if changed else data
        except (ValueError, TypeError, KeyError):
            LOG.warning("Optimization plan or request format not supported")
            return data

    def grouped(self, data: bytes, headers: dict[str, str]) -> Callable[[], None]:
        if not self.fanout_ms:
            return lambda: None
        try:
            body = json.loads(data)
            key, items = body.get("prompt_cache_key"), body.get("input")
            if not isinstance(key, str) or key == self.main_key or body.get("previous_response_id") or not isinstance(items, list):
                return lambda: None
            # Forks and resumed agents already have an assistant/tool history.
            if any(not isinstance(i, dict) or i.get("role") not in ("user", "system", "developer") for i in items):
                return lambda: None
            common = {name: body.get(name) for name in ("model", "instructions", "tools", "reasoning")}
            common["system_input"] = [item for item in items if item.get("role") in ("system", "developer")]
            common["identity"] = {k.lower(): v for k, v in headers.items() if k.lower() in ("authorization", "chatgpt-account-id")}
            prefix = hashlib.sha256(json.dumps(common, sort_keys=True).encode()).hexdigest()
            return self.groups.enter(prefix, key, self.fanout_ms)
        except (ValueError, TypeError, AttributeError):
            return lambda: None

    def handler(self) -> type[BaseHTTPRequestHandler]:
        relay = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: object) -> None:
                pass  # HTTP paths and messages may contain secrets.

            def do_GET(self) -> None:
                self.forward()

            def do_POST(self) -> None:
                self.forward()

            def forward(self) -> None:
                self.close_connection = True
                prefix = "/" + relay.token + "/"
                if not self.path.startswith(prefix):
                    self.send_error(403)
                    return
                target = "/" + self.path[len(prefix):]
                if target.split("?", 1)[0] not in ("/responses", "/models", "/responses/compact"):
                    self.send_error(404)
                    return
                # Native Codex falls back to full HTTP requests after 426.
                # We never capture or replay incremental WebSocket frames.
                if self.headers.get("Upgrade", "").lower() == "websocket":
                    self.send_error(426)
                    return
                if self.headers.get("Transfer-Encoding"):
                    self.send_error(411)
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    self.send_error(400)
                    return
                if length < 0:
                    self.send_error(400)
                    return
                self.connection.settimeout(60)
                oversized = length > MAX_REQUEST
                data = b"" if oversized else self.rfile.read(length)
                if not oversized and len(data) != length:
                    return
                real_request = self.command == "POST" and target.split("?", 1)[0] == "/responses"
                if oversized and real_request:
                    relay.session.begin()
                    real_request = False
                is_response = real_request
                if real_request:
                    try:
                        request_body = json.loads(data)
                        key = request_body.get("prompt_cache_key") if isinstance(request_body, dict) else None
                        with relay.session.lock:
                            if relay.main_key is None and key is not None:
                                relay.main_key = key
                                if isinstance(key, str):
                                    try:
                                        relay.session_id = str(uuid.UUID(key))
                                    except ValueError:
                                        pass  # A custom cache key is not a public session id.
                            is_response = key == relay.main_key
                    except (ValueError, UnicodeError):
                        is_response = False
                generation = relay.session.begin() if is_response else -1
                headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
                headers["Accept-Encoding"] = "identity"
                if real_request:
                    data = relay.prepare(data)
                release = relay.grouped(data, headers) if real_request else lambda: None
                captured = relay.capture.begin(data, is_response) if relay.capture and real_request else None
                destination = relay.upstream_for(headers)
                parsed = urlsplit(destination)
                path = parsed.path.rstrip("/") + target
                upstream = relay.connection(destination)
                events = Events()
                try:
                    if oversized:
                        # Large screenshots/documents keep working: bound only
                        # the observer, stream the original request unchanged.
                        upstream.putrequest(self.command, path)
                        for name, value in headers.items():
                            upstream.putheader(name, value)
                        upstream.putheader("Content-Length", str(length))
                        upstream.endheaders()
                        remaining = length
                        while remaining:
                            chunk = self.rfile.read(min(16384, remaining))
                            if not chunk:
                                raise ConnectionError("Incomplete request")
                            upstream.send(chunk)
                            remaining -= len(chunk)
                    else:
                        upstream.request(self.command, path, data if length else None, headers)
                    response = upstream.getresponse()
                    if captured:
                        captured.status = response.status
                    self.send_response(response.status)
                    for key, value in response.getheaders():
                        if key.lower() not in HOP:
                            self.send_header(key, value)
                    self.send_header("Connection", "close")
                    self.end_headers()
                    while True:
                        chunk = response.read1(16384)
                        if not chunk:
                            break
                        if captured:
                            captured.feed(chunk)
                        self.wfile.write(chunk)
                        self.wfile.flush()
                        if is_response and response.status == 200:
                            events.feed(chunk)
                    if is_response and response.status == 200 and events.completed:
                        relay.rest(generation, data, headers, events.completed)
                except (OSError, http.client.HTTPException):
                    LOG.warning("Upstream transport interrupted")
                finally:
                    if captured:
                        captured.close()
                    release()
                    upstream.close()

        return Handler

    def rest(self, generation: int, data: bytes, headers: dict[str, str], response: Json) -> None:
        try:
            body = json.loads(data)
            self.protocol.ping(body, self.prewarm)
        except (ValueError, TypeError, KeyError):
            return
        output = response.get("output")
        # Missing/unknown output or pending calls are never an idle user turn.
        if not isinstance(output, list) or not output or any(
                not isinstance(item, dict) or item.get("type") not in ("message", "reasoning") for item in output):
            return
        raw = response.get("usage", {})
        context = number(raw, "input_tokens") if isinstance(raw, dict) else 0
        snapshot = Snapshot("responses", self.upstream_for(headers) + "/responses", headers, body, context)
        if "warm" not in self.off and self.session.rest(generation, snapshot):
            threading.Thread(target=self.warm, args=(generation, snapshot, self.session.stop), daemon=True).start()

    def warm(self, generation: int, snapshot: Snapshot, stop: threading.Event) -> None:
        try:
            self._warm(generation, snapshot, stop)
        finally:
            with self.session.lock:
                if self.session.current(generation):
                    self.session.begin()

    def _warm(self, generation: int, snapshot: Snapshot, stop: threading.Event) -> None:
        rested, refreshed, pings = time.time(), time.time(), 0
        while self.session.current(generation):
            if pings >= 1000 or time.time() - rested > 86400:
                return
            plan = self.policy(snapshot.facts(self.session_id, max(0, int(time.time() - rested)), pings, self.ttl, self.off))
            after = plan.get("warm_after_s") if plan else None
            if not isinstance(after, int) or isinstance(after, bool) or after < 0 or after > self.ttl:
                with self.session.lock:
                    if self.session.current(generation):
                        self.session.begin()
                return
            if stop.wait(after) or not self.session.current(generation):
                return
            # No catch-up after sleep/suspension: an expired prefix costs a write.
            if not 0 <= time.time() - refreshed < self.ttl - 10:
                return
            events, connection = Events(), self.connection(snapshot.url, timeout=60)
            if not self.ping_lock.acquire(blocking=False):
                return
            try:
                if not self.session.current(generation):
                    return
                payload = json.dumps(self.protocol.ping(snapshot.body, self.prewarm)).encode()
                path = urlsplit(snapshot.url).path
                headers = {k: v for k, v in snapshot.headers.items() if k.lower() not in HOP}
                headers["Content-Type"] = "application/json"
                connection.request("POST", path, payload, headers)
                response = connection.getresponse()
                if response.status != 200:
                    LOG.warning("Cache refresh refused (HTTP %d)", response.status)
                    if self.session.current(generation):
                        self.session.begin()
                    return
                while True:
                    chunk = response.read1(16384)
                    if not chunk:
                        break
                    events.feed(chunk)
                if not events.completed:
                    return
                # Count even if real work returned during the network request.
                self.counted({"session_id": self.session_id, "step_id": "warm-%s-%d-%d" %
                              (self.session_id, generation, pings), "model": snapshot.body["model"],
                              "subagent": False, "ping": True, **usage(events.completed)})
                pings += 1
                refreshed = time.time()
            except (OSError, ValueError, http.client.HTTPException):
                LOG.warning("Cache refresh interrupted")
                return
            finally:
                connection.close()
                self.ping_lock.release()


def configured(args: list[str], env: dict[str, str]) -> str | None:
    """Preserve custom providers/profiles. Only wrap a known built-in route.

    Python 3.9 has no TOML parser: conservative detection deliberately declines
    ambiguous configurations instead of redirecting another provider's token.
    """
    if any(env.get(name) for name in ("OPENAI_BASE_URL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                                      "http_proxy", "https_proxy", "all_proxy")):
        return None
    home = Path(env.get("CODEX_HOME") or str(Path.home() / ".codex"))
    try:
        config = (home / "config.toml").read_text(encoding="utf-8")
    except FileNotFoundError:
        config = ""
    except OSError:
        LOG.warning("Cannot inspect provider configuration")
        return None
    if any(arg in ("-p", "--profile", "--oss", "--local-provider") or arg.startswith("--profile=") for arg in args):
        return None
    if re.search(r"^\s*(profile|openai_base_url|chatgpt_base_url|model_provider)\s*=", config, re.MULTILINE):
        return None
    for index, arg in enumerate(args):
        value = args[index + 1] if arg in ("-c", "--config") and index + 1 < len(args) else arg
        if any(word in value for word in ("model_provider=", "model_provider =", "openai_base_url", "chatgpt_base_url")):
            return None
    return env.get("TOKFIT_UPSTREAM", "auto")


def run(binary: str, args: list[str], env: dict[str, str]) -> int:
    """Supervise the CLI and its in-memory relay in one process lifetime."""
    policy_url, token = env.get("TOKFIT_RELAY_URL", ""), env.get("TOKFIT_RELAY_TOKEN", "")
    upstream = configured(args, env) if policy_url and token else None
    relay: Relay | None = None
    if upstream:
        session = str(uuid.uuid4())
        off = tuple(filter(None, env.get("TOKFIT_OFF", "").split(",")))
        capture_dir = env.get("TOKFIT_CAPTURE_DIR", "")
        capture = Path(capture_dir) if capture_dir and Path(capture_dir).is_absolute() else None
        plan = post(policy_url.rstrip("/") + "/v1/optimizations", token,
                    {"engine": "codex", "session_id": session, "model": "unknown", "event": "launch",
                     "capabilities": ["prefix_replay", "thinking_instruction", "tool_output", "grouped_subagents", "execution_instruction"],
                     "off": list(off), "context_tokens": 0, "idle_s": 0, "pings": 0})
        try:
            if plan and plan.get("version") == 1:
                relay = Relay(upstream,
                              lambda facts: post(policy_url.rstrip("/") + "/v1/optimizations", token, facts),
                              lambda step: post(policy_url.rstrip("/") + "/v1/usage", token, {"steps": [step]}),
                              session, off, capture=capture)
        except (OSError, ValueError):
            LOG.warning("Local optimization transport unavailable")
    actual = ["-c", "openai_base_url=" + json.dumps(relay.url), *args] if relay else args
    if relay and plan and "execution_instruction" in plan and "persistence" not in off:
        actual = completion_hook_args(actual, Path(__file__).with_name("completion.py"))
    try:
        return run_child(binary, actual, env)
    finally:
        if relay:
            relay.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(2)
    sys.exit(run(sys.argv[1], sys.argv[2:], dict(os.environ)))

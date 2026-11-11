#!/usr/bin/env python3
"""Apply supported tokfit policy through a native Cursor rules plugin.

Cursor's shell output and compaction hooks are observational. Never advertise
replacement, a warm prefix replay or automatic model routing for this adapter.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from runtime.relay import post
from runtime.process import run_child

LOG = logging.getLogger(__name__)


def write_file(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        if path.read_text(encoding="utf-8") == text:
            return
    except FileNotFoundError:
        pass
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
            temporary = Path(file.name)
            file.write(text)
        os.replace(temporary, path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def plugin(instruction: str, env: dict[str, str]) -> Path:
    # Stable content and path across resumes; no session text, paths or tokens
    # are stored. A changed policy gets its own immutable plugin directory.
    cache = Path(env.get("XDG_CACHE_HOME") or env.get("LOCALAPPDATA") or str(Path.home() / ".cache"))
    root = cache / "tokfit" / "cursor" / hashlib.sha256(instruction.encode()).hexdigest()[:24]
    write_file(root / ".cursor-plugin/plugin.json", json.dumps({"name": "tokfit", "version": "1.0.0", "description": "Shared token optimization policy"}) + "\n")
    write_file(root / "rules/thinking.mdc", "---\ndescription: Token optimization policy\nalwaysApply: true\n---\n\n" + instruction + "\n")
    return root


def run(binary: str, args: list[str], env: dict[str, str]) -> int:
    actual = args
    url, token = env.get("TOKFIT_RELAY_URL"), env.get("TOKFIT_RELAY_TOKEN")
    off = list(filter(None, env.get("TOKFIT_OFF", "").split(",")))
    if url and token and "thinking" not in off:
        plan = post(url.rstrip("/") + "/v1/optimizations", token, {
            "engine": "cursor", "model": "unknown", "session_id": env.get("OPEN_CODEX_PANE") or str(uuid.uuid4()),
            "event": "launch", "capabilities": ["thinking_instruction"], "off": off,
        })
        instruction = plan.get("thinking_instruction") if plan and plan.get("version") == 1 else None
        levers = plan.get("levers") if plan else None
        thinking = levers.get("thinking") if isinstance(levers, dict) else None
        if isinstance(thinking, dict) and thinking.get("state") == "enabled" and isinstance(instruction, str) and 0 < len(instruction) <= 8192:
            try:
                actual = ["--plugin-dir", str(plugin(instruction, env)), *args]
            except (OSError, ValueError):
                LOG.warning("Cursor policy plugin unavailable; keeping native configuration")
    return run_child(binary, actual, env)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(2)
    sys.exit(run(sys.argv[1], sys.argv[2:], dict(os.environ)))

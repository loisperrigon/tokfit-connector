"""Antigravity's pre-execution decision for tools replaced by the kernel."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import re
import runpy
import shlex
import sys
from typing import Callable, Mapping, TextIO, cast

MCP_DISPATCH = frozenset({"call_mcp_tool", "search_tools"})
MCP_TOOL = re.compile(r"mcp_[\w-]+_[\w-]+", re.ASCII)
DENIAL = "Tokfit: use the MCP tool outils/agir for local actions."
READY_FILE = "TOKFIT_ANTIGRAVITY_READY_FILE"
LOG = logging.getLogger(__name__)


def hook(source: TextIO, available: Callable[[], bool]) -> dict[str, str]:
    try:
        event = json.loads(source.read(1024 * 1024))
    except (ValueError, RecursionError):
        event = None
    call = event.get("toolCall") if isinstance(event, dict) else None
    name = call.get("name") if isinstance(call, dict) else None
    if not isinstance(name, str) or name in MCP_DISPATCH or MCP_TOOL.fullmatch(name):
        return {"decision": "allow"}
    if available():
        return {"decision": "deny", "reason": DENIAL}
    return {"decision": "allow"}


def overlay(original: Path, profile: Path) -> None:
    """Add a process-local hook while sharing the user's login and configuration."""
    config = profile / "config"
    config.mkdir()
    source = original / "config"
    for directory, target, excluded in ((original, profile, "config"), (source, config, "hooks.json")):
        if directory.is_dir():
            for path in directory.iterdir():
                if path.name != excluded:
                    (target / path.name).symlink_to(path, target_is_directory=path.is_dir())
    hooks = source / "hooks.json"
    groups = json.loads(hooks.read_text(encoding="utf-8")) if hooks.exists() else {}
    group = "tokfit-alfie-native-tools"
    if not isinstance(groups, dict) or group in groups:
        raise ValueError("Cannot add the Antigravity hook to this configuration")
    command = shlex.join([sys.executable, "-I", str(Path(__file__).resolve())])
    groups[group] = {"PreToolUse": [{"matcher": "*", "hooks": [
        {"type": "command", "command": command, "timeout": 2},
    ]}]}
    (config / "hooks.json").write_text(json.dumps(groups), encoding="utf-8")


def kernel_process_ready(env: Mapping[str, str]) -> bool:
    filename = env.get(READY_FILE)
    if not filename or os.name == "nt":
        return False
    try:
        pid = int(Path(filename).read_text(encoding="ascii"))
        if pid <= 0:
            return False
        os.kill(pid, 0)
    except (OSError, ValueError, OverflowError):
        return False
    return True


def hosted_kernel_available(env: Mapping[str, str]) -> bool:
    gate, bridge, pane = (env.get(key) for key in ("OC_ANTIGRAVITY_TOOL_GATE", "OPEN_CODEX_BRIDGE", "OPEN_CODEX_PANE"))
    if not (gate and bridge and pane and kernel_process_ready(env)):
        return False
    try:
        allowed = cast(Callable[[str, str, str], bool], runpy.run_path(gate)["allowed"])
        return allowed(bridge, pane, "AntigravityToolAccess")
    except (OSError, KeyError, ImportError):
        LOG.debug("Antigravity host permission check unavailable")
        return False


if __name__ == "__main__":
    print(json.dumps(hook(sys.stdin, lambda: hosted_kernel_available(os.environ))))

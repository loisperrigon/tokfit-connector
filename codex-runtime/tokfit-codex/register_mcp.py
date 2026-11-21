"""Register the optional tokfit MCP with Codex's own config writer (Python 3.9+)."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
from threading import Timer
from typing import Any, Callable, Collection, Dict, Iterator, Optional


def profile_server_names(home: Path) -> set[str]:
    """Ask the installed CLI to resolve each profile, including disabled and inherited entries."""
    names: set[str] = set()
    for path in sorted(home.glob("*.config.toml")):
        profile = path.name[:-len(".config.toml")]
        result = subprocess.run(["codex", "--profile=" + profile, "mcp", "list", "--json"], cwd=home,
                                capture_output=True, text=True, timeout=15)
        if result.returncode:
            raise ValueError(f"Codex ne peut pas lire le profil {profile}")
        rows = json.loads(result.stdout)
        names.update(row["name"] for row in rows)
    return names


def server_name(layers: list[Dict[str, Any]], launcher: Path, alfie_mods: Path,
                profile_names: Collection[str] = ()) -> str:
    """Keep existing global settings. A new global name must be free in all profiles too."""
    names = set(profile_names)
    hosted = {str(alfie_mods / name / "kernel" / "server.py") for name in ("tokfit", "economiseur")}  # publish: keep
    for layer in layers:
        config = layer["config"]
        for profile in config.get("profiles", {}).values():
            names.update(profile.get("mcp_servers", {}))
        for name, entry in config.get("mcp_servers", {}).items():
            names.add(name)
            source = layer.get("name", {})
            if source.get("profile") or source.get("type") == "project":
                continue
            args = entry.get("args", [])
            if entry.get("command") == str(launcher) and args == ["_mcp"]:
                return ""
            if args and args[-1] in hosted and Path(entry.get("command", "")).name.startswith("python"):
                return ""
    name = "tokfit-outils"
    index = 1
    while name in names:
        index += 1
        name = f"tokfit-outils-{index}"
    return name

Rpc = Callable[[int, str, Dict[str, Any]], Dict[str, Any]]


@contextmanager
def app_server(*, env: Optional[Dict[str, str]] = None, cwd: Optional[Path] = None,
               experimental: bool = False, timeout: int = 15) -> Iterator[Rpc]:
    # The child reads the user's config. Never echo its stdout or stderr: either can contain tokens.
    with subprocess.Popen(["codex", "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True, encoding="utf-8", env=env, cwd=cwd) as child:
        timer = Timer(timeout, child.kill)
        timer.start()
        try:
            assert child.stdin is not None and child.stdout is not None
            def send(message: Dict[str, Any]) -> None:
                assert child.stdin is not None
                child.stdin.write(json.dumps(message) + "\n")
                child.stdin.flush()

            def call(ident: int, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
                send({"id": ident, "method": method, "params": params})
                assert child.stdout is not None
                for line in child.stdout:
                    event = json.loads(line)
                    if event.get("method") and "id" in event:
                        raise ValueError("Codex attend une réponse interactive à " + str(event["method"]))
                    if event.get("id") == ident:
                        reply = event.get("result")
                        if not isinstance(reply, dict):
                            raise ValueError("Codex a refusé " + method)
                        return reply
                raise ValueError("Codex a fermé la connexion")

            call(1, "initialize", {"clientInfo": {"name": "tokfit-installer", "version": "1"},
                                   "capabilities": {"experimentalApi": experimental}})
            send({"method": "initialized"})
            yield call
        finally:
            timer.cancel()
            child.terminate()


def register(launcher: Path) -> str:
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    profile_names = profile_server_names(home)
    with app_server() as call:
        current = call(2, "config/read", {"includeLayers": True})
        layers = current["layers"]
        user = next(layer for layer in layers if layer["name"]["type"] == "user"
                    and not layer["name"].get("profile"))
        data_home = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
        name = server_name(layers, launcher, data_home / "open-codex" / "mods", profile_names)
        if not name:
            return "Configuration Codex existante conservée."
        names = ["CODEX_HOME", "ECONOMISEUR_RELAY_URL", "ECONOMISEUR_RELAY_TOKEN"]  # publish: keep
        config_name = "TOKFIT_CONFIG"
        value = {"command": str(launcher), "args": ["_mcp"], "env_vars": names,
                 "tools": {"agir": {"approval_mode": "prompt"}}}
        if os.environ.get(config_name):
            value["env"] = {config_name: str(Path(os.environ[config_name]).resolve())}
        result = call(3, "config/value/write", {"keyPath": "mcp_servers." + name, "value": value,
                      "mergeStrategy": "upsert", "expectedVersion": user["version"]})
        if result.get("status") != "ok":
            raise ValueError("Codex a signalé un autre réglage prioritaire")
        return f"Le serveur MCP {name} est disponible dans les nouvelles sessions Codex."


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: register_mcp.py <lanceur tokfit>")
    try:
        print(register(Path(sys.argv[1]).resolve()))
    except (OSError, ValueError, StopIteration, TypeError, KeyError, subprocess.TimeoutExpired) as error:
        sys.exit(f"tokfit : configuration MCP Codex impossible ({error}).")

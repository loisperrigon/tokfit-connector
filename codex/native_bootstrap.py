#!/usr/bin/env python3
"""Sélection locale du runtime fourni par la marketplace de Codex (POSIX)."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
REQUIRED = {"launcher.py", "tokfit-codex/kernel/server.py", "tokfit-codex/register_mcp.py"}


def snapshot(state: Path, package: Path) -> Path:
    manifest = (package / "release.json").read_bytes()
    doc = json.loads(manifest)
    files = doc.get("files") if isinstance(doc, dict) else None
    if not isinstance(files, dict) or not REQUIRED.issubset(files) or doc["version"] != package.name:
        raise ValueError("manifeste incompatible")
    releases = state / "releases"
    releases.mkdir(exist_ok=True)
    target = releases / hashlib.sha256(manifest).hexdigest()
    if target.is_dir():
        return target
    with tempfile.TemporaryDirectory(dir=state) as tmp:
        work = Path(tmp) / "package"
        for name, digest in files.items():
            path = Path(name)
            source = package / path
            if (path.is_absolute() or ".." in path.parts or path.as_posix() != name
                    or path.suffix != ".py" or source.resolve() != source):
                raise ValueError("chemin invalide dans le manifeste")
            data = source.read_bytes()
            if hashlib.sha256(data).hexdigest() != digest:
                raise ValueError(f"empreinte invalide pour {name}")
            compile(data, name, "exec")
            dest = work / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        (work / "release.json").write_bytes(manifest)
        work.rename(target)
    return target


def refresh_executor(home: Path, previous: Path, target: Path) -> None:
    """Met à jour seulement une définition livrée par tokfit et laissée intacte."""
    agent = home / "agents/tokfit-executor.toml"
    if not agent.is_file() or agent.is_symlink():
        return
    command = [sys.executable, "-I"]
    before = subprocess.check_output([*command, str(previous / "launcher.py"), "_agent-default"])
    after = subprocess.check_output([*command, str(target / "launcher.py"), "_agent-default"])
    if before == after or agent.read_bytes() != before:
        return
    with tempfile.TemporaryDirectory(dir=agent.parent) as tmp:
        staged = Path(tmp) / "executor"
        staged.write_bytes(after)
        staged.chmod(stat.S_IMODE(agent.stat().st_mode))
        if agent.read_bytes() == before:
            os.replace(staged, agent)


def activate(state: Path, cache: Path | None = None) -> Path:
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = state / "current"
        previous = current.resolve()
        source = state / "source"
        binding = cache is not None
        if cache is None:
            cache = Path(source.read_text())
        try:
            versions = [(tuple(map(int, match.groups())), p) for p in cache.iterdir()
                        if (match := VERSION.fullmatch(p.name)) and p.is_dir() and not p.is_symlink()]
            if previous.parent == state / "releases" and previous.is_dir() and not binding:
                prior_version = json.loads((previous / "release.json").read_bytes())["version"]
                if versions and max(versions)[0] < tuple(map(int, prior_version.split("."))):
                    return previous
            if not versions:
                raise ValueError("aucune version en cache")
            target = snapshot(state, max(versions)[1])
            if current.is_symlink() and previous == target and source.exists() and source.read_text() == str(cache):
                return target
            if previous.parent == state / "releases" and previous.is_dir():
                refresh_executor(cache.parents[3], previous, target)
            with tempfile.TemporaryDirectory(dir=state) as tmp:
                pending = Path(tmp) / "source"
                pending.write_text(str(cache))
                os.replace(pending, source)
                pending = Path(tmp) / "current"
                pending.symlink_to(target)
                os.replace(pending, current)
            return target
        except (OSError, ValueError, KeyError, SyntaxError, subprocess.CalledProcessError) as exc:
            if not binding and previous.parent == state / "releases" and previous.is_dir():
                print(f"tokfit : dernière version locale utilisée ({exc}).", file=sys.stderr)
                return previous
            raise


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).resolve()


def state_path(bin_dir: Path, home: Path) -> Path:
    # Plusieurs CODEX_HOME peuvent partager le même exécutable.
    return bin_dir / ".tokfit-codex-managed" / hashlib.sha256(os.fsencode(home)).hexdigest()


def install(bin_dir: Path, repo: str) -> None:
    existing = json.loads(subprocess.check_output(["codex", "plugin", "marketplace", "list", "--json"]))
    market = next((m for m in existing["marketplaces"] if m["name"] == "tokfit-distribution"), None)
    if market is None:
        subprocess.run(["codex", "plugin", "marketplace", "add", repo, "--ref", "main", "--json"],
                       check=True, stdout=subprocess.DEVNULL)
    elif market.get("marketplaceSource", {}).get("source") != repo:
        raise ValueError("le nom de marketplace tokfit-distribution est déjà utilisé par une autre source")
    else:
        plugins = json.loads(subprocess.check_output(["codex", "plugin", "list", "-m", "tokfit-distribution", "--json"]))
        if any(p["name"] == "tokfit-runtime" and not p["enabled"] for p in plugins["installed"]):
            raise ValueError("plugin désactivé dans Codex ; réglage conservé")
    result = subprocess.check_output(["codex", "plugin", "add", "tokfit-runtime@tokfit-distribution", "--json"])
    installed = Path(json.loads(result)["installedPath"])
    home = codex_home()
    cache = home / "plugins/cache/tokfit-distribution/tokfit-runtime"
    if installed.parent != cache or not VERSION.fullmatch(installed.name):
        raise ValueError("emplacement inattendu du plugin Codex")
    state = state_path(bin_dir, home)
    release = activate(state, cache)
    try:
        (state.parent / "default").symlink_to(state.name)
    except FileExistsError:
        pass
    shim = bin_dir / "tokfit"
    with tempfile.TemporaryDirectory(dir=bin_dir) as tmp:
        pending = Path(tmp) / "tokfit"
        pending.write_bytes(Path(__file__).read_bytes())
        pending.chmod(0o755)
        os.replace(pending, shim)
    subprocess.run([sys.executable, "-I", str(release / "tokfit-codex/register_mcp.py"), str(shim)], check=True)
    if not (home / "agents/tokfit-executor.toml").exists():
        subprocess.run([str(shim), "_agent"], check=True)


def main() -> None:
    if len(sys.argv) == 4 and sys.argv[1] == "--install":
        install(Path(sys.argv[2]).resolve(), sys.argv[3])
        return
    state = state_path(Path(__file__).resolve().parent, codex_home())
    # Un MCP déjà enregistré par une version antérieure peut filtrer CODEX_HOME.
    if not state.exists():
        state = (state.parent / "default").resolve(strict=True)
    release = activate(state)
    os.execv(sys.executable, [sys.executable, "-I", str(release / "launcher.py"), *sys.argv[1:]])


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, SyntaxError, subprocess.CalledProcessError) as error:
        sys.exit(f"tokfit : {error}")

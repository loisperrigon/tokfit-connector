#!/usr/bin/env python3
"""Lanceur Codex CLI du service (tokfit) : `tokfit codex …`.

Au lancement d'une conversation neuve dont le premier message est donné en
ligne de commande (`tokfit codex "…"`, `tokfit codex exec "…"`), il
demande au service le modèle et la réflexion, puis lance `codex` avec
`-m <modèle> -c model_reasoning_effort="<effort>"`. Chez Codex, changer de
modèle en cours de fil réécrit le cache : seul le lancement est gratuit, donc
rien n'est demandé à la reprise (`resume`, `fork`), sans message, ou quand
l'utilisateur fixe lui-même le réglage (`-m`, `-c model=…`, `-p`). Toute
erreur, lenteur (6 s) ou clé refusée lance `codex` tel quel, sans rien
afficher ; une décision aboutie s'affiche : « tokfit : <modèle> · <effort> ».

Pour toute conversation menée par le lancement (neuve, reprise, fork), le
service dit aussi à partir de quelle taille de contexte la compaction paie
(/v1/compact-limit, même règle au coût que pour Claude Code) : le lanceur la
pose par `-c model_auto_compact_token_limit=<tokens>`, sauf si l'utilisateur
l'a fixée lui-même (ligne de commande ou config.toml).

Seuls le message de l'utilisateur et des faits partent vers /v1/route.
Avec TOKFIT_SUBAGENT_PROMPTS=1, la consigne d'un sous-agent sans historique
peut aussi partir vers le décideur du service, sans enregistrement ; les autres réponses OpenAI
restent privées. À la fin, un processus détaché relève les
compteurs de tokens dans les fichiers de session de Codex
(`$CODEX_HOME/sessions/…/rollout-*.jsonl`, événements `token_count`) et les
envoie à /v1/usage par lots ; une étape ne porte que des nombres et des
identifiants, et son `step_id` est stable (session, rang de l'événement) : un
renvoi n'est compté qu'une fois. Le format de ces fichiers n'est pas une
interface stable de Codex : un format inconnu ne fait perdre que des compteurs.

Clé et adresse : `~/.config/tokfit/config.json` (`{"url", "key"}`, écrit
par `connector/install.sh codex`, le même que pour Claude Code), ou le fichier
de `TOKFIT_CONFIG`. Python 3.9+, bibliothèque standard seule.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import signal
import subprocess
import sys
import threading
import time
from typing import Dict, Iterable, List, NamedTuple, Optional, Tuple
import urllib.error
import urllib.request

# Nom du connecteur, comme NAME du plugin Claude Code (nom de production dans la copie publique).
NAME = "tokfit"
# Attente maximale d'une décision (TIMEOUT_MS du plugin, ROUTE_MOD_TIMEOUT_S du service).
TIMEOUT_S = 6.0
USAGE_TIMEOUT_S = 10.0
# Attente maximale du seuil de compaction : le lancement ne doit pas traîner.
LIMIT_TIMEOUT_S = 2.0
COMPACT_KEY = "model_auto_compact_token_limit"
# Conversations menées par un lancement : compteurs remontés, seuil de compaction posé.
CONVERSATIONS = ("interactive", "exec", "resume", "fork", "exec resume")
# Lot maximal accepté par le service (USAGE_BATCH_MAX de service/usage.py).
BATCH_MAX = 50
# Dernier argument de `_usage` quand l'utilisateur a fixé le modèle au lancement (-m, -p, -c model=…).
PINNED = "pinned"
# Paliers des compteurs ; ultra n'est jamais choisi automatiquement.
EFFORTS = ("low", "medium", "high", "xhigh", "max", "ultra")
HEAD, TAIL = 3000, 1000
KEY = re.compile(r"ek_[A-Za-z0-9_-]{20,200}")
ADDRESS = re.compile(r"(https://[^\s/?#@]+|http://(127\.0\.0\.1|localhost)(:\d{1,5})?)(/[^\s?#]*)?")
# Modèle que le service peut rendre pour Codex (gpt-6-luna, gpt-6.1-terra…).
MODEL_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,60}")
SESSION_ID = re.compile(r"[A-Za-z0-9-]{1,64}")

# Options de Codex suivies d'une valeur (codex --help, codex exec --help, 0.166.0).
VALUED = {"-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-i", "--image", "-m",
          "--model", "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a",
          "--ask-for-approval", "--thread-source", "--cyber-access-program", "--output-schema", "--color", "-o",
          "--output-last-message"}
SUBCOMMANDS = {"agents", "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "app",
               "completion", "update", "doctor", "sandbox", "debug", "apply", "a", "resume", "queue", "archive", "delete",
               "migrate-rollouts", "migrate-nfs-db", "unarchive", "fork", "cloud", "exec-server", "features", "help"}

Json = Dict[str, object]
Step = Dict[str, object]
Link = Tuple[str, str]
Reply = Optional[Tuple[int, str]]


class Launch(NamedTuple):
    """Ce que dit la ligne de commande : mode, premier message, choix de l'utilisateur."""

    # interactive, exec, ou la sous-commande (resume, fork, exec resume…).
    mode: str
    prompt: Optional[str]
    keep_model: bool
    keep_effort: bool
    images: bool
    # Où insérer -m / -c : en tête, ou juste après `exec`.
    insert_at: int
    cwd: Optional[str]
    # L'utilisateur fixe lui-même le seuil de compaction (-c model_auto_compact_token_limit=…).
    keep_compact: bool = False


def parse(args: List[str]) -> Launch:
    mode, prompt, insert_at, cwd = "interactive", None, 0, None
    keep_model = keep_effort = keep_compact = images = local = False
    index, literal, positionals = 0, False, 0
    while index < len(args):
        arg = args[index]
        if literal or not arg.startswith("-") or arg == "-":
            positionals += 1
            if positionals == 1 and not literal and arg in SUBCOMMANDS:
                mode = "exec" if arg in ("exec", "e") else arg
                insert_at = index + 1
            elif positionals == 2 and mode == "exec" and arg in ("resume", "review"):
                mode = f"exec {arg}"
            elif prompt is None:
                prompt = arg
            index += 1
            continue
        if arg == "--":
            literal = True
            index += 1
            continue
        name, has_value, value = arg.partition("=")
        if not has_value and name in VALUED:
            value = args[index + 1] if index + 1 < len(args) else ""
            index += 1
        index += 1
        if name in ("-m", "--model"):
            keep_model = True
        elif name in ("-p", "--profile"):
            keep_model = keep_effort = True
        elif name in ("-c", "--config"):
            key = value.split("=", 1)[0].strip()
            keep_model = keep_model or key == "model"
            keep_effort = keep_effort or key == "model_reasoning_effort"
            keep_compact = keep_compact or key == COMPACT_KEY
        elif name in ("-i", "--image"):
            images = True
        elif name in ("-C", "--cd"):
            cwd = value
        elif name in ("--oss", "--local-provider"):
            local = True
    routable = mode in ("interactive", "exec") and not local and prompt not in (None, "", "-")
    return Launch(mode, prompt if routable else None, keep_model, keep_effort, images, insert_at, cwd, keep_compact)


def codex_setting(text: str, profile_name: str = "") -> Tuple[str, str]:
    """(modèle, effort) de `config.toml` : clés de tête, ou celles du profil choisi (en tête ou par -p)."""
    sections: Dict[str, Dict[str, str]] = {"": {}}
    current = ""
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        header = re.fullmatch(r"\[([^\]]+)\]", line)
        if header:
            current = header.group(1).strip()
            sections.setdefault(current, {})
            continue
        found = re.fullmatch(r'([A-Za-z_]+)\s*=\s*"([^"]*)"', line)
        if found:
            sections[current][found.group(1)] = found.group(2)
    top = sections[""]
    chosen = profile_name or top.get("profile", "")
    profile = sections.get(f"profiles.{chosen}", {}) if chosen else {}
    pick = {**top, **profile}
    return pick.get("model", ""), pick.get("model_reasoning_effort", "")


def user_setting(args: List[str], config: str, setting_key: str) -> str:
    """Effective native model/effort: command-line override, selected profile, then config."""
    explicit, profile_name, index = "", "", 0
    while index < len(args):
        arg = args[index]
        if arg == "--":
            break
        name, has_value, value = arg.partition("=")
        if arg.startswith("-") and not has_value and name in VALUED:
            value = args[index + 1] if index + 1 < len(args) else ""
            index += 1
        index += 1
        if name in ("-m", "--model") and setting_key == "model":
            explicit = value
        elif name in ("-c", "--config"):
            key, _, setting = value.partition("=")
            if key.strip() == setting_key:
                explicit = setting.strip().strip('"')
        elif name in ("-p", "--profile"):
            profile_name = value
    return explicit or codex_setting(config, profile_name)[0 if setting_key == "model" else 1]


def user_model(args: List[str], config: str) -> str:
    """Baseline model before routing; also used for API-equivalent savings."""
    return user_setting(args, config, "model")


def codex_home(env: Dict[str, str]) -> Path:
    return Path(env.get("CODEX_HOME") or Path(env.get("HOME", "~")).expanduser() / ".codex")


def link(env: Dict[str, str]) -> Optional[Link]:
    """(adresse, clé) du fichier de configuration ; None s'il manque ou s'il est douteux."""
    home = env.get("HOME", "")
    path = env.get("TOKFIT_CONFIG") or (f"{home}/.config/{NAME}/config.json" if home else "")
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8")) if path else None
    except (OSError, ValueError):
        # Fichier absent ou illisible : le lanceur reste inerte.
        return None
    if not isinstance(data, dict):
        return None
    url, key = str(data.get("url") or "").strip(), str(data.get("key") or "").strip()
    if not KEY.fullmatch(key) or not ADDRESS.fullmatch(url):
        return None
    return url.rstrip("/"), key


def bounded(text: str, head: int, tail: int) -> str:
    return text if len(text) <= head + tail else text[:head] + " […] " + text[-tail:]


def facts(launch: Launch, model: str, effort: str) -> Json:
    """Le message de l'utilisateur et des faits ; jamais de sortie d'un modèle d'OpenAI."""
    return {
        "surface": "codex", "kind": "main", "message": bounded(launch.prompt or "", HEAD, TAIL),
        "images_attached": launch.images, "previous_exchanges": [], "last_assistant_message": "",
        "conversation_tokens": 0, "rate_limits": [], "model": model,
        **({"effort": effort} if effort in EFFORTS else {}),
        "keep_model": launch.keep_model, "keep_effort": launch.keep_effort,
    }


def catalog_models(raw: object) -> Dict[str, List[str]]:
    """Only native model IDs and efforts; descriptions and other text never leave the client."""
    entries = raw.get("models") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        return {}
    models: Dict[str, List[str]] = {}
    ordered = sorted((entry for entry in entries[:100] if isinstance(entry, dict)),
                     key=lambda entry: number(entry.get("priority")) or 10_000)
    for entry in ordered:
        name, levels = entry.get("slug"), entry.get("supported_reasoning_levels")
        if not isinstance(name, str) or not MODEL_ID.fullmatch(name) or not isinstance(levels, list):
            continue
        efforts = [level["effort"] for level in levels if isinstance(level, dict) and level.get("effort") in EFFORTS]
        if efforts:
            models[name] = list(dict.fromkeys(efforts))
    return models


def native_catalog(env: Dict[str, str]) -> Dict[str, List[str]]:
    binary = env.get("TOKFIT_CODEX") or shutil.which("codex", path=env.get("PATH"))
    if binary is None:
        return {}
    try:
        result = subprocess.run([binary, "debug", "models"], env=env, capture_output=True, text=True, timeout=2)
        return catalog_models(json.loads(result.stdout)) if result.returncode == 0 else {}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        # An unavailable/older catalogue must not delay or break Codex.
        return {}


def subagent_hook(event: Json, env: Dict[str, str]) -> Json:
    """Opt-in only: the generated task is the sole OpenAI text sent to /v1/route.

    Full-context forks and custom agent profiles keep their native settings:
    profile files can override explicit spawn settings after this hook runs.
    Never change the fork mode or add permission/context instructions.
    """
    if env.get("TOKFIT_SUBAGENT_PROMPTS") != "1":
        return {}
    if event.get("hook_event_name") != "PreToolUse" or event.get("tool_name") not in (
            "spawn_agent", "collaborationspawn_agent", "Agent"):
        return {}
    args = event.get("tool_input")
    if not isinstance(args, dict) or args.get("fork_context") is True or args.get("fork_turns") == "all":
        return {}
    if args.get("fork_turns") != "none" and args.get("fork_context") is not False:
        # Codex 0.166 defaults fork_turns to all. Overrides would be rejected.
        return {}
    if args.get("agent_type", "default") != "default":
        return {}
    task = args.get("message")
    model = args.get("model") or event.get("model")
    if not isinstance(task, str) or not task.strip() or not isinstance(model, str) or not MODEL_ID.fullmatch(model):
        return {}
    to = link(env)
    if to is None:
        return {}
    payload: Json = {"surface": "codex", "kind": "subagent", "model": model,
                     "message": bounded(task, HEAD, TAIL), "conversation_tokens": 0,
                     "previous_exchanges": [], "last_assistant_message": "", "cache_cold": True}
    effort = args.get("reasoning_effort")
    if isinstance(effort, str) and effort in EFFORTS:
        payload["effort"] = effort
    session = event.get("session_id")
    if isinstance(session, str) and SESSION_ID.fullmatch(session):
        payload["session_id"] = session
    catalog = native_catalog(env)
    if not catalog:
        return {}
    payload["available_models"] = catalog
    reply = post(to, "/v1/route", payload, TIMEOUT_S)
    choice = decision(reply[1]) if reply is not None and reply[0] == 200 else None
    if choice is None:
        return {}
    selected_model, selected_effort = choice
    target = selected_model or model
    if catalog and (target not in catalog or (selected_effort is not None and selected_effort not in catalog[target])):
        return {}
    updated = dict(args)
    if selected_model is not None:
        updated["model"] = selected_model
    if selected_effort is not None:
        updated["reasoning_effort"] = selected_effort
    if updated == args:
        return {}
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": updated}}


def hook_args(args: List[str], env: Dict[str, str]) -> List[str]:
    """An invocation config layer; Codex merges its hooks with the user's layers.

    Hook trust is left to /hooks. Never add a trust-bypass flag.
    """
    launch = parse(args)
    if env.get("TOKFIT_SUBAGENT_PROMPTS") != "1" or launch.mode not in CONVERSATIONS or link(env) is None:
        return args
    command = shlex.join([sys.executable, os.path.abspath(__file__), "_hook"])
    value = ('hooks.PreToolUse=[{matcher="^(collaboration)?spawn_agent$|^Agent$",hooks=[{type="command",command='
             + json.dumps(command) + ',timeout=9}]}]')
    return args[:launch.insert_at] + ["-c", value] + args[launch.insert_at:]


def decision(text: str) -> Optional[Tuple[Optional[str], Optional[str]]]:
    """(modèle, effort) rendus par le service ; None si la réponse n'est pas une décision valide."""
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    model, effort = parsed.get("model"), parsed.get("effort")
    if model is not None and not (isinstance(model, str) and MODEL_ID.fullmatch(model)):
        return None
    if effort is not None and effort not in EFFORTS:
        return None
    return model, effort


def post(to: Link, path: str, body: object, timeout: float) -> Reply:
    """POST JSON borné dans le temps (total) ; None sur toute erreur réseau ou lenteur."""
    request = urllib.request.Request(to[0] + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"content-type": "application/json", "authorization": f"Bearer {to[1]}"})
    result: List[Reply] = [None]

    def call() -> None:
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result[0] = (response.status, response.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as error:
            result[0] = (error.code, "")
        except (OSError, ValueError):
            # Injoignable ou réponse cassée : l'appelant garde le réglage.
            result[0] = None

    worker = threading.Thread(target=call, daemon=True)
    worker.start()
    worker.join(timeout)
    return result[0]


def routed(args: List[str], launch: Launch, model: Optional[str], effort: Optional[str]) -> List[str]:
    added = (["-m", model] if model else []) + (["-c", f'model_reasoning_effort="{effort}"'] if effort else [])
    return args[:launch.insert_at] + added + args[launch.insert_at:]


def decide(args: List[str], env: Dict[str, str]) -> List[str]:
    """Arguments de `codex` : avec le réglage du service, ou inchangés sur toute panne."""
    launch = parse(args)
    to = link(env)
    if to is None:
        return args
    try:
        config = (codex_home(env) / "config.toml").read_text(encoding="utf-8")
    except OSError:
        config = ""
    out, chosen_model = args, None
    if launch.prompt is not None and not (launch.keep_model and launch.keep_effort):
        effort = user_setting(args, config, "model_reasoning_effort")
        catalog = native_catalog(env)
        model = user_model(args, config) or next(iter(catalog), "")
        payload = facts(launch, model, effort)
        if catalog:
            payload["available_models"] = catalog
        reply = post(to, "/v1/route", payload, TIMEOUT_S) if catalog else None
        choice = decision(reply[1]) if reply is not None and reply[0] == 200 else None
        if choice is not None and catalog:
            target = model if launch.keep_model else choice[0] or model
            wanted_effort = effort if launch.keep_effort else choice[1] or effort
            if target not in catalog or (wanted_effort is not None and wanted_effort not in catalog[target]):
                choice = None
        if choice is not None:
            chosen_model = None if launch.keep_model else choice[0]
            chosen_effort = None if launch.keep_effort else choice[1]
            shown = " · ".join(part for part in (chosen_model or model, chosen_effort or effort) if part)
            if shown:
                print(f"{NAME} : {shown}", file=sys.stderr)
            out = routed(args, launch, chosen_model, chosen_effort)
    return limited(out, launch, to, config, chosen_model or user_model(args, config))


def compact_limit(text: str) -> Optional[int]:
    try:
        value = json.loads(text).get("compact_at")
    except (ValueError, AttributeError):
        # Réponse illisible : Codex garde son propre seuil.
        return None
    return value if isinstance(value, int) and not isinstance(value, bool) and 10_000 <= value <= 10_000_000 else None


def limited(args: List[str], launch: Launch, to: Link, config: str, model: str) -> List[str]:
    """Seuil de compaction du service, sauf si l'utilisateur a fixé le sien ; inchangé sur toute panne."""
    if launch.mode not in CONVERSATIONS or launch.keep_compact or re.search(rf"(?m)^\s*{COMPACT_KEY}\s*=", config):
        return args
    reply = post(to, "/v1/compact-limit", {"model": model}, LIMIT_TIMEOUT_S)
    limit = compact_limit(reply[1]) if reply is not None and reply[0] == 200 else None
    if limit is None:
        return args
    return args[:launch.insert_at] + ["-c", f"{COMPACT_KEY}={limit}"] + args[launch.insert_at:]


def step_id(session: str, rank: object) -> str:
    return hashlib.sha256(f"codex\n{session}\n{rank}".encode()).hexdigest()[:32]


def number(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def quota(limits: object) -> Optional[float]:
    windows = [limits.get(name) for name in ("primary", "secondary")] if isinstance(limits, dict) else []
    used = [w.get("used_percent") for w in windows if isinstance(w, dict)]
    values = [float(v) for v in used if isinstance(v, (int, float)) and not isinstance(v, bool)]
    return min(100.0, max(0.0, *values)) if values else None


def steps_of(lines: Iterable[str]) -> List[Step]:
    """Une étape par requête au modèle (`token_count` dont le total avance), sans aucun texte."""
    session, model, effort, total = "", "", "", -1
    steps: List[Step] = []
    for rank, line in enumerate(lines):
        try:
            item = json.loads(line)
        except ValueError:
            continue
        payload = item.get("payload") if isinstance(item, dict) else None
        if not isinstance(payload, dict):
            continue
        kind = item.get("type")
        if kind == "session_meta" and isinstance(payload.get("id"), str) and SESSION_ID.fullmatch(payload["id"]):
            session = payload["id"]
        elif kind == "turn_context":
            named, level = payload.get("model"), payload.get("effort")
            model = named if isinstance(named, str) else model
            effort = level if isinstance(level, str) else ""
        elif kind == "event_msg" and payload.get("type") == "token_count" and isinstance(payload.get("info"), dict):
            info = payload["info"]
            grand = number((info.get("total_token_usage") or {}).get("total_tokens"))
            last = info.get("last_token_usage")
            if grand <= total or not isinstance(last, dict) or not session or not MODEL_ID.fullmatch(model):
                continue
            total = grand
            read, write = number(last.get("cached_input_tokens")), number(last.get("cache_write_input_tokens"))
            used = quota(payload.get("rate_limits"))
            ordinal = item.get("ordinal")
            steps.append({
                "step_id": step_id(session, ordinal if isinstance(ordinal, int) else rank), "session_id": session,
                "model": model, **({"effort": effort} if effort in EFFORTS else {}),
                # Chez OpenAI, input_tokens compte aussi le cache lu et écrit.
                "input": max(0, number(last.get("input_tokens")) - read - write), "cache_read": read,
                "cache_write": write, "output": number(last.get("output_tokens")),
                **({"quota_percent": used} if used is not None else {}),
            })
    return steps


def session_files(home: Path, since: float, cwd: str) -> List[Path]:
    """Fichiers de session écrits depuis `since` pour ce dossier (dossiers du jour du lancement à aujourd'hui)."""
    days = {datetime.date.fromtimestamp(since), datetime.date.today()}
    found = []
    for day in sorted(days):
        folder = home / "sessions" / f"{day:%Y/%m/%d}"
        for path in sorted(folder.glob("rollout-*.jsonl")) if folder.is_dir() else []:
            try:
                if path.stat().st_mtime < since - 1:
                    continue
                with path.open(encoding="utf-8") as stream:
                    first = json.loads(stream.readline() or "{}")
            except (OSError, ValueError):
                continue
            meta = first.get("payload") if isinstance(first, dict) else None
            where = meta.get("cwd") if isinstance(meta, dict) else None
            if isinstance(where, str) and os.path.realpath(where) == os.path.realpath(cwd):
                found.append(path)
    return found


def send_usage(env: Dict[str, str], since: float, cwd: str, reference: str = "", pinned: bool = False) -> None:
    """Relève et envoie les compteurs des sessions de ce lancement ; ne lève jamais. `pinned` :
    l'utilisateur a fixé le modèle au lancement, ses étapes sont hors mesure pour le service."""
    to = link(env)
    if to is None:
        return
    steps: List[Step] = []
    for path in session_files(codex_home(env), since, cwd):
        try:
            steps += steps_of(path.read_text(encoding="utf-8").splitlines())
        except OSError:
            continue
    for step in steps:
        if reference:
            step["reference_model"] = reference
        if pinned:
            step["pinned"] = True
    for start in range(0, len(steps), BATCH_MAX):
        reply = post(to, "/v1/usage", {"steps": steps[start:start + BATCH_MAX]}, USAGE_TIMEOUT_S)
        # Injoignable, lent ou en erreur : le reste est perdu pour ce lancement (sous-compte,
        # jamais double compte) ; un lancement suivant dans la même session le renverra.
        if reply is None or reply[0] == 408 or reply[0] == 429 or reply[0] >= 500:
            return


def run_codex(args: List[str], env: Dict[str, str]) -> int:
    binary = env.get("TOKFIT_CODEX") or shutil.which("codex", path=env.get("PATH"))
    if not binary:
        print(f"{NAME} : codex introuvable (installe Codex CLI d'abord).", file=sys.stderr)
        return 127
    # Same local mechanisms as a host/ACP launch; old services decline the
    # versioned handshake and leave Codex's native transport unchanged.
    to = link(env)
    for runtime in (Path(__file__).parent / "runtime", Path(__file__).parent.parent / "runtime"):
        if to and (runtime / "relay.py").is_file():
            sys.path.insert(0, str(runtime.parent))
            from runtime.relay import run
            return run(binary, args, {**env, "TOKFIT_RELAY_URL": to[0], "TOKFIT_RELAY_TOKEN": to[1]})
    # Ctrl-C va à Codex (même groupe de processus) : le lanceur attend sa fin.
    previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        return subprocess.call([binary, *args])
    finally:
        signal.signal(signal.SIGINT, previous)


def main(argv: List[str], env: Dict[str, str]) -> int:
    if argv == ["_hook"]:
        try:
            event = json.loads(sys.stdin.read(65_537))
        except ValueError:
            return 0
        if isinstance(event, dict):
            output = subagent_hook(event, env)
            if output:
                print(json.dumps(output))
        return 0
    if argv[:1] == ["_usage"] and len(argv) in (3, 4, 5):
        send_usage(env, float(argv[1]), argv[2], argv[3] if len(argv) >= 4 else "", argv[4:] == [PINNED])
        return 0
    if argv[:1] != ["codex"]:
        print(f"usage : {NAME} codex [options et message de codex]", file=sys.stderr)
        return 2
    args = argv[1:]
    since = time.time()
    launch = parse(args)
    try:
        reference = user_model(args, (codex_home(env) / "config.toml").read_text(encoding="utf-8"))
    except OSError:
        reference = user_model(args, "")
    code = run_codex(hook_args(decide(args, env), env), env)
    # Compteurs : toute conversation menée par ce lancement (neuve, reprise ou fork).
    counted = launch.mode in CONVERSATIONS
    if counted and link(env) is not None:
        cwd = os.path.join(os.getcwd(), os.path.expanduser(launch.cwd)) if launch.cwd else os.getcwd()
        # Envoi détaché : la main revient tout de suite, même si le service est lent.
        fixed = [PINNED] if launch.keep_model else []
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "_usage", repr(since), cwd, reference, *fixed],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, env=env)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], dict(os.environ)))

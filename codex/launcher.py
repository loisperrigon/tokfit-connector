#!/usr/bin/env python3
"""Lanceur Codex CLI du service (tokfit) : `tokfit codex …`.

Au lancement d'une conversation neuve dont le premier message est donné en
ligne de commande (`tokfit codex "…"`, `tokfit codex exec "…"`), il
demande au service le modèle et la réflexion, puis lance `codex` avec
`-m <modèle> -c model_reasoning_effort="<effort>"`. Chez Codex, changer de
modèle en cours de fil réécrit le cache : seul le lancement est gratuit, donc
rien n'est demandé à la reprise (`resume`, `fork`), sans message, ou quand
l'utilisateur fixe lui-même le réglage (`-m`, `-c model=…`, `-p`). Une balise
de réflexion dans le message (`[low]`…`[xhigh]`, comme pour Claude Code) passe
avant le service et s'applique même s'il est en panne. Toute erreur, lenteur
(6 s) ou clé refusée lance `codex` sans autre réglage, sans rien afficher ; une décision aboutie s'affiche : « tokfit : <modèle> · <effort> ».

Seuls le message de l'utilisateur et des faits partent vers /v1/route, jamais
une réponse d'un modèle d'OpenAI. À la fin, un processus détaché relève les
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
import signal
import subprocess
import sys
import threading
import time
from typing import Dict, Iterable, List, NamedTuple, Optional, Tuple
import urllib.error
import urllib.request

# Nom du produit, comme NAME du plugin Claude Code.
NAME = "tokfit"
# Attente maximale d'une décision (TIMEOUT_MS du plugin, ROUTE_MOD_TIMEOUT_S du service).
TIMEOUT_S = 6.0
USAGE_TIMEOUT_S = 10.0
# Lot maximal accepté par le service (USAGE_BATCH_MAX de service/usage.py).
BATCH_MAX = 50
# Paliers que le service connaît (EFFORTS de service/fields.py) ; Codex en a d'autres (ultra).
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# Balises de réflexion dans le message ([low]…[xhigh]), comme celles du plugin
# Claude Code : paliers que Codex et le service connaissent tous deux.
TAG_EFFORTS = ("low", "medium", "high", "xhigh")
TAG = re.compile(r"\[(\w+)\]")
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
    # Réflexion choisie par une balise du message, appliquée même service en panne.
    tag_effort: Optional[str] = None


def parse(args: List[str]) -> Launch:
    mode, prompt, insert_at, cwd = "interactive", None, 0, None
    keep_model = keep_effort = images = local = False
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
        elif name in ("-i", "--image"):
            images = True
        elif name in ("-C", "--cd"):
            cwd = value
        elif name in ("--oss", "--local-provider"):
            local = True
    routable = mode in ("interactive", "exec") and not local and prompt not in (None, "", "-")
    tag_effort = None if keep_effort or not routable else tagged_effort(prompt or "")
    return Launch(mode, prompt if routable else None, keep_model, keep_effort or tag_effort is not None, images,
                  insert_at, cwd, tag_effort)


def tagged_effort(prompt: str) -> Optional[str]:
    """Dernière balise de réflexion du message ([high]…), ou None."""
    words = [match.group(1).lower() for match in TAG.finditer(prompt)]
    return next((word for word in reversed(words) if word in TAG_EFFORTS), None)


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


def user_model(args: List[str], config: str) -> str:
    """Modèle que l'utilisateur aurait eu sans le service : -m / -c model=…, sinon son profil
    (-p) ou sa config. Sert de référence des économies ; vide = défaut de Codex (côté service)."""
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
        if name in ("-m", "--model"):
            explicit = value
        elif name in ("-c", "--config"):
            key, _, setting = value.partition("=")
            if key.strip() == "model":
                explicit = setting.strip().strip('"')
        elif name in ("-p", "--profile"):
            profile_name = value
    return explicit or codex_setting(config, profile_name)[0]


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
    unchanged = routed(args, launch, None, launch.tag_effort) if launch.tag_effort else args
    to = link(env)
    if launch.prompt is None or to is None or (launch.keep_model and launch.keep_effort):
        return unchanged
    try:
        model, effort = codex_setting((codex_home(env) / "config.toml").read_text(encoding="utf-8"))
    except OSError:
        model, effort = "", ""
    reply = post(to, "/v1/route", facts(launch, model, launch.tag_effort or effort), TIMEOUT_S)
    choice = decision(reply[1]) if reply is not None and reply[0] == 200 else None
    if choice is None:
        return unchanged
    chosen_model = None if launch.keep_model else choice[0]
    chosen_effort = launch.tag_effort or (None if launch.keep_effort else choice[1])
    shown = " · ".join(part for part in (chosen_model or model, chosen_effort or effort) if part)
    if shown:
        print(f"{NAME} : {shown}", file=sys.stderr)
    return routed(args, launch, chosen_model, chosen_effort)


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


def send_usage(env: Dict[str, str], since: float, cwd: str, reference: str = "") -> None:
    """Relève et envoie les compteurs des sessions de ce lancement ; ne lève jamais."""
    to = link(env)
    if to is None:
        return
    steps: List[Step] = []
    for path in session_files(codex_home(env), since, cwd):
        try:
            steps += steps_of(path.read_text(encoding="utf-8").splitlines())
        except OSError:
            continue
    if reference:
        for step in steps:
            step["reference_model"] = reference
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
    # Ctrl-C va à Codex (même groupe de processus) : le lanceur attend sa fin.
    previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        return subprocess.call([binary, *args])
    finally:
        signal.signal(signal.SIGINT, previous)


def main(argv: List[str], env: Dict[str, str]) -> int:
    if argv[:1] == ["_usage"] and len(argv) in (3, 4):
        send_usage(env, float(argv[1]), argv[2], argv[3] if len(argv) == 4 else "")
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
    code = run_codex(decide(args, env), env)
    # Compteurs : toute conversation menée par ce lancement (neuve, reprise ou fork).
    counted = launch.mode in ("interactive", "exec", "resume", "fork", "exec resume")
    if counted and link(env) is not None:
        cwd = os.path.join(os.getcwd(), os.path.expanduser(launch.cwd)) if launch.cwd else os.getcwd()
        # Envoi détaché : la main revient tout de suite, même si le service est lent.
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "_usage", repr(since), cwd, reference],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, env=env)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], dict(os.environ)))

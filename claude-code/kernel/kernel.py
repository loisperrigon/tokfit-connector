"""Pilote du noyau : démarre `worker.py`, lui passe le code, borne le temps et la sortie.

Délai dépassé : SIGINT (la cellule s'arrête, l'état reste), puis, sans
réponse après un court délai de grâce, arrêt forcé et redémarrage. Noyau
mort (crash, `os._exit`) : redémarrage, l'amorce rejouée, et le modèle est
prévenu que son état est perdu.

Le noyau tourne sur l'interpréteur du serveur (le Python de tokfit, choisi par
`kernel/launch.sh`), avec -I (ni PYTHONPATH, ni PYTHONHOME, ni site de l'utilisateur)
et -B ; le code du projet s'importe quand même (`kernel/projet.py`, au démarrage
du worker). Environnement des commandes qu'il lance : un dossier de shims en tête
du PATH, où `python` et `python3` lancent le `.venv` du dossier courant s'il
existe, sinon le premier `python3` du PATH, sinon le Python de tokfit (machine
sans Python), et `PYTHONDONTWRITEBYTECODE=1`.
Les options du plugin n'y passent pas ; le lien au service arrive par une
variable que le noyau retire à son démarrage (`kernel/pack.py`).
"""
from __future__ import annotations

import json
import logging
import os
import select
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional

from kernel.output import MAX_SORTIE, tronque
from kernel.pack import Lien, environnement_du_noyau

WORKER = Path(__file__).with_name("worker.py")
GRACE_S = 2.0
REDEMARRE = "[kernel restarted: state lost]"
ARRETE = "[kernel stopped: the session is closing]"
log = logging.getLogger("tokfit.kernel")
# Shim de `python` et `python3` : les dossiers de shims (celui-ci, ceux d'un noyau qui lance ce noyau) sont
# sautés, sinon deux shims se relanceraient l'un l'autre. PYTHONHOME ne vaut jamais pour le Python de tokfit.
SHIM_PYTHON = """#!/bin/sh
# {nom} du noyau : le .venv du dossier courant s'il existe, sinon le premier python3 du PATH, sinon le Python de tokfit.
if [ -x .venv/bin/python ]; then exec "$(pwd)/.venv/bin/python" "$@"; fi
set -f
IFS=:
for d in $PATH; do
  case $d in ''|*/noyau-shims-*) continue ;; esac
  if [ -x "$d/python3" ] && [ ! -d "$d/python3" ]; then exec "$d/python3" "$@"; fi
done
unset PYTHONHOME
exec {secours} "$@"
"""
SHIMS = ("python", "python3")


class Execution(NamedTuple):
    sortie: str
    ok: bool
    fini: Optional[str] = None
    # Appels par outil pendant la cellule (`module.nom` -> nombre).
    usage: Optional[Dict[str, int]] = None
    # Images montrées par `look` (`{"data": base64, "mimeType": …}`), rendues en blocs image.
    images: Optional[List[Dict[str, str]]] = None


def creer_shims(dossier: Path, secours: str = sys.executable) -> Path:
    """Écrit les shims (`python`, `python3`) dans `dossier` et le rend ; `secours` : le Python de tokfit."""
    dossier.mkdir(parents=True, exist_ok=True)
    for nom in SHIMS:
        shim = dossier / nom
        shim.write_text(SHIM_PYTHON.format(nom=nom, secours=shlex.quote(secours)), encoding="utf-8")
        shim.chmod(0o755)
    return dossier


def environnement(shims: Path, base: Optional[Dict[str, str]] = None, lien: Optional[Lien] = None) -> Dict[str, str]:
    env = environnement_du_noyau(dict(os.environ if base is None else base), lien)
    env["PATH"] = os.pathsep.join(p for p in (str(shims), env.get("PATH", "")) if p)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


class NoyauMort(Exception):
    """Le processus du noyau a disparu pendant une cellule."""


class Noyau:
    def __init__(self, amorce: str = "", max_sortie: int = MAX_SORTIE, cwd: Optional[str] = None,
                 lien: Optional[Lien] = None) -> None:
        self.amorce = amorce
        self.lien = lien
        self.max_sortie = max_sortie
        self.cwd = cwd
        self.processus: Optional[subprocess.Popen[bytes]] = None
        self.requetes: Optional[int] = None
        self.reponses: Optional[int] = None
        self.tampon = b""
        self.shims: Optional[tempfile.TemporaryDirectory[str]] = None
        # Posé par `fermer()` : plus aucun redémarrage, l'arrêt du serveur est en cours.
        self.ferme = False

    def demarrer(self) -> str:
        """Lance le noyau et rejoue l'amorce ; rend ce que l'amorce a écrit."""
        self.arreter()
        lecture_enfant, ecriture_parent = os.pipe()
        lecture_parent, ecriture_enfant = os.pipe()
        if self.shims is None:
            self.shims = tempfile.TemporaryDirectory(prefix="noyau-shims-")
        env = environnement(creer_shims(Path(self.shims.name)), lien=self.lien)
        self.processus = subprocess.Popen(
            [sys.executable, "-I", "-B", str(WORKER), str(lecture_enfant), str(ecriture_enfant), str(self.max_sortie)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            pass_fds=(lecture_enfant, ecriture_enfant), cwd=self.cwd, start_new_session=True, env=env,
        )
        os.close(lecture_enfant)
        os.close(ecriture_enfant)
        self.requetes, self.reponses, self.tampon = ecriture_parent, lecture_parent, b""
        if not self.amorce:
            return ""
        return self.executer(self.amorce, 120).sortie

    def arreter(self) -> None:
        for fd in (self.requetes, self.reponses):
            if fd is not None:
                os.close(fd)
        self.requetes = self.reponses = None
        if self.processus is not None and self.processus.poll() is None:
            self.processus.kill()
            self.processus.wait()
        self.processus = None
        if self.shims is not None:
            self.shims.cleanup()
            self.shims = None

    def fermer(self) -> None:
        """Arrêt du serveur : le processus est tué tout de suite, même au milieu d'une cellule
        (celle-ci rend ARRETE, sans redémarrage) ; `arreter()` libère ensuite le reste."""
        self.ferme = True
        processus = self.processus
        if processus is not None and processus.poll() is None:
            processus.kill()

    def executer(self, code: str, timeout_s: int) -> Execution:
        if self.ferme:
            return Execution(ARRETE, False)
        if self.processus is None:
            self.demarrer()
        try:
            self.envoyer(code)
            reponse = self.lire(float(timeout_s))
            if reponse is not None:
                return self.borne(reponse)
            assert self.processus is not None
            os.kill(self.processus.pid, signal.SIGINT)
            reponse = self.lire(GRACE_S)
            if reponse is not None:
                return Execution(tronque(f"{reponse['sortie']}[interrupted after {timeout_s} s]", self.max_sortie), False)
            log.warning("noyau sourd à SIGINT après %s s : redémarrage", timeout_s)
            sortie = f"[interrupted after {timeout_s} s]\n{REDEMARRE}"
        except NoyauMort:
            if self.ferme:
                return Execution(ARRETE, False)
            log.warning("noyau mort pendant une cellule : redémarrage")
            sortie = REDEMARRE
        amorce = self.demarrer()
        return Execution(tronque(f"{sortie}\n{amorce}".rstrip("\n"), self.max_sortie), False)

    def borne(self, reponse: dict[str, object]) -> Execution:
        ok = bool(reponse["ok"])
        fini = reponse.get("fini")
        usage = reponse.get("usage")
        appels = {cle: n for cle, n in usage.items() if isinstance(cle, str) and isinstance(n, int) and n > 0} \
            if isinstance(usage, dict) else {}
        brutes = reponse.get("images")
        images = [{"data": str(image["data"]), "mimeType": str(image["mimeType"])} for image in brutes
                  if isinstance(image, dict) and isinstance(image.get("data"), str)
                  and isinstance(image.get("mimeType"), str)] if isinstance(brutes, list) else []
        return Execution(tronque(str(reponse["sortie"]), self.max_sortie), ok,
                         fini if ok and isinstance(fini, str) else None, appels or None, images or None)

    def envoyer(self, code: str) -> None:
        assert self.requetes is not None
        donnees = (json.dumps({"code": code}, ensure_ascii=False) + "\n").encode("utf-8")
        try:
            while donnees:
                donnees = donnees[os.write(self.requetes, donnees):]
        except BrokenPipeError as erreur:
            raise NoyauMort() from erreur

    def lire(self, delai_s: float) -> Optional[dict[str, object]]:
        """Une réponse, None si le délai passe ; NoyauMort si le tube se ferme."""
        assert self.reponses is not None
        fin = time.monotonic() + delai_s
        while b"\n" not in self.tampon:
            reste = fin - time.monotonic()
            if reste <= 0:
                return None
            pret, _, _ = select.select([self.reponses], [], [], reste)
            if not pret:
                return None
            morceau = os.read(self.reponses, 65536)
            if not morceau:
                raise NoyauMort()
            self.tampon += morceau
        ligne, self.tampon = self.tampon.split(b"\n", 1)
        reponse = json.loads(ligne.decode("utf-8"))
        if not isinstance(reponse, dict):
            raise NoyauMort()
        return reponse

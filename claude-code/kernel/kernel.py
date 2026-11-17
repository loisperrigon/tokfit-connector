"""Pilote du noyau : démarre `worker.py`, lui passe le code, borne le temps et la sortie.

Délai dépassé : SIGINT (la cellule s'arrête, l'état reste), renvoyé pendant
un délai de grâce ; une cellule qui l'ignore encore (appel en C, interruption
attrapée) continue, l'état gardé : l'appel suivant l'attend jusqu'à son propre
délai, en renvoyant SIGINT, et ne redémarre le noyau qu'ensuite. Noyau
mort (crash, `os._exit`) : redémarrage, l'amorce rejouée, et le modèle est
prévenu que son état est perdu.

Un outil qui attend plus longtemps que le reste du délai (`shell(timeout_s=…)`…) le fait reculer, jusqu'à
PROLONGEE_MAX depuis le début de la cellule (`kernel/cellule.py`) ; le délai affiché est alors celui atteint.
Une cellule coupée propose l'arrière-plan (`job`). Les travaux de fond s'arrêtent avec le noyau : redémarrage,
fin de session.

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
import queue
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional

from kernel import tubes
from kernel.cellule import GROUPES, PROLONGE, PROLONGEE_MAX
from kernel.output import MAX_SORTIE, tronque
from kernel.pack import Lien, environnement_du_noyau

WORKER = Path(__file__).with_name("worker.py")
TIMEOUT_MAX = 600  # délai le plus long d'une cellule (`timeout_s` de l'outil)
GRACE_S = 5.0
INTERRUPTION_TOUS_S = 0.5
REDEMARRE = "[kernel restarted: state lost]"
TOURNE_ENCORE = ("[cell still running after {} s: it ignores the interrupt (long call in C, or KeyboardInterrupt "
                 "caught); state kept, the next call waits for it up to its timeout_s, then restarts the kernel]")
FINIE_ENFIN = "[previous cell stopped; its output:]\n"
TOUJOURS_SOURD = "[previous cell still running after {} more s]"
PLUS_LONG = "\n[longer work: run it in the background with job(command) and check on it in later calls{}]"
ENCORE = ", or run it again with timeout_s={} ({} at most)"
TRAVAUX_ARRETES = "\n[background jobs stopped: {}]"
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
# Sous Windows (fichiers .cmd, trouvés par PATHEXT) : le .venv du dossier courant, sinon le premier python.exe
# du PATH qui n'est pas l'alias du Microsoft Store (WindowsApps, qui ouvre le Store au lieu de Python), sinon le
# Python de tokfit. `python3.exe` n'existe guère sous Windows : le shim `python3` suit la même règle.
SHIM_CMD = """@echo off
rem {nom} du noyau : .venv du dossier courant, sinon python.exe du PATH, sinon le Python de tokfit.
if not exist ".venv\\Scripts\\python.exe" goto systeme
"%CD%\\.venv\\Scripts\\python.exe" %*
exit /b %errorlevel%
:systeme
set "TOKFIT_PY="
for %%P in (python.exe) do set "TOKFIT_PY=%%~$PATH:P"
if defined TOKFIT_PY echo "%TOKFIT_PY%" | find /i "\\WindowsApps\\" >nul && set "TOKFIT_PY="
if not defined TOKFIT_PY set "PYTHONHOME=" & set "TOKFIT_PY={secours}"
"%TOKFIT_PY%" %*
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
        if tubes.WINDOWS:
            (dossier / f"{nom}.cmd").write_text(SHIM_CMD.format(nom=nom, secours=secours), encoding="utf-8")
            continue
        shim = dossier / nom
        shim.write_text(SHIM_PYTHON.format(nom=nom, secours=shlex.quote(secours)), encoding="utf-8")
        shim.chmod(0o755)
    return dossier


def environnement(shims: Path, base: Optional[Dict[str, str]] = None, lien: Optional[Lien] = None) -> Dict[str, str]:
    env = environnement_du_noyau(dict(os.environ if base is None else base), lien)
    env["PATH"] = os.pathsep.join(p for p in (str(shims), env.get("PATH", "")) if p)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def lire_en_fond(fd: int) -> "queue.Queue[bytes]":
    """Lit le tube `fd` dans un fil (le même code sous POSIX et Windows, où `select` ne prend pas de tube) ;
    les morceaux arrivent dans la file rendue, b"" à la fermeture, et le fil ferme `fd`."""
    file: "queue.Queue[bytes]" = queue.Queue()

    def boucle() -> None:
        try:
            while True:
                try:
                    morceau = os.read(fd, 65536)
                except OSError:
                    morceau = b""  # Windows : tube cassé à la mort du noyau
                file.put(morceau)
                if not morceau:
                    return
        finally:
            os.close(fd)

    threading.Thread(target=boucle, name="reponses-du-noyau", daemon=True).start()
    return file


def plus_long(duree_s: int) -> str:
    """Après un délai dépassé (cellule arrêtée après `duree_s`) : l'arrière-plan, et le délai à redemander (quatre
    fois plus, au plus TIMEOUT_MAX) s'il reste de la marge."""
    encore = ENCORE.format(min(duree_s * 4, TIMEOUT_MAX), TIMEOUT_MAX) if duree_s < TIMEOUT_MAX else ""
    return PLUS_LONG.format(encore)


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
        # Morceaux lus sur le tube des réponses par un fil dédié (b"" : tube fermé), un fil et une file par
        # démarrage : rien d'un noyau arrêté ne se mêle au suivant.
        self.reponses: Optional["queue.Queue[bytes]"] = None
        # Tube d'interruption (Windows, `kernel/tubes.py`) ; None : SIGINT.
        self.interruption: Optional[int] = None
        self.tampon = b""
        self.shims: Optional[tempfile.TemporaryDirectory[str]] = None
        # Posé par `fermer()` : plus aucun redémarrage, l'arrêt du serveur est en cours.
        self.ferme = False
        # Une cellule a dépassé son délai sans céder à l'interruption et tourne encore.
        self.en_cours = False
        # Cellule en cours de lecture : son début et son échéance, que ses outils font reculer (`kernel/cellule.py`).
        self.debut: Optional[float] = None
        self.echeance = 0.0
        # Groupes de processus des travaux de fond du noyau (`job`), arrêtés avec lui.
        self.groupes: List[int] = []

    def demarrer(self) -> str:
        """Lance le noyau et rejoue l'amorce ; rend ce que l'amorce a écrit."""
        self.arreter()
        lecture_enfant, ecriture_parent = os.pipe()
        lecture_parent, ecriture_enfant = os.pipe()
        enfant = [lecture_enfant, ecriture_enfant]
        if tubes.WINDOWS:
            lecture_interruption, self.interruption = os.pipe()
            enfant.append(lecture_interruption)
        if self.shims is None:
            self.shims = tempfile.TemporaryDirectory(prefix="noyau-shims-")
        env = environnement(creer_shims(Path(self.shims.name)), lien=self.lien)
        arguments, options = tubes.pour_enfant(enfant)
        try:
            self.processus = subprocess.Popen(
                [sys.executable, "-I", "-B", *tubes.OPTIONS_PYTHON, str(WORKER), arguments[0], arguments[1],
                 str(self.max_sortie), *arguments[2:]],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                cwd=self.cwd, env=env, **options,
            )
        finally:
            for fd in enfant:
                os.close(fd)
        self.requetes, self.reponses, self.tampon = ecriture_parent, lire_en_fond(lecture_parent), b""
        self.en_cours = False
        if not self.amorce:
            return ""
        return self.executer(self.amorce, 120).sortie

    def arreter(self) -> None:
        self.arreter_travaux()
        # Le tube des réponses appartient à son fil, qui le ferme quand le noyau s'arrête.
        for fd in (self.requetes, self.interruption):
            if fd is not None:
                os.close(fd)
        self.requetes = self.interruption = None
        self.reponses = None
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
        self.arreter_travaux()

    def arreter_travaux(self) -> str:
        """Arrête les travaux de fond du noyau ; rend la ligne qui le dit, vide s'il n'y en avait pas."""
        groupes, self.groupes = self.groupes, []
        for groupe in groupes:
            tubes.tuer_groupe(groupe)
        return TRAVAUX_ARRETES.format(len(groupes)) if groupes else ""

    def executer(self, code: str, timeout_s: int) -> Execution:
        if self.ferme:
            return Execution(ARRETE, False)
        if self.processus is None:
            self.demarrer()
        prefixe = ""
        try:
            if self.en_cours:
                precedente = self.interrompre_jusqu_a(float(timeout_s))
                if precedente is None:
                    log.warning("cellule toujours sourde à SIGINT après %s s de plus : redémarrage", timeout_s)
                    sortie = f"{TOUJOURS_SOURD.format(timeout_s)}\n{REDEMARRE}{self.arreter_travaux()}"
                    return Execution(tronque(f"{sortie}\n{self.demarrer()}".rstrip("\n"), self.max_sortie), False)
                self.en_cours = False
                prefixe = FINIE_ENFIN + str(precedente["sortie"]).rstrip("\n") + "\n\n"
            debut = time.monotonic()
            self.debut, self.echeance = debut, debut + timeout_s
            try:
                self.envoyer(code, timeout_s)
                reponse = self.lire(float(timeout_s))
            finally:
                self.debut = None
            if reponse is not None:
                execution = self.borne(reponse)
                return execution._replace(sortie=tronque(prefixe + execution.sortie, self.max_sortie))
            duree = round(self.echeance - debut)
            reponse = self.interrompre_jusqu_a(GRACE_S)
            if reponse is not None:
                return Execution(tronque(f"{prefixe}{reponse['sortie']}[interrupted after {duree} s]"
                                         f"{plus_long(duree)}", self.max_sortie), False)
            log.warning("cellule sourde à SIGINT après %s s : elle continue, état gardé", duree)
            self.en_cours = True
            return Execution(tronque(prefixe + TOURNE_ENCORE.format(duree) + plus_long(duree), self.max_sortie), False)
        except NoyauMort:
            if self.ferme:
                return Execution(ARRETE, False)
            log.warning("noyau mort pendant une cellule : redémarrage")
            sortie = REDEMARRE + self.arreter_travaux()
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

    def interrompre_jusqu_a(self, delai_s: float) -> Optional[dict[str, object]]:
        """Interrompt la cellule en cours, l'interruption renvoyée toutes les `INTERRUPTION_TOUS_S` ; sa
        réponse, None si elle tourne encore au bout de `delai_s`."""
        fin = time.monotonic() + delai_s
        while True:
            self.interrompre()
            reponse = self.lire(min(INTERRUPTION_TOUS_S, max(fin - time.monotonic(), 0.0)))
            if reponse is not None or time.monotonic() >= fin:
                return reponse

    def interrompre(self) -> None:
        """Arrête la cellule en cours, l'état gardé : SIGINT, ou un octet sur le tube d'interruption."""
        assert self.processus is not None
        if self.interruption is None:
            os.kill(self.processus.pid, signal.SIGINT)
            return
        try:
            os.write(self.interruption, tubes.INTERRUPTION)
        except OSError:
            pass  # noyau mort : la lecture qui suit le dira

    def envoyer(self, code: str, timeout_s: int) -> None:
        assert self.requetes is not None
        donnees = (json.dumps({"code": code, "timeout_s": timeout_s}, ensure_ascii=False) + "\n").encode("utf-8")
        try:
            while donnees:
                donnees = donnees[os.write(self.requetes, donnees):]
        except BrokenPipeError as erreur:
            raise NoyauMort() from erreur

    def lire(self, delai_s: float) -> Optional[dict[str, object]]:
        """Une réponse, None si le délai passe ; NoyauMort si le tube se ferme. Une prolongation de la cellule en
        cours (`kernel/cellule.py`) déplace son échéance, et ce délai avec elle ; hors cellule (interruption, cellule
        sourde attendue), elle est ignorée. Chaque réponse dit les travaux de fond encore vivants."""
        fin = time.monotonic() + delai_s
        while True:
            reponse = self.ligne(fin)
            if reponse is None or PROLONGE not in reponse:
                break
            duree = reponse[PROLONGE]
            if self.debut is not None and isinstance(duree, (int, float)):
                # L'échéance peut baisser : après l'attente d'un outil, elle revient au délai de la cellule plus le
                # temps excusé (`cellule.relacher`).
                self.echeance = self.debut + min(float(duree), PROLONGEE_MAX)
                fin = self.echeance
        if reponse is not None:
            groupes = reponse.get(GROUPES)
            self.groupes = [groupe for groupe in groupes if type(groupe) is int and groupe > 0] \
                if isinstance(groupes, list) else []
        return reponse

    def ligne(self, fin: float) -> Optional[dict[str, object]]:
        """Le message suivant du noyau, None si `fin` (horloge monotone) passe ; NoyauMort si le tube se ferme."""
        assert self.reponses is not None
        while b"\n" not in self.tampon:
            reste = fin - time.monotonic()
            if reste <= 0:
                return None
            try:
                morceau = self.reponses.get(timeout=reste)
            except queue.Empty:
                return None
            if not morceau:
                raise NoyauMort()
            self.tampon += morceau
        ligne, self.tampon = self.tampon.split(b"\n", 1)
        reponse = json.loads(ligne.decode("utf-8"))
        if not isinstance(reponse, dict):
            raise NoyauMort()
        return reponse

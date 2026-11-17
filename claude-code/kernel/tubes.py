"""Tubes entre le serveur et son noyau, et interruption d'une cellule : tout ce qui diffère entre POSIX et Windows.

POSIX : les tubes passent par `pass_fds` (numéros de descripteurs en arguments), le noyau tourne dans sa propre
session et SIGINT l'interrompt. Windows (ni `pass_fds` ni SIGINT vers un autre processus, et un noyau sans
console ne reçoit pas CTRL_BREAK_EVENT) : les poignées des tubes passent par `handle_list` (seules héritées,
leurs numéros en arguments), le noyau tourne dans son propre groupe, sans fenêtre, et un troisième tube porte
les interruptions : chaque octet reçu lève SIGINT dans le noyau (`signal.raise_signal`, qui réveille aussi un
`time.sleep`), comme le SIGINT de POSIX. Travaux de fond (`kernel/cellule.py`) : leur groupe de processus sous
POSIX, leur arbre sous Windows. Le reste du noyau ne connaît pas la différence.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
from typing import Any, Dict, List, Sequence, Tuple

# Interruption par tube et options de l'interpréteur ; les branches sur `sys.platform` ci-dessous, que mypy
# comprend, ne concernent que le passage des poignées.
WINDOWS = sys.platform == "win32"
# Options de l'interpréteur du noyau : sous Windows, UTF-8 partout (sinon la page de code du système pour les
# fichiers et les sorties des commandes) ; -I ignore PYTHONUTF8, d'où l'option explicite.
OPTIONS_PYTHON: Tuple[str, ...] = ("-X", "utf8") if WINDOWS else ()
# Octet écrit sur le tube d'interruption (Windows).
INTERRUPTION = b"\x03"


def pour_enfant(fds: Sequence[int]) -> Tuple[List[str], Dict[str, Any]]:
    """Arguments à passer au noyau (un par tube) et options de `subprocess.Popen` pour qu'il hérite de ces
    tubes, et d'eux seuls, détaché du groupe du serveur."""
    if sys.platform != "win32":
        return [str(fd) for fd in fds], {"pass_fds": tuple(fds), "start_new_session": True}
    import msvcrt
    poignees = [msvcrt.get_osfhandle(fd) for fd in fds]
    for poignee in poignees:
        os.set_handle_inheritable(poignee, True)
    infos = subprocess.STARTUPINFO()
    infos.lpAttributeList = {"handle_list": poignees}
    drapeaux = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    return [str(p) for p in poignees], {"startupinfo": infos, "creationflags": drapeaux, "close_fds": True}


def ouvrir(argument: str, ecriture: bool) -> int:
    """Côté noyau : le descripteur d'un tube reçu en argument, qui ne passe plus aux commandes qu'il lance."""
    if sys.platform == "win32":
        import msvcrt
        fd = msvcrt.open_osfhandle(int(argument), os.O_WRONLY if ecriture else os.O_RDONLY)
    else:
        fd = int(argument)
    os.set_inheritable(fd, False)
    return fd


def ecouter_interruptions(fd: int) -> None:
    """Côté noyau (Windows) : chaque octet du tube lève SIGINT, comme le SIGINT envoyé sous POSIX."""
    def boucle() -> None:
        try:
            while os.read(fd, 1):
                signal.raise_signal(signal.SIGINT)
        except OSError:
            pass  # serveur parti

    threading.Thread(target=boucle, name="interruptions", daemon=True).start()


def groupe_vivant(processus: "subprocess.Popen[bytes]") -> bool:
    """Le travail de fond lancé par `processus` (dans son propre groupe) a-t-il encore un processus vivant ?
    POSIX : son groupe, qui survit au shell parti en laissant un serveur ; Windows : le processus lui-même."""
    fini = processus.poll() is not None  # attend aussi le shell fini, sinon zombie compté vivant
    if WINDOWS:
        return not fini
    try:
        os.killpg(processus.pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def tuer_groupe(pid: int) -> None:
    """Arrête un travail de fond et tout ce qu'il a lancé : son groupe de processus (Windows : son arbre)."""
    if WINDOWS:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass

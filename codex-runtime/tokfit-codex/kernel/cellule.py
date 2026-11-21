"""Cellule en cours, côté noyau : son échéance, que les outils qui attendent font reculer, et les travaux de fond.

Un outil de départ qui attend (`shell`, `verify`, `need`, `Job.wait` : leur propre `timeout_s`) appelle
`prolonger(secondes)` avant d'attendre et `relacher()` après : pendant l'attente, si la cellule finirait plus tôt,
son échéance recule, jamais au-delà de PROLONGEE_MAX depuis son début ; après, elle revient au délai de la cellule
augmenté du temps passé à attendre dans ses outils (le temps de la cellule elle-même reste borné par son délai).
Le pilote (`kernel.py`) apprend chaque changement par une ligne `{"prolonge": durée}` sur le tube des réponses,
avant la réponse de la cellule. L'outil reçoit le temps qu'il peut attendre et le dit s'il est plus court que
demandé : le délai d'une cellule ne coupe plus une commande qui demandait plus (banc Terminal-Bench de novembre
2026 : six cellules coupées à 120 s au milieu d'un `shell(timeout_s=600)` ou plus). Sans le retour après
l'attente, une boucle d'appels courts à `shell` (attendre un serveur qui ne démarre pas) repoussait l'échéance à
chaque tour et tournait jusqu'à PROLONGEE_MAX au lieu du délai demandé.

Les travaux de fond (`job`) sont suivis ici (`suivre`) : leurs groupes de processus encore vivants partent avec
chaque réponse (`groupes`), et le pilote les arrête avec le noyau (fin de session, redémarrage).

Servis par le service, les outils de départ cherchent ce module dans `sys.modules` : sous un connecteur qui ne
l'a pas, ils attendent sans prolonger et les travaux de fond survivent au noyau.
"""
from __future__ import annotations

import json
import subprocess
import threading
import time
from typing import List, Optional, TextIO

from kernel import tubes

PROLONGEE_MAX = 1800  # durée la plus longue d'une cellule prolongée par ses outils (s)
MARGE_S = 5.0  # l'outil rend son résultat avant l'échéance : sa propre attente finit MARGE_S plus tôt
PROLONGE = "prolonge"
GROUPES = "groupes"

_canal: Optional[TextIO] = None
_debut: Optional[float] = None
_fin = 0.0
_delai = 0.0  # délai demandé pour la cellule (s)
_excuse = 0.0  # temps déjà passé à attendre dans ses outils (s)
_attentes = 0  # attentes en cours (imbriquées)
_depuis = 0.0  # début de l'attente la plus extérieure
_suivis: List["subprocess.Popen[bytes]"] = []


def ouvrir(canal: TextIO) -> None:
    """Le tube des réponses, où partent les prolongations."""
    global _canal
    _canal = canal


def commencer(timeout_s: float) -> None:
    global _debut, _fin, _delai, _excuse, _attentes
    _debut = time.monotonic()
    _fin = _debut + timeout_s
    _delai, _excuse, _attentes = float(timeout_s), 0.0, 0


def finir() -> None:
    global _debut
    _debut = None


def _suivie() -> bool:
    """Une cellule en cours, vue depuis son propre fil (depuis un autre, sa réponse pourrait déjà être partie)."""
    return _canal is not None and _debut is not None and threading.current_thread() is threading.main_thread()


def _annoncer(fin: float) -> None:
    global _fin
    assert _canal is not None and _debut is not None
    _fin = fin
    _canal.write(json.dumps({PROLONGE: _fin - _debut}) + "\n")
    _canal.flush()


def prolonger(secondes: float) -> float:
    """Le temps qu'un outil peut attendre dès maintenant quand il en demande `secondes` : l'échéance de la cellule
    recule s'il le faut (PROLONGEE_MAX au plus depuis son début), jusqu'à `relacher()`. Hors cellule, ou depuis un
    autre fil que celui de la cellule, `secondes` telles quelles, sans rien prolonger."""
    global _attentes, _depuis
    if not _suivie():
        return secondes
    assert _debut is not None
    maintenant = time.monotonic()
    if _attentes == 0:
        _depuis = maintenant
    _attentes += 1
    voulue = min(maintenant + secondes + MARGE_S, _debut + PROLONGEE_MAX)
    if voulue > _fin:
        _annoncer(voulue)
    return max(0.0, min(secondes, _fin - MARGE_S - maintenant))


def relacher() -> None:
    """Fin de l'attente ouverte par `prolonger` : le temps attendu est excusé, et l'échéance revient au délai de la
    cellule augmenté de tout le temps excusé (PROLONGEE_MAX au plus) ; elle peut donc baisser. Sans attente ouverte
    (ou hors cellule), rien."""
    global _attentes, _excuse
    if not _suivie() or _attentes == 0:
        return
    assert _debut is not None
    _attentes -= 1
    if _attentes:
        return
    _excuse += time.monotonic() - _depuis
    fin = _debut + min(_delai + _excuse, PROLONGEE_MAX)
    if fin != _fin:
        _annoncer(fin)


def suivre(processus: "subprocess.Popen[bytes]") -> None:
    """Un travail de fond, à arrêter avec le noyau (son groupe de processus)."""
    _suivis.append(processus)


def groupes() -> List[int]:
    """Groupes des travaux de fond encore vivants ; les autres ne sont plus suivis."""
    _suivis[:] = [processus for processus in _suivis if tubes.groupe_vivant(processus)]
    return [processus.pid for processus in _suivis]

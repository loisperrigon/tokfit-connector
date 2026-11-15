"""Sorties bornées : ce que le modèle relit ne doit jamais être un vidage brut."""
from __future__ import annotations

import re
from typing import List, Tuple

MAX_SORTIE = 4000
# Lignes gardées en priorité quand une sortie est coupée : erreurs et échecs de tests.
ERREUR = re.compile(r"Traceback|error|FAIL|panicked|assert", re.IGNORECASE)
# Parts de la place gardée : début de la sortie, puis lignes d'erreur au plus ; le reste va à la fin.
PART_DEBUT = 0.2
PART_ERREURS = 0.4
FIN_ERREURS = "[…]\n"
# Sortie entière d'une cellule, gardée dans `_sortie` du noyau : bornée quand même (mémoire).
COMPLET_MAX = 1_000_000
TRACEBACK_LIGNES = 15
DANS_SORTIE = ", tout est dans _sortie"


def marqueur(retires: int, indice: str = "") -> str:
    return f"\n[… {retires} caractères retirés{indice} …]\n"


def erreurs_du_milieu(texte: str, debut: int, fin: int, place: int) -> Tuple[List[str], int]:
    """Lignes d'erreur (ERREUR) entièrement comprises entre `debut` et `fin`, dans l'ordre, tant qu'elles tiennent
    dans `place` caractères ; et la position où finit la dernière gardée (`debut` sans ligne gardée)."""
    gardees: List[str] = []
    taille = 0
    position = 0
    apres = debut
    for ligne in texte.splitlines(True):
        commence, position = position, position + len(ligne)
        if commence < debut or position > fin or not ERREUR.search(ligne):
            continue
        ligne = ligne if ligne.endswith("\n") else ligne + "\n"
        if taille + len(ligne) > place:
            break
        gardees.append(ligne)
        taille += len(ligne)
        apres = position
    return gardees, apres


def tronque(texte: str, maximum: int = MAX_SORTIE, indice: str = "") -> str:
    """Quand `texte` dépasse `maximum` caractères : garde son début, ses lignes d'erreur (Traceback, error, FAIL,
    panicked, assert) en priorité, puis sa fin, la plus longue possible ; sans erreur au milieu, début et fin à parts
    égales."""
    if len(texte) <= maximum:
        return texte
    indice_erreurs = f"{indice} ; lignes d'erreur gardées"
    place = max(maximum - len(marqueur(len(texte), indice_erreurs)) - len(FIN_ERREURS), 2)
    tete = int(place * PART_DEBUT)
    queue_min = place - tete - int(place * PART_ERREURS)
    erreurs, apres = erreurs_du_milieu(texte, tete, len(texte) - queue_min, place - tete - queue_min)
    if not erreurs:
        garde = max(maximum - len(marqueur(len(texte), indice)), 2)
        debut = garde // 2
        fin = garde - debut
        return texte[:debut] + marqueur(len(texte) - debut - fin, indice) + texte[-fin:]
    # La fin prend toute la place laissée par les erreurs, sans revenir sur la dernière ligne gardée.
    gardees = sum(map(len, erreurs))
    queue = min(place - tete - gardees, len(texte) - apres)
    retires = len(texte) - tete - queue - gardees
    return texte[:tete] + marqueur(retires, indice_erreurs) + "".join(erreurs) + FIN_ERREURS + texte[len(texte) - queue:]


def resume_traceback(tb: str, lignes: int = TRACEBACK_LIGNES) -> str:
    """Les `lignes` dernières lignes d'un traceback : l'erreur et ses appels les plus proches."""
    toutes = tb.rstrip("\n").splitlines()
    if len(toutes) <= lignes:
        return "\n".join(toutes)
    return "\n".join([f"[… {len(toutes) - lignes} lignes …]"] + toutes[-lignes:])


class Capture:
    """Flux texte borné : garde le début et la fin, compte ce qui tombe entre les deux.

    Remplace sys.stdout et sys.stderr du noyau : un `print` de 50 Mo ne doit pas
    remplir la mémoire avant d'être coupé.
    """

    def __init__(self, limite: int) -> None:
        self.moitie = max(limite // 2, 1)
        self.debut: List[str] = []
        self.taille_debut = 0
        self.fin = ""
        self.retires = 0

    def write(self, texte: str) -> int:
        n = len(texte)
        place = self.moitie - self.taille_debut
        if place > 0:
            self.debut.append(texte[:place])
            self.taille_debut += min(place, n)
            texte = texte[place:]
        if texte:
            self.fin += texte
            if len(self.fin) > self.moitie:
                self.retires += len(self.fin) - self.moitie
                self.fin = self.fin[-self.moitie:]
        return n

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        return False

    def valeur(self) -> str:
        debut = "".join(self.debut)
        if self.retires:
            return debut + marqueur(self.retires) + self.fin
        return debut + self.fin

"""Sorties bornées : ce que le modèle relit ne doit jamais être un vidage brut."""
from __future__ import annotations

import re
from typing import List, Optional, Tuple

MAX_SORTIE = 4000
# Lignes gardées en priorité quand une sortie est coupée : erreurs et échecs de tests.
ERREUR = re.compile(r"Traceback|error|FAIL|panicked|assert", re.IGNORECASE)
# Parts de la place gardée : début de la sortie, puis lignes d'erreur au plus ; le reste va à la fin.
PART_DEBUT = 0.2
PART_ERREURS = 0.4
FIN_ERREURS = "[…]\n"
# Sortie entière d'une cellule, gardée dans `_output` du noyau (et `_sortie`, ancien nom) : bornée quand même (mémoire).
COMPLET_MAX = 1_000_000
TRACEBACK_LIGNES = 15
DANS_SORTIE = ", full text in _output"
# Textes rendus par les outils de lecture pendant la cellule (liste posée par l'amorce dans l'espace du noyau) ; ceux
# qui s'affichent s'ajoutent à la limite de la cellule, jusqu'à PLACE_MAX caractères. `__room_ok__` l'annonce.
PLACE = "__room__"
PLACE_OK = "__room_ok__"
PLACE_MAX = 32_000
PLACE_TEXTES = 64
# Ligne plus longue que LIGNE_MAX dans une sortie à couper : son début et sa fin seulement, la ligne entière dans `_output`.
LIGNE_MAX = 300
LIGNE_DEBUT = 200
LIGNE_FIN = 40


def passages_demandes(textes: object, sortie: str) -> List[Tuple[int, int]]:
    """Positions (début, fin), dans l'ordre et sans chevauchement, des `textes` (PLACE_TEXTES au plus) affichés dans
    `sortie`."""
    if not isinstance(textes, list):
        return []
    passages: List[Tuple[int, int]] = []
    for texte in dict.fromkeys(texte for texte in textes[:PLACE_TEXTES] if isinstance(texte, str) and texte):
        debut = sortie.find(texte)
        while debut >= 0 and any(debut < fin and debut + len(texte) > autre for autre, fin in passages):
            debut = sortie.find(texte, debut + 1)
        if debut >= 0:
            passages.append((debut, debut + len(texte)))
    return sorted(passages)


def raccourcit_lignes(texte: str, premiere_ligne: int = 1, indice: str = "") -> str:
    """Chaque ligne de plus de LIGNE_MAX caractères réduite à son début et sa fin ; avec `indice`, la marque donne la
    ligne entière (`_output.splitlines()[n]`, `premiere_ligne` étant le numéro de la première ligne de `texte`)."""
    lignes = texte.split("\n")
    for rang, ligne in enumerate(lignes):
        if len(ligne) > LIGNE_MAX:
            ou = f": _output.splitlines()[{premiere_ligne + rang - 1}]" if indice else ""
            lignes[rang] = (f"{ligne[:LIGNE_DEBUT]} [… {len(ligne) - LIGNE_DEBUT - LIGNE_FIN} characters of this line "
                            f"removed{ou} …] {ligne[-LIGNE_FIN:]}")
    return "\n".join(lignes)


def parts(budget: int, tailles: List[int]) -> List[int]:
    """`budget` partagé : chacun reçoit au plus sa taille, le reste à parts égales entre les plus grands."""
    resultat = [0] * len(tailles)
    reste = budget
    ordre = sorted(range(len(tailles)), key=tailles.__getitem__)
    for rang, i in enumerate(ordre):
        resultat[i] = min(tailles[i], reste // (len(ordre) - rang))
        reste -= resultat[i]
    return resultat


def borne(sortie: str, limite: int, textes: object, indice: str = "") -> Tuple[str, int]:
    """Sortie d'une cellule ramenée à `limite` caractères plus la marge des textes demandés (rendus par les outils de
    lecture, `__room__`) qu'elle affiche : ceux-là restent entiers (PLACE_MAX au plus), seule la sortie incidente est
    coupée, ses lignes trop longues raccourcies d'abord. Rend la sortie et sa marge."""
    passages = passages_demandes(textes, sortie)
    marge = sum(fin - debut for debut, fin in passages)
    if marge > PLACE_MAX:
        passages, marge = [], PLACE_MAX
    if len(sortie) <= limite + marge:
        return sortie, marge
    morceaux: List[Tuple[str, bool, int]] = []  # texte, demandé, numéro de sa première ligne
    position = 0
    for debut, fin in passages + [(len(sortie), len(sortie))]:
        if debut > position:
            premiere = ligne_de(sortie, position)
            morceaux.append((raccourcit_lignes(sortie[position:debut], premiere, indice), False, premiere))
        if fin > debut:
            morceaux.append((sortie[debut:fin], True, ligne_de(sortie, debut)))
        position = fin
    libres = [rang for rang, (_, demande, _) in enumerate(morceaux) if not demande]
    for rang, budget in zip(libres, parts(limite, [len(morceaux[rang][0]) for rang in libres])):
        texte, _, premiere = morceaux[rang]
        morceaux[rang] = (tronque(texte, budget, indice, premiere), False, premiere)
    resultat = "".join(texte for texte, _, _ in morceaux)
    return resultat, max(marge, len(resultat) - limite)


def marge_valide(marge: object) -> int:
    """Marge annoncée par le worker, ramenée entre 0 et PLACE_MAX."""
    return min(marge, PLACE_MAX) if type(marge) is int and marge > 0 else 0


def marqueur(retires: int, indice: str = "", lignes: Optional[Tuple[int, int]] = None) -> str:
    """Marque d'une coupe ; avec `indice` (texte entier gardé ailleurs), les lignes coupées et leur tranche
    `_output.splitlines()[a:b]`, à lire sans relancer la commande."""
    if indice and lignes is not None:
        premiere, derniere = lignes
        return (f"\n[… {retires} characters removed{indice}: lines {premiere}-{derniere} are "
                f"_output.splitlines()[{premiere - 1}:{derniere}] …]\n")
    return f"\n[… {retires} characters removed{indice} …]\n"


def ligne_de(texte: str, position: int) -> int:
    return texte.count("\n", 0, position) + 1


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


def tronque(texte: str, maximum: int = MAX_SORTIE, indice: str = "", premiere_ligne: int = 1) -> str:
    """Quand `texte` dépasse `maximum` caractères : garde son début, ses lignes d'erreur (Traceback, error, FAIL,
    panicked, assert) en priorité, puis sa fin, la plus longue possible ; sans erreur au milieu, début et fin à parts
    égales. Les numéros de ligne de la marque partent de `premiere_ligne` (morceau d'une sortie plus longue)."""
    if len(texte) <= maximum:
        return texte
    indice_erreurs = f"{indice}; error lines kept"
    decalage = premiere_ligne - 1
    pire = (texte.count("\n") + premiere_ligne,) * 2  # numéros de ligne les plus longs : place de la marque au plus juste
    place = max(maximum - len(marqueur(len(texte), indice_erreurs, pire)) - len(FIN_ERREURS), 2)
    tete = int(place * PART_DEBUT)
    queue_min = place - tete - int(place * PART_ERREURS)
    erreurs, apres = erreurs_du_milieu(texte, tete, len(texte) - queue_min, place - tete - queue_min)
    if not erreurs:
        garde = max(maximum - len(marqueur(len(texte), indice, pire)), 2)
        debut = garde // 2
        fin = garde - debut
        lignes = (ligne_de(texte, debut) + decalage, ligne_de(texte, len(texte) - fin) + decalage)
        return texte[:debut] + marqueur(len(texte) - debut - fin, indice, lignes) + texte[-fin:]
    # La fin prend toute la place laissée par les erreurs, sans revenir sur la dernière ligne gardée.
    gardees = sum(map(len, erreurs))
    queue = min(place - tete - gardees, len(texte) - apres)
    retires = len(texte) - tete - queue - gardees
    lignes = (ligne_de(texte, tete) + decalage, ligne_de(texte, len(texte) - queue) + decalage)
    return (texte[:tete] + marqueur(retires, indice_erreurs, lignes) + "".join(erreurs) + FIN_ERREURS
            + texte[len(texte) - queue:])


def resume_traceback(tb: str, lignes: int = TRACEBACK_LIGNES) -> str:
    """Les `lignes` dernières lignes d'un traceback : l'erreur et ses appels les plus proches."""
    toutes = tb.rstrip("\n").splitlines()
    if len(toutes) <= lignes:
        return "\n".join(toutes)
    return "\n".join([f"[… {len(toutes) - lignes} lines …]"] + toutes[-lignes:])


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

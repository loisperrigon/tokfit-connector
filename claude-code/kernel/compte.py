"""Outil `compte` du serveur `outils` : bilan d'économie du client et limites de son compte (modèles et niveaux de
réflexion bloqués).

Lit (`GET /v1/account`) ou change (`POST /v1/account`, `block` / `unblock`) les limites
par le même lien que le paquet du noyau (relais d'une application hôte, ou adresse du
service et clé : `kernel/pack.py`). Le service valide les noms et applique les limites au
routage ; ici, seulement l'appel et un texte court. La clé n'apparaît jamais dans le texte.
Sans changement de limites (ou avec `bilan_depuis`), l'outil rend d'abord le bilan
(`GET /v1/bilan`, depuis l'installation ou depuis le jour `bilan_depuis`) : son champ `text`,
composé par le service, tel quel.

Bibliothèque standard seulement, Python 3.9+.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

from kernel.pack import TAILLE_MAX, Lien, demander

CHEMIN = "/v1/account"
CHEMIN_BILAN = "/v1/bilan"
JOUR = re.compile(r"\d{4}-\d{2}-\d{2}")
# Arguments de l'outil (noms des listes) et champs du service.
ARGUMENTS = {"bloquer": "block", "debloquer": "unblock"}


def schema() -> Dict[str, Any]:
    liste = {"type": "array", "items": {"type": "string"}}
    return {
        "name": "compte",
        "description": ("Bilan d'économie de tokfit et limites du compte. À appeler quand l'utilisateur demande "
                        "combien il a économisé (tokens, dollars) avec tokfit, depuis son installation ou depuis une "
                        "date. Sans argument : le bilan depuis l'installation, puis les limites ; `bilan_depuis` "
                        "(AAAA-MM-JJ) : le bilan depuis ce jour. Limites : modèles Claude (haiku, sonnet, opus, fable) "
                        "et niveaux de réflexion (low, medium, high, xhigh, max) que le routage n'utilise jamais, sur "
                        "tout le compte ; `bloquer` / `debloquer` : listes de noms."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "bilan_depuis": {"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
                                 "description": "Facultatif : début du bilan (AAAA-MM-JJ) ; absent : depuis l'installation."},
                "bloquer": {**liste, "description": "Noms à bloquer (modèles ou niveaux de réflexion)."},
                "debloquer": {**liste, "description": "Noms à débloquer."},
            },
        },
    }


def noms(valeur: object) -> Optional[List[str]]:
    """Une liste de noms (un nom seul est accepté) ; None si l'argument est mal formé."""
    if valeur is None:
        return []
    if isinstance(valeur, str):
        return [valeur]
    if isinstance(valeur, list) and all(isinstance(nom, str) for nom in valeur):
        return list(valeur)
    return None


def liste(valeurs: object, vide: str) -> str:
    return ", ".join(v for v in valeurs if isinstance(v, str)) if isinstance(valeurs, list) and valeurs else vide


def resume(reponse: object) -> Optional[str]:
    """Texte des limites rendues par le service ; None si la réponse n'a pas la forme attendue."""
    if not isinstance(reponse, dict):
        return None
    champs = [reponse.get(nom) for nom in ("blocked_models", "blocked_efforts", "models", "efforts")]
    if not all(isinstance(champ, list) for champ in champs):
        return None
    modeles, efforts, tous_modeles, tous_efforts = champs
    assert isinstance(modeles, list) and isinstance(efforts, list)
    assert isinstance(tous_modeles, list) and isinstance(tous_efforts, list)
    permis_modeles = [nom for nom in tous_modeles if nom not in modeles]
    permis_efforts = [nom for nom in tous_efforts if nom not in efforts]
    return (f"Modèles bloqués : {liste(modeles, 'aucun')} (autorisés : {liste(permis_modeles, 'aucun')}).\n"
            f"Réflexion bloquée : {liste(efforts, 'aucune')} (autorisée : {liste(permis_efforts, 'aucune')}).")


def refus(erreur: urllib.error.HTTPError) -> str:
    """Le message d'erreur du service (422 : noms valides compris), sans rien d'autre de la réponse."""
    try:
        detail = json.loads(erreur.read(TAILLE_MAX)).get("error")
    except (OSError, ValueError, AttributeError):
        detail = None
    finally:
        erreur.close()
    if erreur.code == 401:
        return "Refusé : clé du service absente, inconnue ou révoquée."
    return f"Refusé : {detail}" if isinstance(detail, str) else f"Refusé par le service ({erreur.code})."


def bilan(vers: Lien, depuis: Optional[str]) -> str:
    """Texte du bilan composé par le service ; une phrase d'excuse s'il manque (les limites restent rendues)."""
    chemin = CHEMIN_BILAN + ("?" + urllib.parse.urlencode({"since": depuis}) if depuis else "")
    try:
        reponse = demander(vers, chemin)
    except urllib.error.HTTPError as erreur:
        return f"Bilan indisponible : {refus(erreur)}"
    except (OSError, ValueError) as erreur:
        return f"Bilan indisponible : service injoignable ({type(erreur).__name__})."
    texte = reponse.get("text") if isinstance(reponse, dict) else None
    return texte if isinstance(texte, str) and texte.strip() else "Bilan indisponible : réponse illisible du service."


def compte(vers: Optional[Lien], arguments: Dict[str, Any]) -> Tuple[str, bool]:
    """(texte, erreur) pour un appel de l'outil."""
    if vers is None:
        return "Service non configuré : aucun bilan ni limite de compte à lire ou changer.", True
    depuis = arguments.get("bilan_depuis")
    if depuis is not None and not (isinstance(depuis, str) and JOUR.fullmatch(depuis)):
        return "Argument `bilan_depuis` : date AAAA-MM-JJ attendue.", True
    corps: Dict[str, List[str]] = {}
    for argument, champ in ARGUMENTS.items():
        valeur = noms(arguments.get(argument))
        if valeur is None:
            return f"Argument `{argument}` : liste de noms attendue.", True
        if valeur:
            corps[champ] = valeur
    try:
        reponse = demander(vers, CHEMIN, corps if corps else None)
    except urllib.error.HTTPError as erreur:
        return refus(erreur), True
    except (OSError, ValueError) as erreur:
        return f"Service injoignable ({type(erreur).__name__}) : limites inchangées.", True
    texte = resume(reponse)
    if texte is None:
        return "Réponse illisible du service.", True
    limites = f"Limites enregistrées.\n{texte}" if corps else texte
    if corps and depuis is None:
        return limites, False
    return f"{bilan(vers, depuis)}\n{limites}", False

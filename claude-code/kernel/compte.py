"""Outil `compte` du serveur `outils` : bilan d'économie du client et limites de son compte (modèles et niveaux de
réflexion bloqués).

Lit (`GET /v1/account`) ou change (`POST /v1/account`, `block` / `unblock`) les limites
par le même lien que le paquet du noyau (relais d'une application hôte, ou adresse du
service et clé : `kernel/pack.py`). Le service valide les noms et applique les limites au
routage ; ici, seulement l'appel et un texte court. La clé n'apparaît jamais dans le texte.
Sans changement de limites (ou avec `since`), l'outil rend d'abord le bilan
(`GET /v1/bilan`, depuis l'installation ou depuis le jour `since`) : son champ `text`,
composé par le service pour une personne qui n'est pas du métier, tel quel. Les limites ne
suivent que si quelque chose est bloqué, si elles sont demandées (`limits`) ou après un
changement. La description de l'outil dit à l'agent comment présenter ce texte (`PRESENTATION`).

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
# Arguments de l'outil (noms des listes) et champs du service ; les noms français d'avant le 16/11/2026
# restent acceptés (`ANCIENS`).
ARGUMENTS = {"block": "block", "unblock": "unblock"}
ANCIENS = {"bilan_depuis": "since", "limites": "limits", "bloquer": "block", "debloquer": "unblock"}


# Règle de présentation, dans la description de l'outil : le texte du bilan est écrit pour une personne qui n'est pas
# du métier, l'agent le rend sans le recomposer, dans la langue de l'utilisateur.
PRESENTATION = ("Presenting it to the user: give back the returned text as is or nearly, in short sentences, in the "
                "user's language (translate it if needed). No technical terms (tokens, model, bench, routing, "
                "thinking, cache, lever); the amounts are estimates: say \"about\". Add no calculation, detail or list "
                "of limits that the text does not give.")


def schema() -> Dict[str, Any]:
    liste = {"type": "array", "items": {"type": "string"}}
    return {
        "name": "compte",
        "description": ("tokfit savings report and account limits. Call it when the user asks how much they saved "
                        "with tokfit, since installing it or since a date. Without arguments: the report since "
                        "installation; `since` (YYYY-MM-DD): the report since that day. The limits (Claude models "
                        "haiku, sonnet, opus, fable and thinking levels low, medium, high, xhigh, max that tokfit "
                        "never uses, account-wide) are returned only if something is blocked, with `limits` (only if "
                        "the user asks for them) or after `block` / `unblock` (lists of names). " + PRESENTATION),
        "inputSchema": {
            "type": "object",
            "properties": {
                "since": {"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
                          "description": "Optional: start of the report (YYYY-MM-DD); absent: since installation."},
                "limits": {"type": "boolean",
                           "description": "Optional: true to also return the account limits, even if nothing is "
                                          "blocked (only if the user asks for them)."},
                "block": {**liste, "description": "Names to block (models or thinking levels)."},
                "unblock": {**liste, "description": "Names to unblock."},
            },
        },
    }


def arguments_lus(arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Les arguments sous leurs noms anglais (un ancien nom français ne remplace pas le nom anglais donné)."""
    lus = dict(arguments)
    for ancien, nouveau in ANCIENS.items():
        if ancien in lus and nouveau not in lus:
            lus[nouveau] = lus.pop(ancien)
    return lus


def noms(valeur: object) -> Optional[List[str]]:
    """Une liste de noms (un nom seul est accepté) ; None si l'argument est mal formé."""
    if valeur is None:
        return []
    if isinstance(valeur, str):
        return [valeur]
    if isinstance(valeur, list) and all(isinstance(nom, str) for nom in valeur):
        return list(valeur)
    return None


def liste(valeurs: List[Any], majuscule: bool = False) -> str:
    noms_lus = [v for v in valeurs if isinstance(v, str)]
    return ", ".join(nom.capitalize() if majuscule else nom for nom in noms_lus) or "none"


def resume(reponse: object, toujours: bool) -> Optional[str]:
    """Texte des limites rendues par le service, en clair : une ligne par sorte de limite qui bloque quelque chose ;
    rien (\"\") si rien n'est bloqué, sauf `toujours` (limites demandées ou changées). None si la réponse n'a pas la
    forme attendue."""
    if not isinstance(reponse, dict):
        return None
    champs = [reponse.get(nom) for nom in ("blocked_models", "blocked_efforts", "models", "efforts")]
    if not all(isinstance(champ, list) for champ in champs):
        return None
    modeles, efforts, tous_modeles, tous_efforts = champs
    assert isinstance(modeles, list) and isinstance(efforts, list)
    assert isinstance(tous_modeles, list) and isinstance(tous_efforts, list)
    lignes = []
    if modeles:
        permis = [nom for nom in tous_modeles if nom not in modeles]
        lignes.append(f"Claude models tokfit never uses for you: {liste(modeles, True)} "
                      f"(still used: {liste(permis, True)}).")
    if efforts:
        permis = [nom for nom in tous_efforts if nom not in efforts]
        lignes.append(f"Thinking levels tokfit never uses for you: {liste(efforts)} "
                      f"(still used: {liste(permis)}).")
    if not lignes and toujours:
        lignes.append("Nothing is blocked: tokfit may use every Claude model and every thinking level.")
    return "\n".join(lignes)


def refus(erreur: urllib.error.HTTPError) -> str:
    """Le message d'erreur du service (422 : noms valides compris), sans rien d'autre de la réponse."""
    try:
        detail = json.loads(erreur.read(TAILLE_MAX)).get("error")
    except (OSError, ValueError, AttributeError):
        detail = None
    finally:
        erreur.close()
    if erreur.code == 401:
        return "Refused: service key missing, unknown or revoked."
    return f"Refused: {detail}" if isinstance(detail, str) else f"Refused by the service ({erreur.code})."


def bilan(vers: Lien, depuis: Optional[str]) -> str:
    """Texte du bilan composé par le service ; une phrase d'excuse s'il manque (les limites restent rendues)."""
    chemin = CHEMIN_BILAN + ("?" + urllib.parse.urlencode({"since": depuis}) if depuis else "")
    try:
        reponse = demander(vers, chemin)
    except urllib.error.HTTPError as erreur:
        return f"Report unavailable: {refus(erreur)}"
    except (OSError, ValueError) as erreur:
        return f"Report unavailable: service unreachable ({type(erreur).__name__})."
    texte = reponse.get("text") if isinstance(reponse, dict) else None
    return texte if isinstance(texte, str) and texte.strip() else "Report unavailable: unreadable service response."


def compte(vers: Optional[Lien], arguments: Dict[str, Any]) -> Tuple[str, bool]:
    """(texte, erreur) pour un appel de l'outil."""
    if vers is None:
        return "Service not configured: no report or account limits to read or change.", True
    arguments = arguments_lus(arguments)
    depuis = arguments.get("since")
    if depuis is not None and not (isinstance(depuis, str) and JOUR.fullmatch(depuis)):
        return "Argument `since`: YYYY-MM-DD date expected.", True
    corps: Dict[str, List[str]] = {}
    for argument, champ in ARGUMENTS.items():
        valeur = noms(arguments.get(argument))
        if valeur is None:
            return f"Argument `{argument}`: list of names expected.", True
        if valeur:
            corps[champ] = valeur
    try:
        reponse = demander(vers, CHEMIN, corps if corps else None)
    except urllib.error.HTTPError as erreur:
        return refus(erreur), True
    except (OSError, ValueError) as erreur:
        return f"Service unreachable ({type(erreur).__name__}): limits unchanged.", True
    demandees = arguments.get("limits") is True
    texte = resume(reponse, bool(corps) or demandees)
    if texte is None:
        return "Unreadable service response.", True
    limites = f"Done.\n{texte}" if corps else texte
    if corps and depuis is None:
        return limites, False
    return "\n".join(morceau for morceau in (bilan(vers, depuis), limites) if morceau), False

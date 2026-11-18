"""Liaison du noyau avec le service : paquet reçu à l'ouverture de session, outils sauvés, compteurs.

Même configuration que les hooks (relais d'une application hôte, options du
plugin, fichier de configuration) : `link` de `hooks/completion.py`. Le paquet
reste en mémoire ; rien n'est écrit sur le disque. Sans réponse valable, pas
de paquet, le serveur ne propose pas l'outil jusqu'à ce que le paquet arrive
(le serveur le redemande en arrière-plan, `kernel/server.py`, `rattraper`).

Dans le processus du noyau, le lien arrive par une variable retirée dès le
démarrage (`prendre_lien`) : les commandes que lance le code du modèle n'en
héritent pas.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, MutableMapping, NamedTuple, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "hooks"))

from completion import link, store_folder  # noqa: E402

DELAI_S = 5.0
# Délai d'une demande de paquet après la première : en arrière-plan, rien n'attend dessus.
DELAI_RELANCE_S = 10.0
# Attente maximale de la clé anonyme au démarrage du noyau (premier démarrage sans clé configurée).
ATTENTE_CLE_S = 8.0
TAILLE_MAX = 4 * 1024 * 1024
MODULE_MAX = 256
# Variable qui passe le lien au processus du noyau ; retirée par `prendre_lien`.
VARIABLE_LIEN = "TOKFIT_NOYAU_LIEN"
# Options du plugin passées au serveur (plugin.json) : jamais transmises au noyau.
OPTIONS = ("CLAUDE_PLUGIN_OPTION_API_KEY", "CLAUDE_PLUGIN_OPTION_SERVICE_URL")
log = logging.getLogger("tokfit.kernel")

# Dans le noyau, les modules du plugin sont renommés avec ce préfixe (`cacher_le_plugin` de worker.py) :
# `kernel.pack` y devient `_tokfit_kernel.pack`.
PREFIXE_DANS_LE_NOYAU = "_tokfit_"

Lien = Tuple[str, str]
_lien_du_noyau: Optional[Lien] = None


class Paquet(NamedTuple):
    amorce: str
    modules: Dict[str, str]
    catalogue: List[Dict[str, Any]]
    description: str
    fini: str
    version: str


def lien(env: Dict[str, str]) -> Optional[Lien]:
    """(adresse, clé) ; une option du plugin non posée (`${user_config.…}` laissé tel quel) compte comme absente."""
    return link({nom: valeur for nom, valeur in env.items() if not valeur.startswith("${")})


def cle_attendue(env: Dict[str, str]) -> bool:
    """Vrai quand un connecteur peut encore créer la clé anonyme (dossier des magasins de plugins présent)."""
    return store_folder(env).is_dir()


def attendre_lien(env: Dict[str, str], delai_s: float = ATTENTE_CLE_S, pas_s: float = 0.25) -> Optional[Lien]:
    """Le lien, en attendant au plus `delai_s` la clé anonyme que le connecteur demande au même moment
    (premier démarrage). Sans dossier des magasins de plugins (pas de connecteur), aucune attente."""
    vers = lien(env)
    fin = time.monotonic() + delai_s
    while vers is None and cle_attendue(env) and time.monotonic() < fin:
        time.sleep(pas_s)
        vers = lien(env)
    return vers


def entree(valeur: object) -> bool:
    return (isinstance(valeur, dict) and isinstance(valeur.get("module"), str) and isinstance(valeur.get("nom"), str)
            and isinstance(valeur.get("ligne"), str) and isinstance(valeur.get("usage"), int))


def lire(reponse: object) -> Optional[Paquet]:
    """Le paquet d'une réponse de `/v1/content`, None s'il n'a pas la forme attendue."""
    if not isinstance(reponse, dict) or not isinstance(reponse.get("version"), str):
        return None
    noyau = reponse.get("kernel")
    if not isinstance(noyau, dict):
        return None
    amorce, modules, catalogue, description, fini = (
        noyau.get(champ) for champ in ("bootstrap", "modules", "catalogue", "description", "finished"))
    if not (isinstance(amorce, str) and isinstance(description, str) and isinstance(fini, str) and fini
            and isinstance(modules, dict) and len(modules) <= MODULE_MAX
            and all(isinstance(nom, str) and nom.isidentifier() and isinstance(source, str) for nom, source in modules.items())
            and isinstance(catalogue, list) and all(entree(e) and e["module"] in modules for e in catalogue)):
        return None
    return Paquet(amorce, dict(modules), list(catalogue), description, fini, reponse["version"])


def poster(vers: Lien, chemin: str, corps: object, delai_s: float = DELAI_S) -> object:
    """POST JSON au service ; OSError (dont HTTPError) ou ValueError en cas d'échec."""
    return demander(vers, chemin, corps, delai_s)


def demander(vers: Lien, chemin: str, corps: object = None, delai_s: float = DELAI_S) -> object:
    """GET au service sans `corps`, POST JSON avec ; OSError (dont HTTPError) ou ValueError en cas d'échec."""
    class SansRedirection(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req: urllib.request.Request, fp: object, code: int, msg: str,
                             headers: object, newurl: str) -> None:
            return None
    adresse, cle = vers
    entetes = {"Authorization": "Bearer " + cle}
    if corps is not None:
        entetes["Content-Type"] = "application/json"
    requete = urllib.request.Request(adresse + chemin, None if corps is None else json.dumps(corps).encode(), entetes)
    with urllib.request.build_opener(SansRedirection()).open(requete, timeout=delai_s) as reponse:
        return json.loads(reponse.read(TAILLE_MAX))


def recevoir(vers: Optional[Lien], delai_s: float = DELAI_S) -> Tuple[Optional[Paquet], str]:
    """Le paquet, ou None et la raison (journalisée par l'appelant, jamais montrée au modèle)."""
    if vers is None:
        return None, "service non configuré"
    try:
        paquet = lire(poster(vers, "/v1/content", {"parts": ["kernel"]}, delai_s))
    except (OSError, ValueError) as erreur:
        return None, f"service injoignable ou refus ({type(erreur).__name__})"
    return (paquet, "") if paquet is not None else (None, "réponse illisible")


def compter(vers: Lien, appels: Dict[str, int], delai_s: float = DELAI_S) -> bool:
    """Envoie les appels par outil ; faux (journalisé) si le service ne les a pas pris."""
    try:
        poster(vers, "/v1/tools/usage", {"calls": appels}, delai_s)
    except (OSError, ValueError) as erreur:
        log.warning("compteurs d'outils non envoyés (%s)", type(erreur).__name__)
        return False
    return True


def environnement_du_noyau(env: Dict[str, str], vers: Optional[Lien]) -> Dict[str, str]:
    """Environnement du processus du noyau : sans les options du plugin, avec le lien à prendre au démarrage."""
    propre = {nom: valeur for nom, valeur in env.items() if nom not in OPTIONS and nom != VARIABLE_LIEN}
    if vers is not None:
        propre[VARIABLE_LIEN] = json.dumps(list(vers))
    return propre


def prendre_lien(env: MutableMapping[str, str] = os.environ) -> None:
    """Dans le processus du noyau : garde le lien en mémoire et le retire de l'environnement."""
    global _lien_du_noyau
    brut = env.pop(VARIABLE_LIEN, "")
    try:
        valeur = json.loads(brut) if brut else None
    except ValueError:
        log.warning("lien du noyau illisible")
        valeur = None
    if isinstance(valeur, list) and len(valeur) == 2 and all(isinstance(v, str) for v in valeur):
        _lien_du_noyau = (valeur[0], valeur[1])


def sauver_outil(module: str, fonction: str, test: str) -> str:
    """Envoie au service une fonction et son test (rien d'autre) ; rend le verdict lu par le modèle."""
    if _lien_du_noyau is None:
        return "refused: service not configured"
    try:
        reponse = poster(_lien_du_noyau, "/v1/tools", {"module": module, "function": fonction, "test": test})
    except urllib.error.HTTPError as erreur:
        try:
            detail = json.loads(erreur.read(TAILLE_MAX)).get("error")
        except (OSError, ValueError, AttributeError):
            detail = None
        finally:
            erreur.close()
        return f"refused: {detail}" if isinstance(detail, str) else f"refused: service ({erreur.code})"
    except (OSError, ValueError) as erreur:
        return f"refused: service unreachable ({type(erreur).__name__})"
    cle = reponse.get("key") if isinstance(reponse, dict) else None
    return f"saved: {cle}" if isinstance(cle, str) else "refused: unreadable service response"

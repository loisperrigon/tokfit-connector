#!/usr/bin/env python3
"""Serveur MCP stdio du levier `kernel` : l'outil `python`, et l'outil `compte`.

Déclaré par le plugin (`mcpServers.outils` de plugin.json) et lancé par Claude
Code. Le protocole minimal suffit : `initialize`, `tools/list`, `tools/call`,
`ping` ; une ligne JSON par message, rien d'autre sur stdout (journal sur
stderr). Au démarrage, le paquet du noyau (amorce, modules des outils,
catalogue, description de l'outil, marqueur de fin) est demandé au service
(`kernel/pack.py`) et gardé en mémoire : l'amorce et les outils s'exécutent
dans le noyau depuis les chaînes reçues, sans fichier. Sans paquet, le serveur
ne propose aucun outil (le levier reste inactif, `kernel_unavailable` côté
connecteur). Les appels d'outils comptés dans le noyau partent au service en
compteurs, après chaque cellule et à l'arrêt.
L'outil `compte` (`kernel/compte.py`) rend le bilan d'économie du client et lit
ou change les limites de son compte (modèles et niveaux de réflexion bloqués) ; il est proposé dès qu'un
lien vers le service existe, paquet reçu ou non.
Une cellule qui appelle `fini(resume)` et se termine sans exception ajoute au
résultat un second bloc texte : le marqueur du paquet suivi du résumé (lu par
le connecteur).

Un noyau par agent : le fil principal et chaque sous-agent ont le leur
(répertoire courant, variables, modules), jamais partagé. Le connecteur
(`hooks/kernel.ts`, `withAgent`) ajoute à chaque appel de `python` l'argument
`agent`, identifiant de la boucle (`main` pour le fil principal) ; un appel
sans cet argument va au noyau du fil principal. Les appels de `python`
tournent chacun dans un fil : deux agents travaillent en même temps, un même
agent un appel à la suite de l'autre. Au-delà de `TOKFIT_KERNEL_MAX_AGENTS`
noyaux (8 par défaut), celui du sous-agent inactif depuis le plus longtemps est
arrêté ; s'il revient, on le prévient que son état est perdu.

Bibliothèque standard seulement, Python 3.9+.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kernel.compte import compte, schema as schema_compte  # noqa: E402
from kernel.kernel import Noyau  # noqa: E402
from kernel.output import MAX_SORTIE  # noqa: E402
from kernel.pack import Lien, Paquet, attendre_lien, compter, lien, recevoir  # noqa: E402

NOM = "outils"
VERSION = "1.0.0"
PROTOCOLES = ("2025-06-18", "2025-03-26", "2024-11-05")
TIMEOUT_DEFAUT = 120
TIMEOUT_MAX = 600
ARRET_S = 2.0
# Argument que le connecteur ajoute à chaque appel de `python` : l'identifiant de la boucle.
AGENT = "agent"
PRINCIPAL = "main"
AGENT_LONGUEUR_MAX = 128
NOYAUX_MAX = 8
LIBERE = "[noyau de cet agent arrêté après inactivité, d'autres agents travaillaient : état perdu]\n"
log = logging.getLogger("tokfit.kernel")


def entier(env: Dict[str, str], nom: str, defaut: int) -> int:
    brut = env.get(nom, "").strip()
    if not brut:
        return defaut
    try:
        valeur = int(brut)
    except ValueError:
        log.warning("%s illisible (%r) : %s par défaut", nom, brut, defaut)
        return defaut
    return valeur if valeur > 0 else defaut


def code_amorce(paquet: Paquet) -> str:
    """Cellule de démarrage : l'amorce reçue exécutée dans un module en mémoire, qui charge les outils."""
    return ("import sys as _s, types as _t\n"
            "from kernel.pack import sauver_outil as _sauver\n"
            "_m = _t.ModuleType('noyau_amorce')\n"
            "_s.modules['noyau_amorce'] = _m\n"
            f"exec(compile({paquet.amorce!r}, '<amorce>', 'exec'), _m.__dict__)\n"
            f"_m.charger(globals(), {paquet.modules!r}, {paquet.catalogue!r}, _sauver)\n"
            "del _s, _t, _m, _sauver")


class Compteur:
    """Appels par outil en attente d'envoi ; un envoi raté les garde pour le suivant."""

    def __init__(self, vers: Optional[Lien]) -> None:
        self.vers = vers
        self.attente: Counter[str] = Counter()
        self.verrou = threading.Lock()
        self.envois: list[threading.Thread] = []

    def ajouter(self, appels: Dict[str, int]) -> None:
        with self.verrou:
            self.attente.update(appels)
            self.envois = [envoi for envoi in self.envois if envoi.is_alive()]
            envoi = threading.Thread(target=self.envoyer, name="compteurs-outils", daemon=True)
            self.envois.append(envoi)
        envoi.start()

    def envoyer(self, delai_s: float = 5.0) -> None:
        with self.verrou:
            lot = dict(self.attente)
            self.attente.clear()
        if not lot or self.vers is None:
            return
        if not compter(self.vers, lot, delai_s):
            with self.verrou:
                self.attente.update(lot)

    def finir(self, delai_s: float) -> None:
        """À l'arrêt : attend les envois en cours, puis envoie le reste."""
        with self.verrou:
            envois = list(self.envois)
        for envoi in envois:
            envoi.join(delai_s)
        self.envoyer(delai_s)


def schema_outil(description: str) -> Dict[str, Any]:
    return {
        "name": "python",
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "Code Python ; la valeur de la dernière expression est affichée."},
                "timeout_s": {"type": "integer", "description": "Délai en secondes (120 par défaut, 600 au plus).",
                              "minimum": 1, "maximum": TIMEOUT_MAX},
                AGENT: {"type": "string", "description": "Rempli par le connecteur : ne pas le donner."},
            },
            "required": ["code"],
        },
    }


def agent_de(arguments: Dict[str, Any]) -> str:
    """L'agent qui appelle (argument posé par le connecteur) ; le fil principal sans identifiant lisible."""
    valeur = arguments.get(AGENT)
    if isinstance(valeur, str) and 0 < len(valeur) <= AGENT_LONGUEUR_MAX and valeur.isprintable():
        return valeur
    return PRINCIPAL


@dataclass
class Poste:
    """Le noyau d'un agent : un appel à la fois (`verrou`) ; `appels` en cours ou en attente le protègent de l'arrêt."""
    noyau: Noyau
    verrou: threading.Lock = field(default_factory=threading.Lock)
    demarre: bool = False
    appels: int = 0
    dernier: float = 0.0


class Serveur:
    def __init__(self, env: Dict[str, str], paquet: Optional[Paquet], vers: Optional[Lien] = None) -> None:
        self.max_sortie = entier(env, "TOKFIT_KERNEL_MAX_OUTPUT", MAX_SORTIE)
        self.noyaux_max = entier(env, "TOKFIT_KERNEL_MAX_AGENTS", NOYAUX_MAX)
        self.env = env
        self.vers = vers
        self.paquet = paquet
        self.compteur = Compteur(vers)
        self.description = paquet.description if paquet is not None else ""
        self.amorce = code_amorce(paquet) if paquet is not None else None
        self.cwd = os.getcwd()
        self.postes: Dict[str, Poste] = {}
        self.liberes: set[str] = set()
        self.verrou = threading.Lock()

    def repondre(self, message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """La réponse JSON-RPC à un message ; None pour une notification."""
        methode = message.get("method")
        if "id" not in message:
            return None
        ident = message["id"]
        if methode == "initialize":
            demande = (message.get("params") or {}).get("protocolVersion")
            version = demande if demande in PROTOCOLES else PROTOCOLES[0]
            return self.resultat(ident, {"protocolVersion": version, "capabilities": {"tools": {}},
                                         "serverInfo": {"name": NOM, "version": VERSION}})
        if methode == "ping":
            return self.resultat(ident, {})
        if methode == "tools/list":
            outils = [schema_outil(self.description)] if self.amorce is not None else []
            if self.lien() is not None:
                outils.append(schema_compte())
            return self.resultat(ident, {"tools": outils})
        if methode == "tools/call":
            return self.appel(ident, message.get("params") or {})
        return {"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": f"méthode inconnue : {methode}"}}

    @staticmethod
    def en_parallele(message: Dict[str, Any]) -> bool:
        """Vrai pour un appel de `python`, qui peut durer : il tourne dans son propre fil."""
        params = message.get("params")
        return (message.get("method") == "tools/call" and "id" in message
                and isinstance(params, dict) and params.get("name") == "python")

    def lien(self) -> Optional[Lien]:
        """Le lien vers le service ; cherché de nouveau tant qu'il manque (clé anonyme arrivée après le démarrage)."""
        if self.vers is None:
            self.vers = lien(self.env)
        return self.vers

    def prendre(self, agent: str) -> tuple[Poste, bool]:
        """Le poste de l'agent, créé au besoin, réservé jusqu'à `rendre` ; vrai si son noyau avait été arrêté."""
        assert self.amorce is not None
        with self.verrou:
            poste = self.postes.get(agent)
            libere = False
            if poste is None:
                poste = Poste(Noyau(self.amorce, self.max_sortie, self.cwd, self.vers))
                self.postes[agent] = poste
                libere = agent in self.liberes
                self.liberes.discard(agent)
                self.liberer_en_trop(agent)
            poste.appels += 1
            poste.dernier = time.monotonic()
            return poste, libere

    def rendre(self, poste: Poste) -> None:
        with self.verrou:
            poste.appels -= 1
            poste.dernier = time.monotonic()

    def liberer_en_trop(self, garde: str) -> None:
        """Au-delà du plafond, arrête les noyaux des sous-agents inactifs, le plus ancien d'abord (verrou tenu)."""
        libres = sorted((poste.dernier, agent) for agent, poste in self.postes.items()
                        if agent not in (garde, PRINCIPAL) and poste.appels == 0)
        while len(self.postes) > self.noyaux_max and libres:
            _, agent = libres.pop(0)
            self.postes.pop(agent).noyau.arreter()
            self.liberes.add(agent)

    def appel(self, ident: Any, params: Dict[str, Any]) -> Dict[str, Any]:
        if params.get("name") == "compte" and self.lien() is not None:
            arguments = params.get("arguments")
            texte, erreur = compte(self.vers, arguments if isinstance(arguments, dict) else {})
            return self.texte(ident, texte, erreur)
        if params.get("name") != "python" or self.amorce is None or self.paquet is None:
            return {"jsonrpc": "2.0", "id": ident, "error": {"code": -32602, "message": "outil inconnu"}}
        arguments = params.get("arguments") or {}
        code = arguments.get("code")
        if not isinstance(code, str):
            return self.texte(ident, "argument `code` manquant (texte)", erreur=True)
        delai = arguments.get("timeout_s", TIMEOUT_DEFAUT)
        delai = min(max(delai, 1), TIMEOUT_MAX) if isinstance(delai, int) and not isinstance(delai, bool) else TIMEOUT_DEFAUT
        poste, libere = self.prendre(agent_de(arguments))
        try:
            with poste.verrou:
                prefixe = LIBERE if libere else ""
                if not poste.demarre:
                    poste.demarre = True
                    prefixe += poste.noyau.demarrer()
                execution = poste.noyau.executer(code, delai)
        finally:
            self.rendre(poste)
        if execution.usage:
            self.compteur.ajouter(execution.usage)
        texte = (prefixe + execution.sortie) if prefixe else execution.sortie
        reponse = self.texte(ident, texte if texte.strip() else "(aucune sortie)", erreur=not execution.ok)
        if execution.ok and execution.fini is not None:
            # Contrat avec le connecteur (hooks) : second bloc, préfixe exact, jamais avec isError.
            reponse["result"]["content"].append({"type": "text", "text": self.paquet.fini + execution.fini})
        return reponse

    def fermer(self) -> None:
        """Fin de session : chaque noyau tué, même au milieu d'une cellule, et plus aucun redémarrage."""
        with self.verrou:
            postes = list(self.postes.values())
        for poste in postes:
            poste.noyau.fermer()

    def arreter(self) -> None:
        """Après `fermer` et la fin des appels en cours : libère tubes et dossiers des noyaux."""
        with self.verrou:
            postes = [poste for poste in self.postes.values() if poste.appels == 0]
        for poste in postes:
            poste.noyau.arreter()

    @staticmethod
    def resultat(ident: Any, valeur: Dict[str, Any]) -> Dict[str, Any]:
        return {"jsonrpc": "2.0", "id": ident, "result": valeur}

    def texte(self, ident: Any, texte: str, erreur: bool) -> Dict[str, Any]:
        return self.resultat(ident, {"content": [{"type": "text", "text": texte}], "isError": erreur})


class Sortie:
    """stdout du protocole : une ligne JSON par réponse, jamais deux fils à la fois."""

    def __init__(self) -> None:
        self.verrou = threading.Lock()

    def ecrire(self, reponse: Optional[Dict[str, Any]]) -> None:
        if reponse is None:
            return
        with self.verrou:
            sys.stdout.write(json.dumps(reponse, ensure_ascii=False) + "\n")
            sys.stdout.flush()


def main() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING, format="noyau: %(message)s")
    env = dict(os.environ)
    vers = attendre_lien(env)
    paquet, raison = recevoir(vers)
    if paquet is None:
        log.warning("paquet du noyau indisponible (%s) : outil python non proposé", raison)
    serveur = Serveur(env, paquet, vers)
    sortie = Sortie()
    appels: List[threading.Thread] = []
    try:
        for ligne in sys.stdin:
            if not ligne.strip():
                continue
            try:
                message = json.loads(ligne)
            except ValueError:
                sortie.ecrire({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "JSON illisible"}})
                continue
            if not isinstance(message, dict):
                continue
            if serveur.en_parallele(message):
                appel = threading.Thread(target=lambda m=message: sortie.ecrire(serveur.repondre(m)),
                                         name="appel-python", daemon=True)
                appels = [en_cours for en_cours in appels if en_cours.is_alive()] + [appel]
                appel.start()
            else:
                sortie.ecrire(serveur.repondre(message))
    finally:
        serveur.fermer()
        for appel in appels:
            appel.join(ARRET_S)
        serveur.arreter()
        serveur.compteur.finir(ARRET_S)


if __name__ == "__main__":
    main()

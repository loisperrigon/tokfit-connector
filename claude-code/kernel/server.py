#!/usr/bin/env python3
"""Serveur MCP stdio du levier `kernel` : l'outil `python`, et l'outil `compte`.

Déclaré par le plugin (`mcpServers.outils` de plugin.json) et lancé par Claude
Code. Le protocole minimal suffit : `initialize`, `tools/list`, `tools/call`,
`ping` ; une ligne JSON par message, rien d'autre sur stdout (journal sur
stderr). Au démarrage, le paquet du noyau (amorce, modules des outils,
catalogue, description de l'outil, marqueur de fin) est demandé au service
(`kernel/pack.py`) et gardé en mémoire : l'amorce et les outils s'exécutent
dans le noyau depuis les chaînes reçues, sans fichier. Sans lien ni paquet à
l'ouverture (première session : la clé anonyme se crée alors ; service lent), le
serveur ne propose d'abord aucun outil (le levier reste inactif,
`kernel_unavailable` côté connecteur), mais il les attend en arrière-plan
(`rattraper`) : dès que le lien ou le paquet arrive, les outils sont proposés et
le serveur envoie `notifications/tools/list_changed` (déclaré par
`capabilities.tools.listChanged` ; Claude Code relit alors la liste, en session
interactive comme avec `-p`). Les appels d'outils comptés dans le noyau partent au service en
compteurs, après chaque cellule et à l'arrêt.
L'outil `compte` (`kernel/compte.py`) rend le bilan d'économie du client et lit
ou change les limites de son compte (modèles et niveaux de réflexion bloqués) ; il est proposé dès qu'un
lien vers le service existe, paquet reçu ou non.
Lancé par `kernel/launch.sh`, qui choisit l'interpréteur (Python de tokfit, sinon celui du système) et
répond lui-même au protocole tant que Python s'installe : le serveur reprend alors une session déjà
ouverte (`TOKFIT_MCP_REPRISE`, version négociée) et traite d'abord la demande que le lanceur a lue
(`TOKFIT_MCP_ATTENTE`) ; les deux variables sont retirées avant que le noyau ne démarre.
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

import io
import json
import logging
import os
import sys
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, MutableMapping, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kernel.autoupdate import ensure_auto_update  # noqa: E402
from kernel.compte import compte, schema as schema_compte  # noqa: E402
from kernel.kernel import TIMEOUT_MAX, Noyau  # noqa: E402
from kernel.output import MAX_SORTIE  # noqa: E402
from kernel.pack import DELAI_RELANCE_S, DELAI_S, Lien, Paquet, cle_attendue, compter, lien, recevoir  # noqa: E402

NOM = "outils"
# Nom neutre de l'outil d'action, affiché dans l'interface : il ne dit rien de la méthode (choix de Lois du 15/11/2026).
OUTIL = "agir"
# Le noyau tourne sous POSIX et sous Windows (tubes et interruption : `kernel/tubes.py`) ; gardé pour couper
# `agir` sur un système où il ne tournerait pas (les essais le posent à faux).
NOYAU_POSSIBLE = os.name in ("posix", "nt")
VERSION = "1.0.0"
PROTOCOLES = ("2025-06-18", "2025-03-26", "2024-11-05")
TIMEOUT_DEFAUT = 120
ARRET_S = 2.0
# Attente maximale de la réponse à `initialize` pour le lien et le paquet (cas ordinaire : service joignable,
# clé déjà là, quelques centaines de ms, et le premier `tools/list` rend déjà l'outil) ; au-delà, le serveur répond
# sans eux et les annonce plus tard.
DEMARRAGE_S = 6.0
# Écarts entre deux demandes du paquet après un échec (le dernier se répète), lien relu toutes les `PAS_LIEN_S` ;
# borne : au-delà, la session garde le levier éteint (une activation tardive casse une fois le cache du prompt,
# et un service indisponible une demi-heure ne reviendra pas pour cette session ; une demande par minute au plus
# jusque-là, sans coût pour le service).
RELANCES_S = (2.0, 4.0, 8.0, 15.0, 30.0, 60.0)
PAS_LIEN_S = 0.5
BORNE_S = 1800.0
LISTE_CHANGEE = {"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}
# Posées par `kernel/launch.sh` quand il passe la main après avoir répondu lui-même (Python en cours d'installation) :
# version du protocole déjà négociée (session ouverte), et la demande qu'il a lue sans y répondre.
REPRISE = "TOKFIT_MCP_REPRISE"
ATTENTE = "TOKFIT_MCP_ATTENTE"
# Argument que le connecteur ajoute à chaque appel de `python` : l'identifiant de la boucle.
AGENT = "agent"
# Dossier de la boucle qui appelle (worktree d'un sous-agent isolé), posé par le connecteur :
# le noyau de l'agent y démarre ; ensuite, son dossier courant est le sien.
DOSSIER = "cwd"
PRINCIPAL = "main"
AGENT_LONGUEUR_MAX = 128
NOYAUX_MAX = 8
LIBERE = "[this agent's kernel was stopped after inactivity while other agents were working: state lost]\n"
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
            f"exec(compile({paquet.amorce!r}, '<bootstrap>', 'exec'), _m.__dict__)\n"
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
        "name": OUTIL,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "Python code; the value of the last expression is shown."},
                "timeout_s": {"type": "integer", "description": "Timeout in seconds (120 by default, 600 at most).",
                              "minimum": 1, "maximum": TIMEOUT_MAX},
                AGENT: {"type": "string", "description": "Filled in by the connector: do not set it."},
                DOSSIER: {"type": "string", "description": "Filled in by the connector: do not set it."},
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


def dossier_de(arguments: Dict[str, Any], defaut: str) -> str:
    """Dossier où démarre le noyau de l'agent : celui posé par le connecteur s'il existe, sinon `defaut`."""
    valeur = arguments.get(DOSSIER)
    if isinstance(valeur, str) and os.path.isabs(valeur) and os.path.isdir(valeur):
        return valeur
    return defaut


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
        # Paquet, description et amorce arrivent d'un autre fil (`installer`) : lus et écrits sous `etat`.
        self.etat = threading.Lock()
        # Levé quand le client a fini d'ouvrir la session : une annonce n'est jamais écrite avant.
        self.initialise = threading.Event()
        # Levé quand la première tentative d'obtenir lien et paquet est finie ; `initialize` l'attend (`DEMARRAGE_S`).
        self.premier = threading.Event()
        self.premier.set()
        self.depart = time.monotonic()
        self.postes: Dict[str, Poste] = {}
        self.liberes: set[str] = set()
        self.verrou = threading.Lock()

    def repondre(self, message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """La réponse JSON-RPC à un message ; None pour une notification."""
        methode = message.get("method")
        if "id" not in message:
            if methode == "notifications/initialized":
                self.initialise.set()
            return None
        ident = message["id"]
        if methode == "initialize":
            demande = (message.get("params") or {}).get("protocolVersion")
            version = demande if demande in PROTOCOLES else PROTOCOLES[0]
            self.attendre_depart()
            return self.resultat(ident, {"protocolVersion": version, "capabilities": {"tools": {"listChanged": True}},
                                         "serverInfo": {"name": NOM, "version": VERSION}})
        if methode == "ping":
            return self.resultat(ident, {})
        if methode == "tools/list":
            self.attendre_depart()
            self.initialise.set()
            return self.resultat(ident, {"tools": self.outils()})
        if methode == "tools/call":
            self.attendre_depart()
            return self.appel(ident, message.get("params") or {})
        return {"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": f"unknown method: {methode}"}}

    @staticmethod
    def en_parallele(message: Dict[str, Any]) -> bool:
        """Vrai pour un appel de `python`, qui peut durer : il tourne dans son propre fil."""
        params = message.get("params")
        return (message.get("method") == "tools/call" and "id" in message
                and isinstance(params, dict) and params.get("name") == OUTIL)

    def attendre_depart(self) -> None:
        """Attend la première tentative d'obtenir lien et paquet, au plus `DEMARRAGE_S` depuis le départ du serveur
        (délai commun à `initialize`, `tools/list` et `tools/call` : un client qui les enchaîne n'attend pas plus)."""
        self.premier.wait(max(0.0, DEMARRAGE_S - (time.monotonic() - self.depart)))

    def lien(self) -> Optional[Lien]:
        """Le lien vers le service ; cherché de nouveau tant qu'il manque (clé anonyme arrivée après le démarrage)."""
        if self.vers is None:
            self.vers = lien(self.env)
            if self.vers is not None:
                self.compteur.vers = self.vers
        return self.vers

    def outils(self) -> List[Dict[str, Any]]:
        """Les outils proposés maintenant : `agir` avec le paquet (sur un système où le noyau tourne, POSIX ou
        Windows), `compte` avec le lien (paquet reçu ou non)."""
        with self.etat:
            description, amorce = self.description, self.amorce
        outils = [schema_outil(description)] if amorce is not None and NOYAU_POSSIBLE else []
        if self.lien() is not None:
            outils.append(schema_compte())
        return outils

    def noms(self) -> Tuple[str, ...]:
        return tuple(str(outil["name"]) for outil in self.outils())

    def installer(self, paquet: Paquet) -> None:
        """Le paquet reçu après l'ouverture : `agir` est proposé dès l'appel suivant à `tools/list`."""
        amorce = code_amorce(paquet)
        with self.etat:
            self.paquet, self.description, self.amorce = paquet, paquet.description, amorce

    def annoncer(self, sortie: "Sortie") -> None:
        """Dit au client que la liste des outils a changé, s'il a fini d'ouvrir la session (sinon son premier
        `tools/list` la lira à jour)."""
        if self.initialise.is_set():
            sortie.ecrire(LISTE_CHANGEE)

    def prendre(self, agent: str, dossier: Optional[str] = None) -> tuple[Poste, bool]:
        """Le poste de l'agent, créé au besoin (noyau démarré dans `dossier`), réservé jusqu'à `rendre` ;
        vrai si son noyau avait été arrêté."""
        assert self.amorce is not None
        with self.verrou:
            poste = self.postes.get(agent)
            libere = False
            if poste is None:
                poste = Poste(Noyau(self.amorce, self.max_sortie, dossier or self.cwd, self.vers))
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
        with self.etat:
            paquet = self.paquet
        if params.get("name") != OUTIL or self.amorce is None or paquet is None:
            return {"jsonrpc": "2.0", "id": ident, "error": {"code": -32602, "message": "unknown tool"}}
        arguments = params.get("arguments") or {}
        code = arguments.get("code")
        if not isinstance(code, str):
            return self.texte(ident, "missing `code` argument (text)", erreur=True)
        delai = arguments.get("timeout_s", TIMEOUT_DEFAUT)
        delai = min(max(delai, 1), TIMEOUT_MAX) if isinstance(delai, int) and not isinstance(delai, bool) else TIMEOUT_DEFAUT
        poste, libere = self.prendre(agent_de(arguments), dossier_de(arguments, self.cwd))
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
        reponse = self.texte(ident, texte if texte.strip() else "(no output)", erreur=not execution.ok)
        # Images de `look` : blocs image du résultat MCP, après la sortie texte (le modèle les voit).
        reponse["result"]["content"].extend({"type": "image", "data": image["data"], "mimeType": image["mimeType"]}
                                            for image in execution.images or [])
        if execution.ok and execution.fini is not None:
            # Contrat avec le connecteur (hooks) : un bloc après la sortie (et ses images), préfixe exact, jamais avec isError.
            reponse["result"]["content"].append({"type": "text", "text": paquet.fini + execution.fini})
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


def rattraper(serveur: Serveur, arret: threading.Event, annoncer: Callable[[], None], *,
              relances: Tuple[float, ...] = RELANCES_S, borne_s: float = BORNE_S, pas_s: float = PAS_LIEN_S,
              delai_s: float = DELAI_S, delai_relance_s: float = DELAI_RELANCE_S) -> None:
    """Obtient le lien puis le paquet, tant qu'il manque : lien relu toutes les `pas_s`, paquet redemandé
    après `relances` (le dernier écart se répète), pendant `borne_s` au plus. Quand les outils proposés
    changent (lien arrivé : `compte` ; paquet arrivé : `agir`), `annoncer` prévient le client. Lève
    `serveur.premier` dès que la première tentative est finie, pour que `initialize` ne l'attende pas plus."""
    fin = time.monotonic() + borne_s
    prochain = 0.0
    echecs = 0
    try:
        while not arret.is_set() and serveur.paquet is None and time.monotonic() < fin:
            avant = serveur.noms()
            vers = serveur.lien()
            if vers is not None and time.monotonic() >= prochain:
                try:
                    paquet, raison = recevoir(vers, delai_s if echecs == 0 else delai_relance_s)
                except Exception as erreur:  # noqa: BLE001 : le fil ne doit jamais mourir sur une réponse inattendue
                    paquet, raison = None, f"erreur inattendue ({type(erreur).__name__})"
                if paquet is not None:
                    serveur.installer(paquet)
                else:
                    if echecs == 0:
                        log.warning("paquet du noyau indisponible (%s) : redemandé en arrière-plan", raison)
                    prochain = time.monotonic() + relances[min(echecs, len(relances) - 1)]
                    echecs += 1
            if serveur.noms() != avant:
                try:
                    annoncer()
                except (OSError, ValueError):
                    return  # stdout fermé : le client est parti
            if serveur.paquet is not None or echecs > 0 or (vers is None and not cle_attendue(serveur.env)):
                serveur.premier.set()
            arret.wait(pas_s if vers is None else max(0.05, prochain - time.monotonic()))
    finally:
        serveur.premier.set()
    if serveur.paquet is None and not arret.is_set():
        log.warning("paquet du noyau toujours indisponible après %.0f s : outil non proposé pour cette session", borne_s)


def reprise(environ: MutableMapping[str, str]) -> Tuple[bool, str]:
    """Session déjà ouverte par le lanceur, et la demande qu'il a lue ; retirées de l'environnement."""
    ouverte = bool(environ.pop(REPRISE, ""))
    return ouverte, environ.pop(ATTENTE, "")


def annoncer_apres_depart(serveur: Serveur, annoncer: Callable[[], None]) -> None:
    """Après la première tentative d'obtenir lien et paquet, annonce la liste si elle n'est plus vide (les
    changements suivants sont annoncés par `rattraper`)."""
    serveur.premier.wait(DEMARRAGE_S)
    if serveur.noms():
        try:
            annoncer()
        except (OSError, ValueError):
            pass  # stdout fermé : le client est parti


def main() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING, format="noyau: %(message)s")
    # Le protocole MCP est en UTF-8, une ligne finie par \n : sous Windows, sans -X utf8, Python prendrait la page
    # de code du système (cp1252 : UnicodeEncodeError au premier caractère hors de la page) et \r\n.
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    if isinstance(sys.stdin, io.TextIOWrapper):
        sys.stdin.reconfigure(encoding="utf-8")
    ouverte, attente = reprise(os.environ)
    env = dict(os.environ)
    ensure_auto_update(env)
    serveur = Serveur(env, None, lien(env))
    if ouverte:
        serveur.initialise.set()
    sortie = Sortie()
    # Lien et paquet sont cherchés dans un fil : `initialize` les attend au plus `DEMARRAGE_S`, les outils
    # arrivés plus tard sont annoncés (`notifications/tools/list_changed`).
    serveur.premier.clear()
    serveur.depart = time.monotonic()
    arret = threading.Event()
    rattrapage = threading.Thread(target=rattraper, args=(serveur, arret, lambda: serveur.annoncer(sortie)),
                                  name="lien-et-paquet", daemon=True)
    rattrapage.start()
    appels: List[threading.Thread] = []

    def traiter(ligne: str) -> Optional[Dict[str, Any]]:
        nonlocal appels
        if not ligne.strip():
            return None
        try:
            message = json.loads(ligne)
        except ValueError:
            sortie.ecrire({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "unreadable JSON"}})
            return None
        if not isinstance(message, dict):
            return None
        if serveur.en_parallele(message):
            appel = threading.Thread(target=lambda m=message: sortie.ecrire(serveur.repondre(m)),
                                     name="appel-python", daemon=True)
            appels = [en_cours for en_cours in appels if en_cours.is_alive()] + [appel]
            appel.start()
        else:
            sortie.ecrire(serveur.repondre(message))
        return message

    try:
        lue = traiter(attente) if attente else None
        if ouverte and (lue is None or lue.get("method") != "tools/list"):
            # Le client a vu la liste vide du lanceur : il relira la liste dès que des outils sont là.
            threading.Thread(target=annoncer_apres_depart, args=(serveur, lambda: serveur.annoncer(sortie)),
                             name="annonce-reprise", daemon=True).start()
        for ligne in sys.stdin:
            traiter(ligne)
    finally:
        arret.set()
        rattrapage.join(ARRET_S)
        serveur.fermer()
        for appel in appels:
            appel.join(ARRET_S)
        serveur.arreter()
        serveur.compteur.finir(ARRET_S)


if __name__ == "__main__":
    main()

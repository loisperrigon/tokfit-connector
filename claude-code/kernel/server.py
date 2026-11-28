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
from typing import Any, Callable, Dict, List, Mapping, MutableMapping, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kernel.autoupdate import ensure_auto_update  # noqa: E402
from kernel.antigravity_ready import OWNER, PLUGINS, Readiness  # noqa: E402
from kernel.compte import compte, schema as schema_compte  # noqa: E402
from kernel.cellule import PROLONGEE_MAX  # noqa: E402
from kernel.kernel import TIMEOUT_MAX, Noyau  # noqa: E402
from kernel.output import MAX_SORTIE  # noqa: E402
from kernel.pack import (  # noqa: E402
    DELAI_RELANCE_S, DELAI_S, PREFIXE_DANS_LE_NOYAU, REFUS, Lien, Paquet, cle_attendue, compter, lien, recevoir,
)

from completion import FINISH_PREFIX, finish_tag  # noqa: E402

NOM = "outils"
# Nom neutre de l'outil d'action, affiché dans l'interface : il ne dit rien de la méthode (choix de Lois du 15/11/2026).
OUTIL = "agir"
ANTIGRAVITY_READY_FILE = "TOKFIT_ANTIGRAVITY_READY_FILE"  # publish: keep
# Le noyau tourne sous POSIX et sous Windows (tubes et interruption : `kernel/tubes.py`) ; gardé pour couper
# `agir` sur un système où il ne tournerait pas (les essais le posent à faux).
NOYAU_POSSIBLE = os.name in ("posix", "nt")
VERSION = "1.0.0"
PROTOCOLES = ("2025-06-18", "2025-03-26", "2024-11-05")
TIMEOUT_DEFAUT = 120
# Le délai d'une cellule recule pour un outil qui attend plus longtemps (`kernel/cellule.py`) : dit au modèle, qui
# demandait sinon 600 s par précaution, ou voyait sa commande coupée avant son propre délai.
TIMEOUT_TEXTE = (f"Timeout in seconds ({TIMEOUT_DEFAUT} by default, {TIMEOUT_MAX} at most); a helper that waits longer "
                 f"(its own timeout_s: shell, verify…) extends it, up to {PROLONGEE_MAX} s in all.")
ATTENTE_TEXTE = (" This client waits {} s at most per call: a longer cell keeps running in the kernel, and the next call "
                 "waits for it and shows its output.")
# Claude Code passe en tâche de fond un appel MCP qui dure plus de 120 s (session interactive) : l'agent perd la main,
# reçoit le résultat plus tard et relançait des sondages, parfois deux à la fois (constat du 28/11/2026, Claude Code
# 2.1.332). `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` règle ce seuil, 0 le coupe ; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`
# le coupe aussi ; sous `claude -p` (`CLAUDE_CODE_ENTRYPOINT` en `sdk-…`), il ne vaut qu'avec
# `CLAUDE_AUTO_BACKGROUND_TASKS`. Un appel d'`agir` rend donc la main MARGE_CLIENT_S avant (moitié du seuil au plus) :
# la cellule continue dans le noyau, l'appel suivant l'attend (`kernel/kernel.py`).
FOND_CLAUDE_S = 120.0
MARGE_CLIENT_S = 10.0
OCCUPE = ("[another call to this kernel is still running (the client moved it to the background?): your code was not "
          "run; call agir again]")
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
# Faits du fil principal posés par le connecteur (`facts`, hooks/kernel.ts) : nombres et identifiant de modèle
# seulement, lus par `delegate()` dans le noyau. Les autres clés et les valeurs mal formées sont écartées.
FAITS = "facts"
FAITS_NOMBRES = ("context_tokens",)
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


def vrai(valeur: Optional[str]) -> bool:
    return (valeur or "").strip().lower() in ("1", "true", "yes", "on")


def attente_du_client(env: Mapping[str, str]) -> Optional[float]:
    """Secondes qu'un appel peut tenir avant que le client ne le passe en tâche de fond ; None : pas de borne."""
    if env.get("CLAUDECODE") != "1" or vrai(env.get("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS")):
        return None
    if env.get("CLAUDE_CODE_ENTRYPOINT", "").startswith("sdk-") and not vrai(env.get("CLAUDE_AUTO_BACKGROUND_TASKS")):
        return None
    seuil = FOND_CLAUDE_S
    brut = env.get("CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS", "").strip()
    if brut:
        try:
            millisecondes = float(brut)
        except ValueError:
            log.warning("CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS illisible (%r) : %s s", brut, FOND_CLAUDE_S)
        else:
            if millisecondes <= 0:
                return None
            seuil = millisecondes / 1000
    return max(seuil - MARGE_CLIENT_S, seuil / 2)


def code_amorce(paquet: Paquet) -> str:
    """Cellule de démarrage : l'amorce reçue exécutée dans un module en mémoire, qui charge les outils.
    `relais` (conseil de délégation) n'est passé qu'à une amorce qui le prend : un service pas encore à jour
    sert une amorce à quatre arguments."""
    return ("import sys as _s, types as _t\n"
            f"from {PREFIXE_DANS_LE_NOYAU}kernel.pack import sauver_outil as _sauver, conseiller_relais as _relais\n"
            "_m = _t.ModuleType('noyau_amorce')\n"
            "_s.modules['noyau_amorce'] = _m\n"
            f"exec(compile({paquet.amorce!r}, '<bootstrap>', 'exec'), _m.__dict__)\n"
            "_o = {'relais': _relais} if 'relais' in _m.charger.__code__.co_varnames else {}\n"
            f"_m.charger(globals(), {paquet.modules!r}, {paquet.catalogue!r}, _sauver, **_o)\n"
            "del _s, _t, _m, _sauver, _relais, _o")


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


def schema_outil(paquet: Paquet, native_tools: bool, codex: bool = False,
                 attente_s: Optional[float] = None) -> Dict[str, Any]:
    delai = TIMEOUT_TEXTE + (ATTENTE_TEXTE.format(int(attente_s)) if attente_s is not None else "")
    properties: Dict[str, Any] = {
        "code": {"type": "string", "description": "Python code; the value of the last expression is shown."},
        "timeout_s": {"type": "integer", "description": delai, "minimum": 1, "maximum": TIMEOUT_MAX},
    }
    if native_tools:
        # Older packs have the same persistent Python API but only a Claude-specific guide.
        description = paquet.native_tools_description or (
            "Runs Python in a persistent kernel. find_tool('keywords') lists matching helper signatures."
        )
    else:
        description = paquet.description
        properties.update({
            AGENT: {"type": "string", "description": "Filled in by the connector: do not set it."},
            DOSSIER: {"type": "string", "description": "Filled in by the connector: do not set it."},
            FAITS: {"type": "object", "description": "Filled in by the connector: do not set it."},
        })
    if codex and paquet.codex_finish_instruction:
        description += " " + paquet.codex_finish_instruction
    return {
        "name": OUTIL,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": ["code"],
        },
    }


def agent_de(arguments: Dict[str, Any]) -> str:
    """L'agent qui appelle (argument posé par le connecteur) ; le fil principal sans identifiant lisible."""
    valeur = arguments.get(AGENT)
    if isinstance(valeur, str) and 0 < len(valeur) <= AGENT_LONGUEUR_MAX and valeur.isprintable():
        return valeur
    return PRINCIPAL


def faits_de(arguments: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Faits du fil principal joints à l'appel, réduits à ce que lit le service ; None sans eux."""
    brut = arguments.get(FAITS)
    if not isinstance(brut, dict) or agent_de(arguments) != PRINCIPAL:
        return None
    faits: Dict[str, Any] = {}
    modele = brut.get("session_model")
    if isinstance(modele, str) and 0 < len(modele) <= AGENT_LONGUEUR_MAX and modele.isprintable():
        faits["session_model"] = modele
    for nom in FAITS_NOMBRES:
        valeur = brut.get(nom)
        if isinstance(valeur, int) and not isinstance(valeur, bool) and valeur >= 0:
            faits[nom] = valeur
    if isinstance(brut.get("cache_cold"), bool):
        faits["cache_cold"] = brut["cache_cold"]
    caches = brut.get("model_cache")
    if isinstance(caches, dict):
        faits["model_cache"] = {
            str(famille)[:AGENT_LONGUEUR_MAX]: {"idle_s": entree["idle_s"], "tokens": entree["tokens"]}
            for famille, entree in list(caches.items())[:8]
            if isinstance(entree, dict) and all(isinstance(entree.get(cle), (int, float)) and not isinstance(entree.get(cle), bool)
                                                for cle in ("idle_s", "tokens"))}
    return faits if "session_model" in faits else None


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
    def __init__(self, env: Dict[str, str], paquet: Optional[Paquet], vers: Optional[Lien] = None,
                 *, antigravity: bool = False, codex: bool = False) -> None:
        self.max_sortie = entier(env, "TOKFIT_KERNEL_MAX_OUTPUT", MAX_SORTIE)
        self.noyaux_max = entier(env, "TOKFIT_KERNEL_MAX_AGENTS", NOYAUX_MAX)
        self.env = env
        self.vers = vers
        # Clés que le service a refusées (401, 403) : `lien` passe à la suivante.
        self.refusees: set[str] = set()
        self.paquet = paquet
        self.compteur = Compteur(vers)
        self.antigravity = antigravity
        self.codex_client = codex
        self.native_tools = antigravity or codex
        self.attente_claude = attente_du_client(env)
        owner, root = env.get(OWNER, ""), env.get(PLUGINS)
        self.native_readiness = (Readiness(root, int(owner))
                                 if antigravity and root and owner.isdecimal() and len(owner) < 12 else None)
        self.amorce = code_amorce(paquet) if paquet is not None else None
        self.cwd = os.getcwd()
        # Paquet et amorce arrivent d'un autre fil (`installer`) : lus et écrits sous `etat`.
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
            params = message.get("params") or {}
            client = params.get("clientInfo") if isinstance(params, dict) else None
            if isinstance(client, dict) and client.get("name") == "codex-mcp-client":
                self.codex_client = True
                self.native_tools = True
            demande = params.get("protocolVersion")
            version = demande if demande in PROTOCOLES else PROTOCOLES[0]
            self.attendre_depart()
            return self.resultat(ident, {"protocolVersion": version, "capabilities": {"tools": {"listChanged": True}},
                                         "serverInfo": {"name": NOM, "version": VERSION}})
        if methode == "ping":
            return self.resultat(ident, {})
        if methode == "tools/list":
            self.attendre_depart()
            self.initialise.set()
            outils = self.outils()
            self.antigravity_ready(any(outil["name"] == OUTIL for outil in outils), catalog=True)
            return self.resultat(ident, {"tools": outils})
        if methode == "tools/call":
            self.attendre_depart()
            return self.appel(ident, message.get("params") or {})
        return {"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": f"unknown method: {methode}"}}

    def antigravity_ready(self, listed: bool, *, catalog: bool = False) -> None:
        if self.native_readiness is not None:
            self.native_readiness.update(listed)
        filename = self.env.get(ANTIGRAVITY_READY_FILE) if self.antigravity else None
        # A server-side list is not proof that the ACP conversation can call agir.
        if filename and not (catalog and listed):
            path = Path(filename)
            try:
                if listed:
                    path.write_text(str(os.getpid()), encoding="ascii")
                elif path.exists() and path.read_text(encoding="ascii") == str(os.getpid()):
                    path.unlink(missing_ok=True)
            except OSError:
                logging.warning("Antigravity kernel readiness is unavailable")

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
            self.vers = lien(self.env, self.refusees)
            if self.vers is not None:
                self.compteur.vers = self.vers
        return self.vers

    def ecarter(self, vers: Lien) -> bool:
        """Le service a refusé la clé de `vers` : vrai si une autre clé la remplace (celle du fichier de
        configuration, ou la clé anonyme, attendue tant que le connecteur ne l'a pas rangée) ; le jeton du relais
        n'a pas de remplaçante."""
        if lien(self.env, self.refusees | {vers[1]}) == vers:
            return False
        self.refusees.add(vers[1])
        self.vers = None
        log.warning("clé refusée par le service : la clé suivante prend le relais")
        return True

    @property
    def attente_s(self) -> Optional[float]:
        """Borne d'un appel chez le client : celle de Claude Code, jamais pour Codex ni Antigravity (lancés depuis une
        session Claude Code, ils en héritent les variables)."""
        return None if self.native_tools else self.attente_claude

    def outils(self) -> List[Dict[str, Any]]:
        """Les outils proposés maintenant : `agir` avec le paquet (sur un système où le noyau tourne, POSIX ou
        Windows), `compte` avec le lien (paquet reçu ou non)."""
        with self.etat:
            paquet = self.paquet
        outils = [schema_outil(paquet, self.native_tools, self.codex_client, self.attente_s)] if paquet is not None and NOYAU_POSSIBLE else []
        if self.lien() is not None:
            outils.append(schema_compte())
        return outils

    def noms(self) -> Tuple[str, ...]:
        return tuple(str(outil["name"]) for outil in self.outils())

    def installer(self, paquet: Paquet) -> None:
        """Le paquet reçu après l'ouverture : `agir` est proposé dès l'appel suivant à `tools/list`."""
        amorce = code_amorce(paquet)
        with self.etat:
            self.paquet, self.amorce = paquet, amorce

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
        """Au-delà du plafond, arrête les noyaux des sous-agents inactifs, le plus ancien d'abord (verrou tenu) ; une
        cellule qui a rendu la main et tourne encore (`Noyau.rendue`) n'est pas inactive."""
        libres = sorted((poste.dernier, agent) for agent, poste in self.postes.items()
                        if agent not in (garde, PRINCIPAL) and poste.appels == 0 and not poste.noyau.rendue)
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
        arguments = params.get("arguments", {})
        if not isinstance(arguments, dict):
            return self.texte(ident, "`arguments` must be an object", erreur=True)
        if self.native_tools:
            # These clients do not supply trusted agent, working directory or routing facts.
            arguments = {key: arguments[key] for key in ("code", "timeout_s") if key in arguments}
        code = arguments.get("code")
        if not isinstance(code, str):
            return self.texte(ident, "missing `code` argument (text)", erreur=True)
        arrivee = time.monotonic()
        delai = arguments.get("timeout_s", TIMEOUT_DEFAUT)
        delai = min(max(delai, 1), TIMEOUT_MAX) if isinstance(delai, int) and not isinstance(delai, bool) else TIMEOUT_DEFAUT
        poste, libere = self.prendre(agent_de(arguments), dossier_de(arguments, self.cwd))
        try:
            # Le temps passé à attendre un autre appel du même agent compte dans celui que le client laisse.
            borne = self.attente_s
            if not poste.verrou.acquire(timeout=-1 if borne is None else borne):
                return self.texte(ident, OCCUPE, erreur=False)
            try:
                prefixe = LIBERE if libere else ""
                if not poste.demarre:
                    poste.demarre = True
                    prefixe += poste.noyau.demarrer()
                attente = None if borne is None else borne - (time.monotonic() - arrivee)
                execution = poste.noyau.executer(code, delai, faits_de(arguments), attente)
            finally:
                poste.verrou.release()
        except OSError:
            self.antigravity_ready(False)
            raise
        finally:
            self.rendre(poste)
        if execution.usage:
            self.compteur.ajouter(execution.usage)
        self.antigravity_ready(execution.ok or execution.cell_response)
        texte = (prefixe + execution.sortie) if prefixe else execution.sortie
        reponse = self.texte(ident, texte if texte.strip() else "(no output)", erreur=not execution.ok)
        if not execution.ok and execution.cell_response:
            reponse["result"]["_meta"] = {"workspace-kernel/cell-response": True}
        # Images de `look` : blocs image du résultat MCP, après la sortie texte (le modèle les voit).
        reponse["result"]["content"].extend({"type": "image", "data": image["data"], "mimeType": image["mimeType"]}
                                            for image in execution.images or [])
        if execution.ok and execution.fini is not None:
            # Contrat avec le connecteur (hooks) : un bloc après la sortie (et ses images), préfixe exact, jamais avec isError.
            reponse["result"]["content"].append({"type": "text", "text": paquet.fini + execution.fini})
            meta = params.get("_meta")
            if self.codex_client and self.vers and isinstance(meta, dict) and len(execution.fini) <= 32768:
                thread, item = meta.get("threadId"), meta.get("itemId")
                if not (isinstance(thread, str) and 0 < len(thread) <= 256
                        and isinstance(item, str) and 0 < len(item) <= 256):
                    return reponse
                tag = finish_tag(self.vers[1], thread, item, code, execution.fini)
                reponse["result"]["content"].append({"type": "text", "text": FINISH_PREFIX + tag})
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
                elif raison == REFUS and serveur.ecarter(vers):
                    prochain = 0.0
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
    serveur = Serveur(env, None, lien(env), antigravity=sys.argv[1:] == ["--antigravity"],
                      codex=sys.argv[1:] == ["--codex"])
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
        serveur.antigravity_ready(False)
        serveur.arreter()
        if serveur.native_readiness is not None:
            serveur.native_readiness.close()
        serveur.compteur.finir(ARRET_S)


if __name__ == "__main__":
    main()

"""Processus du noyau : exécute le code reçu dans un espace de noms qui dure.

Lancé par `kernel.Noyau` : `python3 worker.py <fd requêtes> <fd réponses> <limite>`.
Les requêtes arrivent sur un tube dédié (une ligne JSON `{"code": …}`), les
réponses repartent sur un autre (`{"sortie": …, "ok": …, "fini": …}`) : stdin est fermé,
donc `input()` lève EOFError au lieu de lire le protocole, et les `print` du
code vont dans une capture bornée, jamais dans le tube des réponses.

Chaque cellule est inscrite dans `linecache` sous `<cellule-N>` :
`inspect.getsource` retrouve ainsi les fonctions définies dans le noyau
(c'est ce que `sauve_outil` lit). SIGINT interrompt la cellule en cours
(`KeyboardInterrupt`) sans perdre l'état : le worker pose lui-même son
gestionnaire au démarrage, car il hérite sinon de la disposition de son
parent (SIG_IGN sous `nohup` ou un shell non interactif en arrière-plan), et
un délai dépassé finirait en arrêt forcé, l'état perdu.

La sortie rendue est coupée à `<limite>` ; la sortie entière de la dernière
cellule reste dans `_sortie`, à découper sans relancer. `fini()` (défini par
l'amorce) écrit son résumé dans `__fini__` : il ne remonte que si la cellule
s'est terminée sans exception, le dernier appel l'emporte. Les appels d'outils
comptés par l'amorce (`__usage__`) remontent avec la réponse, puis repartent à zéro.
"""
from __future__ import annotations

import ast
import json
import linecache
import os
import signal
import sys
import traceback
from types import CodeType, TracebackType
from typing import Any, Dict, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from kernel.output import COMPLET_MAX, DANS_SORTIE, Capture, resume_traceback, tronque  # noqa: E402
from kernel.pack import prendre_lien  # noqa: E402

CELLULE = "<cellule-{}>"
FINI = "__fini__"
USAGE = "__usage__"


def compiler(code: str, nom: str) -> Tuple[Optional[CodeType], Optional[CodeType]]:
    """Le corps de la cellule, et sa dernière expression à part (affichée comme dans un REPL)."""
    arbre = ast.parse(code, nom, "exec")
    derniere: Optional[ast.Expression] = None
    if arbre.body and isinstance(arbre.body[-1], ast.Expr):
        derniere = ast.Expression(arbre.body.pop().value)  # type: ignore[attr-defined]
    corps = compile(arbre, nom, "exec") if arbre.body else None
    return corps, compile(derniere, nom, "eval") if derniere is not None else None


def sans_cadres_du_noyau(tb: Optional[TracebackType]) -> Optional[TracebackType]:
    """Retire du traceback les cadres de ce fichier : le modèle ne lit que son code."""
    while tb is not None and tb.tb_frame.f_code.co_filename == __file__:
        tb = tb.tb_next
    return tb


def executer(code: str, numero: int, espace: Dict[str, Any], limite: int) -> Dict[str, Any]:
    nom = CELLULE.format(numero)
    linecache.cache[nom] = (len(code), None, code.splitlines(True), nom)
    capture = Capture(COMPLET_MAX)
    sys.stdout = sys.stderr = capture
    espace[FINI] = None
    ok = True
    try:
        corps, derniere = compiler(code, nom)
        if corps is not None:
            exec(corps, espace)
        if derniere is not None:
            valeur = eval(derniere, espace)
            if valeur is not None:
                espace["_"] = valeur
                # Une chaîne (lire, carte…) se lit telle quelle : son repr échapperait chaque saut de ligne.
                capture.write((valeur if isinstance(valeur, str) else repr(valeur)) + "\n")
    except KeyboardInterrupt:
        ok = False
        capture.write("KeyboardInterrupt\n")
    except BaseException as erreur:  # noqa: BLE001 - l'erreur du code est le résultat rendu au modèle
        ok = False
        if isinstance(erreur, SystemExit) and erreur.code in (None, 0):
            ok = True
        else:
            pile = traceback.format_exception(type(erreur), erreur, sans_cadres_du_noyau(erreur.__traceback__))
            capture.write(resume_traceback("".join(pile)) + "\n")
    finally:
        sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__
    complete = capture.valeur()
    espace["_sortie"] = complete
    fini = espace.pop(FINI, None)
    usage = espace.pop(USAGE, None)
    return {"sortie": tronque(complete, limite, DANS_SORTIE), "ok": ok,
            "fini": str(fini) if ok and fini is not None else None,
            "usage": {cle: n for cle, n in usage.items() if isinstance(cle, str) and type(n) is int}
            if isinstance(usage, dict) else {}}


def boucle(fd_requetes: int, fd_reponses: int, limite: int) -> None:
    espace: Dict[str, Any] = {"__name__": "__main__", "__builtins__": __builtins__}
    requetes = os.fdopen(fd_requetes, "r", encoding="utf-8")
    reponses = os.fdopen(fd_reponses, "w", encoding="utf-8")
    numero = 0
    while True:
        try:
            ligne = requetes.readline()
        except KeyboardInterrupt:
            continue  # SIGINT arrivé après la fin de la cellule : rien à interrompre.
        if not ligne:
            return
        numero += 1
        try:
            code = str(json.loads(ligne)["code"])
            reponse = executer(code, numero, espace, limite)
        except KeyboardInterrupt:
            reponse = {"sortie": "KeyboardInterrupt\n", "ok": False}
        reponses.write(json.dumps(reponse, ensure_ascii=False) + "\n")
        reponses.flush()


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal.default_int_handler)
    prendre_lien()
    boucle(int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]))

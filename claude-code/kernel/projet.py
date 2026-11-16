"""Le code du projet s'importe depuis le noyau, qui tourne sur le Python de tokfit lancé avec -I.

-I écarte PYTHONPATH, le site de l'utilisateur et le dossier courant : l'amorce remet le dossier
courant (`""` en fin de `sys.path`), et ce module ajoute les paquets des environnements du projet
de la même version mineure que ce Python (même ABI) : le venv activé (`VIRTUAL_ENV`), l'environnement
conda (`CONDA_PREFIX`), `.venv` et `venv` du dossier où le noyau démarre. Ajoutés en fin de
`sys.path` par `site.addsitedir` (fichiers `.pth` lus, installations éditables comprises), jamais
devant la bibliothèque standard. D'une autre version, ils sont laissés : le modèle passe par
`shell()`, dont `python` est celui du projet (shims de `kernel/kernel.py`).
"""
from __future__ import annotations

import os
import site
import sys
from typing import List, Mapping, Optional

DOSSIERS = (".venv", "venv")


def version_du_venv(base: str) -> Optional[str]:
    """Version « X.Y » écrite dans `pyvenv.cfg` (clés `version_info` ou `version`), None sans fichier lisible."""
    try:
        with open(os.path.join(base, "pyvenv.cfg"), encoding="utf-8") as fichier:
            lignes = fichier.read().splitlines()
    except OSError:
        return None
    for ligne in lignes:
        cle, _, valeur = ligne.partition("=")
        if cle.strip() in ("version_info", "version"):
            return ".".join(valeur.strip().split(".")[:2])
    return None


def paquets(base: str) -> Optional[str]:
    """Dossier des paquets de l'environnement `base` pour ce Python, None s'il est d'une autre version."""
    mineure = f"{sys.version_info[0]}.{sys.version_info[1]}"
    if os.name == "nt":
        dossier = os.path.join(base, "Lib", "site-packages")
        return dossier if os.path.isdir(dossier) and version_du_venv(base) == mineure else None
    dossier = os.path.join(base, "lib", f"python{mineure}", "site-packages")
    return dossier if os.path.isdir(dossier) else None


def sites_du_projet(dossier: str, env: Mapping[str, str]) -> List[str]:
    """Dossiers de paquets à ajouter, dans l'ordre, sans doublon ni ceux de ce Python."""
    bases = [env.get("VIRTUAL_ENV", ""), env.get("CONDA_PREFIX", "")] + [os.path.join(dossier, nom) for nom in DOSSIERS]
    deja = {os.path.realpath(chemin) for chemin in sys.path if chemin}
    trouves: List[str] = []
    for base in bases:
        if not base or not os.path.isabs(base):
            continue
        chemin = paquets(base)
        if chemin is None:
            continue
        reel = os.path.realpath(chemin)
        if reel not in deja:
            deja.add(reel)
            trouves.append(chemin)
    return trouves


def ajouter(dossier: str, env: Mapping[str, str]) -> List[str]:
    """Ajoute à `sys.path` les paquets du projet (voir le module) ; rend les dossiers ajoutés."""
    ajoutes = sites_du_projet(dossier, env)
    for chemin in ajoutes:
        site.addsitedir(chemin)
    return ajoutes

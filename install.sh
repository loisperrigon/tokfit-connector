#!/bin/sh
# Installe un connecteur du service (tokfit) en une
# commande. Sans clé, l'essai démarre sans inscription : le connecteur demande
# lui-même une clé anonyme au service au premier lancement. Avec une clé (celle
# de l'abonnement), elle est écrite dans ~/.config/tokfit/config.json
# (droits 600, hors de tout dépôt), puis
#   - claude : le plugin est installé dans Claude Code (CLI et onglet
#     Code de Claude Desktop, qui lisent la même configuration) ;
#   - codex : le lanceur `tokfit codex …` est posé dans ~/.local/bin ;
#   - agy : le plugin natif Tokfit est installé dans Antigravity CLI.
#
#   sh install.sh                             détecte les CLI, une seule saisie de clé
#   sh install.sh --list                      affiche les clients pris en charge
#   sh install.sh codex claude                installe les clients nommés, une fois chacun
#   TOKFIT_KEY=ek_… sh install.sh codex   sans question (automatisation, essais)
#   TOKFIT_KEY= sh install.sh             sans question ni clé : essai sans inscription
#   curl -fsSL <dépôt public>/install.sh | sh -s codex   sans clone : plugin et
#                       lanceur pris dans le dépôt public (REPO), jamais dans le dossier courant
#
# Variables facultatives :
#   TOKFIT_URL     adresse du service (https, ou http://127.0.0.1 pour essayer)
#   TOKFIT_SOURCE  marketplace du plugin : dossier, dépôt git ou owner/repo
#                       (défaut : le dossier de ce script, ou REPO sans dossier)
#   TOKFIT_RAW_URL adresse des fichiers du lanceur sans dossier local
#                       (défaut : REPO sur raw.githubusercontent.com)
#   TOKFIT_CONFIG  autre fichier de configuration (plugin et lanceur lisent la même variable)
#   TOKFIT_BIN     dossier du lanceur Codex (défaut : ~/.local/bin)
#
# La clé ne passe jamais en argument d'une commande (visible dans la liste des
# processus) et n'est jamais affichée.
#
# Autre voie, sans ce script : `claude plugin install tokfit --marketplace
# <source> --config api_key=ek_…` (clé gardée dans le trousseau par Claude
# Code, mais tapée dans la ligne de commande). Le plugin lit les deux ; sa
# configuration passe avant ce fichier.
set -efu

NAME=tokfit
CLIENTS="claude codex agy"
# Adresse officielle du service et dépôt public du connecteur : vides dans le
# dépôt de travail, posés par connector/publish.py dans la copie publique.
# Vides, TOKFIT_URL est obligatoire et le script se lance depuis un clone.
DEFAULT_URL="https://api.tokfit.fr"
REPO="loisperrigon/tokfit-connector"
RUNTIME="__init__.py relay.py output.py process.py cursor.py completion.py"
KERNEL="__init__.py antigravity_ready.py autoupdate.py cellule.py compte.py kernel.py output.py pack.py projet.py server.py tubes.py worker.py"

fail() {
  printf '%s : %s\n' "$NAME" "$1" >&2
  exit 1
}

# Les noms de CLIENTS sont à la fois les commandes détectées et les suffixes
# des fonctions check_<client> et install_<client>. Seuls ces noms passent au dispatch.
if [ "$#" -eq 1 ] && [ "$1" = --list ]; then
  printf '%s\n' $CLIENTS
  exit 0
fi
if [ "$#" -eq 0 ] || { [ "$#" -eq 1 ] && [ "$1" = auto ]; }; then
  set --
  for client in $CLIENTS; do
    if command -v "$client" >/dev/null 2>&1; then set -- "$@" "$client"; fi
  done
  [ "$#" -gt 0 ] || fail "aucun client compatible détecté ($CLIENTS)."
elif [ "$#" -eq 1 ] && [ "$1" = both ]; then
  set -- claude codex  # Compatibilité avec les installations 0.7.35.
fi
selected=""
for requested do
  found=""
  for client in $CLIENTS; do
    if [ "$requested" = "$client" ]; then found=$client; break; fi
  done
  [ -n "$found" ] || fail "cible inconnue : $requested (clients disponibles : $CLIENTS)."
  case " $selected " in
    *" $found "*) ;;
    *) selected="${selected:+$selected }$found" ;;
  esac
done
# Dossier du script, seulement s'il est lancé comme fichier install.sh : par `curl … | sh`,
# $0 est « sh » et le dossier courant n'est jamais une source de confiance.
here=""
case "$0" in
  install.sh | */install.sh)
    if [ -f "$0" ]; then
      source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
      if [ -f "$source_dir/.claude-plugin/marketplace.json" ] && [ -f "$source_dir/codex/launcher.py" ]; then
        here="$source_dir"
      fi
    fi ;;
esac
url="${TOKFIT_URL:-$DEFAULT_URL}"
market="${TOKFIT_SOURCE:-${here:-${REPO:+https://github.com/$REPO.git}}}"
raw="${TOKFIT_RAW_URL:-${REPO:+https://raw.githubusercontent.com/$REPO/main}}"
config="${TOKFIT_CONFIG:-$HOME/.config/$NAME/config.json}"
bin="${TOKFIT_BIN:-$HOME/.local/bin}"

check_claude() {
  [ -n "$market" ] || fail "source du plugin inconnue (TOKFIT_SOURCE) : lance le script depuis un clone du dépôt."
}
check_codex() {
  needs_config=true
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null \
    || fail "Python 3.9 ou plus récent introuvable (commande python3)."
  if [ -z "$here" ]; then
    [ -n "$raw" ] || fail "source du lanceur inconnue (TOKFIT_RAW_URL) : lance le script depuis un clone du dépôt."
    command -v curl >/dev/null 2>&1 || fail "curl introuvable : installe-le, ou lance le script depuis un clone du dépôt."
  fi
}
check_agy() {
  [ -n "$market" ] || fail "source du plugin Antigravity inconnue (TOKFIT_SOURCE)."
  if [ -d "$market" ] && [ ! -f "$market/.antigravity-plugin/plugin.json" ]; then
    fail "ce dossier ne contient pas le plugin Antigravity ; utilise la copie publique du connecteur."
  fi
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null \
    || fail "Python 3.9 ou plus récent introuvable (commande python3)."
}
# Un exécutable comme exemple-cli fournit check_exemple_cli et install_exemple_cli.
adapter() {
  suffix=$(printf '%s' "$2" | tr '-' '_')
  "${1}_$suffix"
}
needs_config=false
for client in $selected; do
  command -v "$client" >/dev/null 2>&1 || fail "commande $client introuvable : installe ce CLI d’abord."
  adapter check "$client"
done

case "$url" in
  https://?* | http://127.0.0.1 | http://127.0.0.1:* | http://127.0.0.1/* | http://localhost | http://localhost:* | http://localhost/*) ;;
  "") fail "adresse du service inconnue (TOKFIT_URL)." ;;
  *) fail "adresse du service refusée : https attendu." ;;
esac
case "$url" in
  *[!A-Za-z0-9.:/_~%-]*) fail "adresse du service refusée : caractères inattendus." ;;
esac

if [ -n "${TOKFIT_KEY+set}" ]; then
  key="$TOKFIT_KEY"
elif [ -f "$config" ]; then
  key=""  # Une installation existante garde son compte, même quand on ajoute le second client.
elif [ -r /dev/tty ] && { true </dev/tty; } 2>/dev/null; then
  # `true`, pas `:` : une redirection ratée sur `:` (commande spéciale) arrête tout le script.
  printf 'Clé %s (ek_…, saisie masquée ; vide : essai sans inscription) : ' "$NAME" >/dev/tty
  stty -echo </dev/tty
  trap 'stty echo </dev/tty' EXIT INT TERM
  IFS= read -r key </dev/tty || key=""
  stty echo </dev/tty
  trap - EXIT INT TERM
  printf '\n' >/dev/tty
else
  # Sans terminal ni clé : essai sans inscription.
  key=""
fi

if [ -n "$key" ]; then
  case "$key" in
    ek_*) ;;
    *) fail "clé refusée : elle commence par ek_." ;;
  esac
  case "${key#ek_}" in
    "" | *[!A-Za-z0-9_-]*) fail "clé refusée : caractères inattendus." ;;
  esac
  [ "${#key}" -ge 23 ] && [ "${#key}" -le 203 ] || fail "clé refusée : longueur inattendue."
fi

# Fichier écrit avec une clé ; sans clé, seulement pour une autre adresse que l'officielle (ou pour
# le lanceur Codex, qui n'en a pas), et jamais par-dessus un fichier existant (il peut porter une clé).
if [ -n "$key" ] || { [ ! -e "$config" ] && { [ "$url" != "$DEFAULT_URL" ] || [ "$needs_config" = true ]; }; }; then
  umask 077
  dir=$(dirname -- "$config")
  mkdir -p -- "$dir"
  # Dossier propre au connecteur : fermé aux autres comptes de la machine.
  [ -n "${TOKFIT_CONFIG-}" ] || chmod 700 "$dir"
  tmp=$(mktemp "$dir/.config.XXXXXX")
  trap 'rm -f -- "$tmp"' EXIT INT TERM
  if [ -n "$key" ]; then
    printf '{"url": "%s", "key": "%s"}\n' "$url" "$key" >"$tmp"
  else
    printf '{"url": "%s"}\n' "$url" >"$tmp"
  fi
  chmod 600 "$tmp"
  if [ -n "$key" ]; then
    mv -f -- "$tmp" "$config"
  else
    # L'autre CLI peut avoir inscrit la clé pendant la préparation du fichier anonyme.
    ln -- "$tmp" "$config" 2>/dev/null || [ -f "$config" ] || fail "configuration impossible : $config"
    rm -f -- "$tmp"
  fi
  trap - EXIT INT TERM
fi

fetch() { # chemin dans le dépôt, destination : copie du clone, sinon téléchargement
  if [ -n "$here" ]; then
    cp -- "$here/$1" "$2"
  else
    curl -fsSL --max-time 30 -o "$2" "$raw/$1" || fail "téléchargement impossible : $1 ($raw)."
  fi
}

install_claude() {
  claude plugin install "$NAME" --marketplace "$market" || {
    plugin_status=$?
    printf '%s : vérifie le message de Claude Code. Cette commande demande Claude Code 2.1.292 ou plus récent.\n' "$NAME" >&2
    return "$plugin_status"
  }
  printf '%s : plugin Claude Code disponible à la prochaine session. Pour actualiser une installation existante, ouvre /plugin.\n' "$NAME"
}

install_agy() {
  case "$market" in
    https://github.com/*.git) source=${market%.git} ;;
    *) source=$market ;;
  esac
  agy plugin install "$source"
  printf '%s : ouvre une nouvelle session Antigravity pour utiliser agir.\n' "$NAME"
}

codex_path_hint() {
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) printf '%s : ajoute %s à ton PATH pour taper « %s codex ».\n' "$NAME" "$bin" "$NAME" ;;
  esac
}

install_codex() {
  mkdir -p -- "$bin"
  umask 022
  # Tout est d'abord réuni et contrôlé à part : un téléchargement raté n'installe rien.
  stage=$(mktemp -d "$bin/.$NAME.XXXXXX")
  trap 'rm -rf -- "$stage"' EXIT INT TERM
  if [ -n "$REPO" ] && [ -z "$here" ] && [ -z "${TOKFIT_SOURCE:-}" ] && [ -z "${TOKFIT_RAW_URL:-}" ]; then
    if codex plugin marketplace upgrade --help >/dev/null 2>&1; then
      fetch codex/native_bootstrap.py "$stage/bootstrap.py"
      python3 -I "$stage/bootstrap.py" --install "$bin" "https://github.com/$REPO.git"
      printf '%s : installé dans Codex. Les mises à jour passent par la marketplace tokfit-distribution.\n' "$NAME"
      codex_path_hint
      return
    fi
    printf '%s : ce Codex utilise une copie fixe. Relance cette installation pour la mettre à jour.\n' "$NAME"
  fi
  fetch codex/launcher.py "$stage/launcher"
  head -c 2 "$stage/launcher" | grep -q '^#!' || fail "le lanceur reçu n'est pas un script : rien n'est installé."
  package="$stage/package"
  mkdir -p -- "$package/runtime" "$package/kernel" "$package/hooks"
  for file in $RUNTIME; do
    fetch "runtime/$file" "$package/runtime/$file"
  done
  for file in $KERNEL; do
    fetch "claude-code/kernel/$file" "$package/kernel/$file"
  done
  # Le noyau importe completion depuis hooks, où Claude Code reçoit ce même module.
  cp -- "$package/runtime/completion.py" "$package/hooks/completion.py"
  fetch codex/register_mcp.py "$package/register_mcp.py"
  # Versions immuables : une session en cours peut encore ouvrir son worker après une mise à jour.
  # Une réinstallation identique réutilise le même dossier. La bascule du lien est atomique sur POSIX.
  python3 -I - "$bin" "$stage" <<'INSTALL_PACKAGE'
import hashlib
import os
from pathlib import Path
import sys

bin_dir, stage = (Path(p).resolve() for p in sys.argv[1:])
package = stage / "package"
releases = bin_dir / ".tokfit-codex-releases"
link = bin_dir / "tokfit-codex"
if releases.is_symlink() or (link.is_symlink() and link.resolve().parent != releases) or (link.exists() and not link.is_symlink()):
    sys.exit(f"Installation impossible : le chemin de tokfit est déjà occupé dans {bin_dir}.")
digest = hashlib.sha256()
for path in sorted(package.rglob("*.py")):
    data = path.read_bytes()
    compile(data, str(path), "exec")
    digest.update(str(path.relative_to(package)).encode() + b"\0" + hashlib.sha256(data).digest())
releases.mkdir(exist_ok=True)
release = releases / digest.hexdigest()
try:
    package.rename(release)
except OSError:
    if not release.is_dir() or release.is_symlink():
        raise
pending = stage / "current"
pending.symlink_to(release.relative_to(bin_dir))
os.replace(pending, link)
INSTALL_PACKAGE
  chmod 755 "$stage/launcher"
  mv -f -- "$stage/launcher" "$bin/$NAME"
  rm -rf -- "$stage"
  trap - EXIT INT TERM
  printf '%s : lanceur installé (%s) ; lance « %s codex \"ta demande\" ».\n' "$NAME" "$bin/$NAME" "$NAME"
  # Agent d'exécution léger de Codex (tokfit_executor), à qui le modèle de la session délègue un travail décidé.
  "$bin/$NAME" _agent || printf '%s : agent d’exécution non installé.\n' "$NAME"
  python3 -I "$bin/tokfit-codex/register_mcp.py" "$(cd -- "$bin" && pwd)/$NAME" ||
    fail "le lanceur est installé, mais Codex n’a pas enregistré les outils ; relance l’installation après avoir corrigé le problème indiqué."
  codex_path_hint
}
# Une installation qui échoue garde son statut et ses nettoyages, et les autres
# clients sont essayés. Le sous-shell n'est pas une condition (set -e y agit).
status=0
installed=""
set +e
for client in $selected; do
  (set -e; adapter install "$client")
  result=$?
  if [ "$result" -ne 0 ]; then
    printf '%s : installation %s en échec.\n' "$NAME" "$client" >&2
    status=$result
  else
    installed="$installed $client"
  fi
done
set -e

# Bilan : le service est-il joignable d'ici, et que faire maintenant dans chaque outil installé.
if [ -n "$installed" ]; then
  if ! command -v curl >/dev/null 2>&1; then
    printf '%s : curl introuvable, service non vérifié (%s/health).\n' "$NAME" "$url"
  elif curl -fsS --max-time 10 -o /dev/null "$url/health" 2>/dev/null; then
    printf '%s : service tokfit joignable (%s).\n' "$NAME" "$url"
  else
    printf '%s : service injoignable pour l’instant (%s/health) : tes outils marchent comme avant, tokfit reprend dès qu’il le joint.\n' "$NAME" "$url"
  fi
  printf '\nEnsuite :\n'
  case "$installed" in
    *" claude"*)
      printf '  - Claude Code : ouvre une nouvelle session. L’essai démarre sans clé. /tokfit affiche ton bilan et permet de rattacher ton essai à ton compte. /plugin permet de désactiver Tokfit.\n'
      printf '  - Pour le routage, le service Tokfit reçoit des extraits de la conversation. Le routage bêta peut faire appel à un fournisseur externe. Le service Tokfit ne conserve pas ces textes. Confidentialité : https://tokfit.fr/confidentialite\n'
      ;;
  esac
  case "$installed" in
    *" codex"*)
      printf '  - Codex : ouvre une nouvelle session, l’outil agir est prêt.\n'
      if [ ! -f "$config" ] || ! grep -q '"key"' "$config" 2>/dev/null; then
        printf '  - Essai Codex sans compte : « tokfit compte » rattache cet appareil à ton compte.\n'
      fi
      ;;
  esac
fi
exit "$status"

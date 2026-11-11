#!/bin/sh
# Installe un connecteur du service (tokfit) en une
# commande : la clé du client est écrite dans ~/.config/tokfit/config.json
# (droits 600, hors de tout dépôt), puis
#   - claude (défaut) : le plugin est installé dans Claude Code (CLI et onglet
#     Code de Claude Desktop, qui lisent la même configuration) ;
#   - codex : le lanceur `tokfit codex …` est posé dans ~/.local/bin.
#
#   sh install.sh [claude|codex]               demande la clé (saisie masquée)
#   TOKFIT_KEY=ek_… sh install.sh codex   sans question (automatisation, essais)
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
set -eu

NAME=tokfit
# Adresse officielle du service et dépôt public du connecteur : vides dans le
# dépôt de travail, posés par connector/publish.py dans la copie publique.
# Vides, TOKFIT_URL est obligatoire et le script se lance depuis un clone.
DEFAULT_URL="https://tokfit.dodoia.re"
REPO="loisperrigon/tokfit-connector"
RUNTIME="__init__.py relay.py output.py process.py cursor.py completion.py"

fail() {
  printf '%s : %s\n' "$NAME" "$1" >&2
  exit 1
}

target="${1:-claude}"
# Dossier du script, seulement s'il est lancé comme fichier install.sh : par `curl … | sh`,
# $0 est « sh » et le dossier courant n'est jamais une source de confiance.
here=""
case "$0" in
  install.sh | */install.sh)
    [ -f "$0" ] && here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) ;;
esac
url="${TOKFIT_URL:-$DEFAULT_URL}"
market="${TOKFIT_SOURCE:-${here:-$REPO}}"
raw="${TOKFIT_RAW_URL:-${REPO:+https://raw.githubusercontent.com/$REPO/main}}"
config="${TOKFIT_CONFIG:-$HOME/.config/$NAME/config.json}"
bin="${TOKFIT_BIN:-$HOME/.local/bin}"

case "$target" in
  claude)
    command -v claude >/dev/null 2>&1 || fail "Claude Code introuvable (commande claude) : installe-le d'abord."
    [ -n "$market" ] || fail "source du plugin inconnue (TOKFIT_SOURCE) : lance le script depuis un clone du dépôt." ;;
  codex)
    command -v codex >/dev/null 2>&1 || fail "Codex CLI introuvable (commande codex) : installe-le d'abord."
    python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null \
      || fail "Python 3.9 ou plus récent introuvable (commande python3)."
    if [ -z "$here" ]; then
      [ -n "$raw" ] || fail "source du lanceur inconnue (TOKFIT_RAW_URL) : lance le script depuis un clone du dépôt."
      command -v curl >/dev/null 2>&1 || fail "curl introuvable : installe-le, ou lance le script depuis un clone du dépôt."
    fi ;;
  *) fail "cible inconnue : $target (claude ou codex)." ;;
esac

case "$url" in
  https://?* | http://127.0.0.1 | http://127.0.0.1:* | http://127.0.0.1/* | http://localhost | http://localhost:* | http://localhost/*) ;;
  "") fail "adresse du service inconnue (TOKFIT_URL)." ;;
  *) fail "adresse du service refusée : https attendu." ;;
esac
case "$url" in
  *[!A-Za-z0-9.:/_~%-]*) fail "adresse du service refusée : caractères inattendus." ;;
esac

if [ -n "${TOKFIT_KEY-}" ]; then
  key="$TOKFIT_KEY"
elif [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
  printf 'Clé %s (ek_…, saisie masquée) : ' "$NAME" >/dev/tty
  stty -echo </dev/tty
  trap 'stty echo </dev/tty' EXIT INT TERM
  IFS= read -r key </dev/tty || key=""
  stty echo </dev/tty
  trap - EXIT INT TERM
  printf '\n' >/dev/tty
else
  fail "clé absente : lance la commande dans un terminal, ou pose TOKFIT_KEY."
fi

case "$key" in
  ek_*) ;;
  *) fail "clé refusée : elle commence par ek_." ;;
esac
case "${key#ek_}" in
  "" | *[!A-Za-z0-9_-]*) fail "clé refusée : caractères inattendus." ;;
esac
[ "${#key}" -ge 23 ] && [ "${#key}" -le 203 ] || fail "clé refusée : longueur inattendue."

umask 077
dir=$(dirname -- "$config")
mkdir -p -- "$dir"
# Dossier propre au connecteur : fermé aux autres comptes de la machine.
[ -n "${TOKFIT_CONFIG-}" ] || chmod 700 "$dir"
tmp=$(mktemp "$dir/.config.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT INT TERM
printf '{"url": "%s", "key": "%s"}\n' "$url" "$key" >"$tmp"
chmod 600 "$tmp"
mv -f -- "$tmp" "$config"
trap - EXIT INT TERM

fetch() { # chemin dans le dépôt, destination : copie du clone, sinon téléchargement
  if [ -n "$here" ]; then
    cp -- "$here/$1" "$2"
  else
    curl -fsSL --max-time 30 -o "$2" "$raw/$1" || fail "téléchargement impossible : $1 ($raw)."
  fi
}

if [ "$target" = codex ]; then
  mkdir -p -- "$bin"
  umask 022
  # Tout est d'abord réuni et contrôlé à part : un téléchargement raté n'installe rien.
  stage=$(mktemp -d "$bin/.$NAME.XXXXXX")
  trap 'rm -rf -- "$stage"' EXIT INT TERM
  fetch codex/launcher.py "$stage/launcher"
  head -c 2 "$stage/launcher" | grep -q '^#!' || fail "le lanceur reçu n'est pas un script : rien n'est installé."
  mkdir -- "$stage/runtime"
  for file in $RUNTIME; do
    fetch "runtime/$file" "$stage/runtime/$file"
    chmod 644 "$stage/runtime/$file"
  done
  chmod 755 "$stage/launcher"
  mkdir -p -- "$bin/runtime"
  for file in $RUNTIME; do
    mv -f -- "$stage/runtime/$file" "$bin/runtime/$file"
  done
  mv -f -- "$stage/launcher" "$bin/$NAME"
  rm -rf -- "$stage"
  trap - EXIT INT TERM
  printf '%s : lanceur installé (%s) ; lance « %s codex \"ta demande\" ».\n' "$NAME" "$bin/$NAME" "$NAME"
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) printf '%s : ajoute %s à ton PATH pour taper « %s codex ».\n' "$NAME" "$bin" "$NAME" ;;
  esac
  exit 0
fi

claude plugin install "$NAME" --marketplace "$market"
printf '%s : connecteur installé ; il agit dès la prochaine session Claude Code.\n' "$NAME"

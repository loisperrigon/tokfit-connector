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
#
# Variables facultatives :
#   TOKFIT_URL     adresse du service (https, ou http://127.0.0.1 pour essayer)
#   TOKFIT_SOURCE  marketplace du plugin : dossier, dépôt git ou owner/repo
#                       (défaut : le dossier de ce script)
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
# Adresse du service une fois en ligne : à poser à la publication (domaine
# pas encore acheté). D'ici là, TOKFIT_URL est obligatoire.
DEFAULT_URL=""

fail() {
  printf '%s : %s\n' "$NAME" "$1" >&2
  exit 1
}

target="${1:-claude}"
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
url="${TOKFIT_URL:-$DEFAULT_URL}"
market="${TOKFIT_SOURCE:-$here}"
config="${TOKFIT_CONFIG:-$HOME/.config/$NAME/config.json}"
bin="${TOKFIT_BIN:-$HOME/.local/bin}"

case "$target" in
  claude)
    command -v claude >/dev/null 2>&1 || fail "Claude Code introuvable (commande claude) : installe-le d'abord." ;;
  codex)
    command -v codex >/dev/null 2>&1 || fail "Codex CLI introuvable (commande codex) : installe-le d'abord."
    python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null \
      || fail "Python 3.9 ou plus récent introuvable (commande python3)." ;;
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

if [ "$target" = codex ]; then
  mkdir -p -- "$bin"
  umask 022
  cp -- "$here/codex/launcher.py" "$bin/$NAME"
  chmod 755 "$bin/$NAME"
  printf '%s : lanceur installé (%s) ; lance « %s codex \"ta demande\" ».\n' "$NAME" "$bin/$NAME" "$NAME"
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) printf '%s : ajoute %s à ton PATH pour taper « %s codex ».\n' "$NAME" "$bin" "$NAME" ;;
  esac
  exit 0
fi

claude plugin install "$NAME" --marketplace "$market"
printf '%s : connecteur installé ; il agit dès la prochaine session Claude Code.\n' "$NAME"

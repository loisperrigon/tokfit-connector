#!/bin/sh
# tokfit : lanceur du serveur MCP `outils` (kernel/server.py) et des hooks écrits en Python.
#
# Claude Code le lance par l'interpréteur (`sh …/launch.sh`), jamais comme exécutable : une copie du plugin qui
# perd les droits (fichiers en 0600) marche quand même. Appelants : `mcpServers.outils` de plugin.json (commande
# `${ComSpec:-sh}` : sh partout sauf sous Windows, où ComSpec désigne cmd.exe, qui lance kernel/launch.ps1 ; les
# arguments destinés à cmd.exe, `/d /c …`, arrivent ici après le chemin du lanceur et sont ignorés), hook Stop de
# hooks.json (commande lue par sh, ou par PowerShell sous Windows sans Git Bash). Sous Windows avec Git Bash, le
# hook passe par ici : même cache, même Python que launch.ps1. Rien n'est écrit sur stdout sauf le protocole MCP ;
# le journal va sur stderr et dans le cache.
#
# Python : d'abord celui que tokfit a déjà installé dans son cache, sinon un Python déjà présent sur la machine
# (python3, puis python, du PATH) s'il atteint MINIMUM et passe le test d'import des modules du noyau : rien
# n'est alors téléchargé. Sans l'un ni l'autre, tokfit installe le sien (python.pins : CPython de
# python-build-standalone, version, publication et SHA-256 épinglés). Sous macOS sans outils de développement,
# /usr/bin/python3 n'est qu'un relais qui ouvre la fenêtre d'installation de ces outils : jamais lancé.
# Toujours lancé avec -I : ni PYTHONPATH, ni PYTHONHOME, ni site de l'utilisateur, ni dossier courant (venv
# activé, conda, pyenv, Python cassé n'y changent rien).
#
# Sans Python prêt au démarrage (première session), l'installation part en arrière-plan et ce lanceur répond
# lui-même au protocole MCP minimal (initialize, tools/list vide, ping). Dès que Python est prêt, il envoie
# `notifications/tools/list_changed` ; la demande suivante passe au vrai serveur (exec : mêmes stdin et stdout),
# qui reprend la session déjà ouverte (TOKFIT_MCP_REPRISE) et répond à cette demande (TOKFIT_MCP_ATTENTE).
#
# Modes : (aucun, ou `/d …` de plugin.json) serveur MCP ; `hook <script> [arguments…]` : script Python d'un hook,
# rien sans Python prêt ;
# `installer` : installation au premier plan (appel interne) ; `etat` : état en JSON (diagnostic, essais).
# Réglages : TOKFIT_PYTHON (interpréteur imposé, gardé s'il passe le test), TOKFIT_PYTHON_INSTALL=0
# (jamais d'installation), TOKFIT_CACHE_DIR (cache, ${XDG_CACHE_HOME:-~/.cache}/tokfit par défaut),
# TOKFIT_PYTHON_MIRROR (miroir des archives, même arborescence), TOKFIT_PYTHON_PINS (autre épinglage).
# État lu par le connecteur (hooks/python.ts) : <cache>/python/install.json et launch.json.
set -u
umask 022

ICI=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P) || { printf 'tokfit: dossier du lanceur introuvable\n' >&2; exit 1; }
LANCEUR="$ICI/launch.sh"
CR=$(printf '\r')
# Versions du protocole MCP acceptées, la première par défaut (PROTOCOLES de kernel/server.py).
PROTOCOLES="2025-06-18 2025-03-26 2024-11-05"
# Nom et version du serveur (NOM et VERSION de kernel/server.py).
SERVEUR_NOM=outils
SERVEUR_VERSION=1.0.0
# Échec d'installation récent : pas de nouvel essai avant ce délai (secondes).
REESSAI_S=600
# Verrou d'installation plus vieux que ce délai (minutes) : repris, quel que soit son processus.
VERROU_MAX_MIN=30
# Fichiers d'autorités de certification connus, si l'utilisateur n'en impose aucun (SSL_CERT_FILE, SSL_CERT_DIR).
CERTIFICATS="/etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem /etc/ssl/ca-bundle.pem /etc/pki/tls/cacert.pem /etc/ssl/cert.pem /usr/local/etc/openssl/cert.pem /opt/homebrew/etc/openssl@3/cert.pem"

journal() { printf 'tokfit: %s\n' "$*" >&2; }

# --- Épinglage ---------------------------------------------------------------------------------------------
PINS=${TOKFIT_PYTHON_PINS:-$ICI/python.pins}
lire_pins() {
  [ -r "$PINS" ] || return 1
  while IFS='=' read -r cle valeur || [ -n "$cle" ]; do
    valeur=${valeur%"$CR"}
    case $cle in ''|\#*|*[!A-Za-z0-9_]*) continue ;; esac
    case $valeur in *[!A-Za-z0-9._:/+%@-]*) continue ;; esac
    eval "PIN_$cle=\$valeur"
  done < "$PINS"
}
PIN_VERSION= PIN_RELEASE= PIN_MINIMUM=3.9 PIN_FLAVOR= PIN_BASE_URL=
lire_pins || journal "épinglage illisible : $PINS"
MIN_MAJ=${PIN_MINIMUM%%.*}
MIN_MIN=${PIN_MINIMUM#*.}
# Test d'un interpréteur : version minimale, modules du noyau et du connecteur, TLS. Écrit « tokfit-ok X.Y.Z ».
TEST_PYTHON="import sys
assert sys.version_info[:2] >= ($MIN_MAJ, $MIN_MIN)
import ast, base64, collections, dataclasses, difflib, fnmatch, functools, hashlib, inspect, json, linecache, logging
import os, pathlib, re, select, shlex, shutil, signal, site, ssl, subprocess, tempfile, threading, time, traceback
import types, typing, unicodedata, urllib.error, urllib.parse, urllib.request, zlib
ssl.create_default_context()
print('tokfit-ok %d.%d.%d' % sys.version_info[:3])"

# --- Cible et cache ----------------------------------------------------------------------------------------
libc_musl() {
  sortie=$(ldd --version 2>&1)
  case $sortie in *musl*) return 0 ;; *GNU*|*GLIBC*|*glibc*) return 1 ;; esac
  for f in /lib/ld-linux* /lib64/ld-linux* /lib/*/ld-linux*; do [ -e "$f" ] && return 1; done
  for f in /lib/ld-musl-*; do [ -e "$f" ] && return 0; done
  return 1
}

detecter_cible() {
  os=$(uname -s 2>/dev/null) arch=$(uname -m 2>/dev/null)
  case $arch in
    x86_64|amd64|AMD64) arch=x86_64 ;;
    aarch64|arm64|ARM64) arch=aarch64 ;;
    *) return 0 ;;
  esac
  case $os in
    Linux) if libc_musl; then printf '%s-unknown-linux-musl' "$arch"; else printf '%s-unknown-linux-gnu' "$arch"; fi ;;
    Darwin)
      # Terminal sous Rosetta sur une puce Apple : la version arm64.
      [ "$arch" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] && arch=aarch64
      printf '%s-apple-darwin' "$arch" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) printf '%s-pc-windows-msvc' "$arch" ;;
  esac
}

CIBLE=$(detecter_cible)
CLE_CIBLE=$(printf '%s' "$CIBLE" | tr '-' '_')
SHA=
TAILLE=
if [ -n "$CIBLE" ]; then
  eval "SHA=\${PIN_SHA256_$CLE_CIBLE:-}"
  eval "TAILLE=\${PIN_SIZE_$CLE_CIBLE:-}"
fi
NOM="cpython-$PIN_VERSION+$PIN_RELEASE-$CIBLE"
ARCHIVE="$NOM-$PIN_FLAVOR.tar.gz"
URL="${TOKFIT_PYTHON_MIRROR:-$PIN_BASE_URL}/$PIN_RELEASE/cpython-$PIN_VERSION%2B$PIN_RELEASE-$CIBLE-$PIN_FLAVOR.tar.gz"
case $CIBLE in *windows*) EXE_RELATIF=python.exe ;; *) EXE_RELATIF=bin/python3 ;; esac

if [ -n "${TOKFIT_CACHE_DIR:-}" ]; then CACHE=$TOKFIT_CACHE_DIR
elif [ -n "${XDG_CACHE_HOME:-}" ]; then CACHE=$XDG_CACHE_HOME/tokfit
else CACHE=${HOME:-/tmp}/.cache/tokfit
fi
PYDIR="$CACHE/python"
DIR="$PYDIR/$NOM"
EXE="$DIR/$EXE_RELATIF"
ETAT_INSTALL="$PYDIR/install.json"
ETAT_LANCEMENT="$PYDIR/launch.json"
LOG="$PYDIR/install.log"
VERROU="$PYDIR/.verrou"
DEPART=$(date +%s 2>/dev/null || echo 0)

maintenant() { date +%s 2>/dev/null || echo 0; }

json_chaine() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r'; }

ecrire_json() {
  mkdir -p "$PYDIR" 2>/dev/null || return 0
  printf '%s\n' "$2" > "$1.$$" 2>/dev/null && mv -f "$1.$$" "$1" 2>/dev/null || rm -f "$1.$$" 2>/dev/null
  return 0
}

ecrire_install() {  # état raison détail
  ecrire_json "$ETAT_INSTALL" "{\"state\":\"$1\",\"reason\":\"$2\",\"detail\":\"$3\",\"version\":\"$PIN_VERSION\",\"target\":\"$CIBLE\",\"at\":$(maintenant),\"pid\":$$}"
}

ecrire_lancement() {  # source raison détail (chemin et version de PY)
  ecrire_json "$ETAT_LANCEMENT" "{\"source\":\"$1\",\"reason\":\"$2\",\"detail\":\"$3\",\"path\":\"$(json_chaine "${PY:-}")\",\"version\":\"${PY_VERSION:-}\",\"target\":\"$CIBLE\",\"at\":$(maintenant)}"
}

champ() {  # fichier champ → valeur (chaîne ou nombre) d'un JSON écrit par ce lanceur
  contenu=$(cat "$1" 2>/dev/null) || return 1
  reste=${contenu#*\""$2"\":}
  [ "$reste" = "$contenu" ] && return 1
  case $reste in
    \"*) reste=${reste#\"}; printf '%s' "${reste%%\"*}" ;;
    *) printf '%s' "${reste%%[,\}]*}" ;;
  esac
}

# --- Interpréteurs -----------------------------------------------------------------------------------------
PY= PY_VERSION= SOURCE=
python_valide() {  # chemin → vrai s'il passe le test ; PY_VERSION posé
  [ -n "$1" ] || return 1
  sortie=$("$1" -I -c "$TEST_PYTHON" 2>/dev/null) || return 1
  case $sortie in
    tokfit-ok\ *) PY_VERSION=${sortie#tokfit-ok }; return 0 ;;
  esac
  return 1
}

gere_pret() { [ -f "$DIR/.tokfit-ok" ] && [ -x "$EXE" ]; }

# Python imposé (s'il passe le test), sinon celui de tokfit déjà installé.
choisir() {
  if [ -n "${TOKFIT_PYTHON:-}" ] && [ -z "${FORCE_REFUSE:-}" ]; then
    if python_valide "$TOKFIT_PYTHON"; then PY=$TOKFIT_PYTHON; SOURCE=forced; return 0; fi
    FORCE_REFUSE=1
    journal "TOKFIT_PYTHON ignoré : version inférieure à $PIN_MINIMUM ou modules absents ($TOKFIT_PYTHON)"
  fi
  if gere_pret; then
    PY=$EXE SOURCE=managed PY_VERSION=$PIN_VERSION
    touch "$DIR/.tokfit-ok" 2>/dev/null
    return 0
  fi
  return 1
}

# Relais de macOS (/usr/bin/python3 sans outils de développement installés) : le lancer ouvrirait la fenêtre
# d'installation de ces outils. RELAIS_MACOS : chemin du relais (changé par les essais seulement).
RELAIS_MACOS=${TOKFIT_RELAIS_MACOS:-/usr/bin/python3}
relais_macos() {
  [ "$1" = "$RELAIS_MACOS" ] && [ "$(uname -s 2>/dev/null)" = Darwin ] || return 1
  ! xcode-select -p >/dev/null 2>&1
}

# Python déjà présent sur la machine (premier qui passe le test) : utilisé avant toute installation.
systeme() {
  for nom in python3 python; do
    chemin=$(command -v "$nom" 2>/dev/null) || continue
    case $chemin in /*|[A-Za-z]:*) ;; *) continue ;; esac
    relais_macos "$chemin" && continue
    case $chemin in */WindowsApps/*) continue ;; esac  # alias du Microsoft Store (Git Bash) : ouvrirait le Store
    if python_valide "$chemin"; then PY=$chemin; SOURCE=system; return 0; fi
  done
  return 1
}

# --- Outils de la machine ----------------------------------------------------------------------------------
a() { command -v "$1" >/dev/null 2>&1; }

wget_busybox() {
  chemin=$(command -v wget 2>/dev/null) || return 1
  case $(wget --help 2>&1) in *BusyBox*|*busybox*) return 0 ;; esac
  return 1
}

python_ancien() {  # n'importe quel Python capable de télécharger (2.7 compris), hors du test du noyau
  for nom in python3 python; do
    chemin=$(command -v "$nom" 2>/dev/null) || continue
    relais_macos "$chemin" && continue
    "$chemin" -E -s -c 'import sys' >/dev/null 2>&1 && { printf '%s' "$chemin"; return 0; }
  done
  return 1
}

outil_telechargement() {
  if a curl; then echo curl
  elif a wget && ! wget_busybox; then echo wget
  elif a wget; then echo busybox-wget-applet
  elif a busybox && busybox wget --help >/dev/null 2>&1; then echo busybox
  elif a node; then echo node
  elif python_ancien >/dev/null; then echo python
  fi
}

outil_somme() {
  if a sha256sum; then echo sha256sum
  elif a shasum; then echo shasum
  elif a openssl; then echo openssl
  elif python_ancien >/dev/null; then echo python
  elif a node; then echo node
  fi
}

empreinte() {  # fichier → SHA-256 en hexadécimal minuscule
  case $(outil_somme) in
    sha256sum) s=$(sha256sum "$1") || return 1 ;;
    shasum) s=$(shasum -a 256 "$1") || return 1 ;;
    openssl) s=$(openssl dgst -sha256 -r "$1") || return 1 ;;
    python) s=$("$(python_ancien)" -E -s -c 'import hashlib, sys
h = hashlib.sha256()
f = open(sys.argv[1], "rb")
for b in iter(lambda: f.read(1 << 20), b""):
    h.update(b)
print(h.hexdigest())' "$1") || return 1 ;;
    node) s=$(node -e 'const h=require("crypto").createHash("sha256");const s=require("fs").createReadStream(process.argv[1]);s.on("data",d=>h.update(d));s.on("end",()=>console.log(h.digest("hex")));s.on("error",()=>process.exit(1))' "$1") || return 1 ;;
    *) return 1 ;;
  esac
  s=${s%% *}
  printf '%s' "$s" | tr 'A-F' 'a-f'
}

# Mandataire : les outils qui ne lisent que les noms en minuscules le voient aussi.
[ -z "${https_proxy:-}" ] && [ -n "${HTTPS_PROXY:-}" ] && export https_proxy="$HTTPS_PROXY"
[ -z "${http_proxy:-}" ] && [ -n "${HTTP_PROXY:-}" ] && export http_proxy="$HTTP_PROXY"
[ -z "${no_proxy:-}" ] && [ -n "${NO_PROXY:-}" ] && export no_proxy="$NO_PROXY"

NODE_TELECHARGER='const https=require("https"),http=require("http"),fs=require("fs");
const [adresse,sortie]=process.argv.slice(1);
const mandataire=process.env.https_proxy||process.env.HTTPS_PROXY||"";
const exclus=(process.env.no_proxy||process.env.NO_PROXY||"").split(",").map(s=>s.trim()).filter(Boolean);
function echec(m){console.error("node: "+m);process.exit(1)}
setTimeout(()=>echec("délai total dépassé"),1500000).unref();
function direct(h){return exclus.some(e=>e==="*"||h===e||h.endsWith(e.startsWith(".")?e:"."+e))}
function obtenir(u,n){
  if(n>10)return echec("trop de redirections");
  const c=new URL(u),port=Number(c.port)||443;
  const options={host:c.hostname,port,path:c.pathname+c.search,headers:{"user-agent":"tokfit"},servername:c.hostname};
  const partir=(socket)=>{
    if(socket){options.socket=socket;options.agent=false}
    const r=https.get(options,(rep)=>{
      if([301,302,303,307,308].includes(rep.statusCode)&&rep.headers.location){rep.resume();return obtenir(new URL(rep.headers.location,u).href,n+1)}
      if(rep.statusCode!==200)return echec("HTTP "+rep.statusCode);
      const f=fs.createWriteStream(sortie);rep.pipe(f);
      f.on("finish",()=>f.close(()=>process.exit(0)));rep.on("error",(e)=>echec(e.message));f.on("error",(e)=>echec(e.message));
    });
    r.setTimeout(30000,()=>r.destroy(new Error("aucune donnée depuis 30 s")));r.on("error",(e)=>echec(e.message));
  };
  if(!mandataire||direct(c.hostname))return partir();
  const m=new URL(mandataire),entetes={};
  if(m.username)entetes["proxy-authorization"]="Basic "+Buffer.from(decodeURIComponent(m.username)+":"+decodeURIComponent(m.password)).toString("base64");
  const t=http.request({host:m.hostname,port:Number(m.port)||80,method:"CONNECT",path:c.hostname+":"+port,headers:entetes});
  t.setTimeout(30000,()=>t.destroy(new Error("mandataire muet")));
  t.on("connect",(rep,socket)=>{if(rep.statusCode!==200)return echec("mandataire : HTTP "+rep.statusCode);partir(socket)});
  t.on("error",(e)=>echec(e.message));t.end();
}
obtenir(adresse,0);'

PYTHON_TELECHARGER='import sys
try:
    from urllib.request import urlopen
except ImportError:
    from urllib2 import urlopen
reponse = urlopen(sys.argv[1], timeout=60)
sortie = open(sys.argv[2], "wb")
while True:
    bloc = reponse.read(1 << 16)
    if not bloc:
        break
    sortie.write(bloc)
sortie.close()'

telecharger_une_fois() {  # outil adresse fichier ; curl reprend un fichier partiel, les autres repartent de zéro
  case $1 in
    curl) curl -fsSL -C - --connect-timeout 20 --speed-time 60 --speed-limit 1024 --max-time 1500 -o "$3" "$2" ;;
    wget) rm -f "$3"; wget -q --tries=1 --timeout=60 -O "$3" "$2" ;;
    busybox-wget-applet) rm -f "$3"; wget -q -T 60 -O "$3" "$2" ;;
    busybox) rm -f "$3"; busybox wget -q -T 60 -O "$3" "$2" ;;
    node) rm -f "$3"; node -e "$NODE_TELECHARGER" "$2" "$3" ;;
    python) rm -f "$3"; "$(python_ancien)" -E -s -c "$PYTHON_TELECHARGER" "$2" "$3" ;;
    *) return 1 ;;
  esac
}

taille_de() { wc -c < "$1" 2>/dev/null | tr -d ' '; }

telecharger() {  # adresse fichier → trois essais, fichier partiel jeté quand il ne peut pas servir
  outil=$(outil_telechargement)
  [ -n "$outil" ] || return 1
  journal "téléchargement de $ARCHIVE ($outil)"
  essai=1
  while [ $essai -le 3 ]; do
    if [ -n "$TAILLE" ] && [ -f "$2" ] && [ "$(taille_de "$2")" -gt "$TAILLE" ] 2>/dev/null; then rm -f "$2"; fi
    if [ -n "$TAILLE" ] && [ -f "$2" ] && [ "$(taille_de "$2")" = "$TAILLE" ]; then return 0; fi
    if telecharger_une_fois "$outil" "$1" "$2"; then return 0; fi
    journal "essai $essai de téléchargement échoué ($outil)"
    # Reprise refusée par le serveur ou fichier abîmé : l'essai suivant repart de zéro.
    [ $essai -ge 2 ] && rm -f "$2"
    sleep $((essai * 2))
    essai=$((essai + 1))
  done
  return 1
}

extraire() {  # archive dossier
  tar -xzf "$1" -C "$2" 2>/dev/null && return 0
  rm -rf "$2"/* 2>/dev/null
  a gzip && gzip -dc "$1" | tar -xf - -C "$2"
}

# --- Installation ------------------------------------------------------------------------------------------
# Raison pour laquelle l'installation est impossible ici (vide si elle est possible).
impossible() {
  if [ "${TOKFIT_PYTHON_INSTALL:-1}" = 0 ]; then echo disabled
  elif [ -z "$CIBLE" ] || [ -z "$SHA" ] || [ -z "$PIN_VERSION" ]; then echo unsupported_platform
  elif [ -z "$(outil_telechargement)" ]; then echo no_downloader
  elif [ -z "$(outil_somme)" ]; then echo no_hash_tool
  elif ! a tar; then echo no_tar
  elif ! mkdir -p "$PYDIR" 2>/dev/null || [ ! -w "$PYDIR" ]; then echo no_cache_dir
  fi
}

vieux() {  # chemin minutes → vrai si plus vieux
  [ -n "$(find "$1" -maxdepth 0 -mmin +"$2" 2>/dev/null)" ]
}

installation_en_cours() {
  [ -d "$VERROU" ] || return 1
  pid=$(cat "$VERROU/pid" 2>/dev/null)
  if [ -z "$pid" ]; then vieux "$VERROU" 2 && return 1; return 0; fi
  kill -0 "$pid" 2>/dev/null || return 1
  vieux "$VERROU" "$VERROU_MAX_MIN" && return 1
  return 0
}

# Verrou = création exclusive du fichier pid par le shell (`set -C` : O_EXCL), jamais le code de retour de
# `mkdir` : celui des coreutils réécrits en Rust (uutils 0.10, Ubuntu 26.04) répond parfois « créé » à deux
# processus à la fois, et les deux téléchargeaient.
poser_pid() {
  mkdir -p "$VERROU" 2>/dev/null
  ( set -C; echo $$ > "$VERROU/pid" ) 2>/dev/null
}

prendre_verrou() {
  poser_pid && return 0
  installation_en_cours && return 1
  journal "verrou d'installation abandonné repris"
  rm -rf "$VERROU"
  poser_pid
}

rendre_verrou() {
  [ "$(cat "$VERROU/pid" 2>/dev/null)" = $$ ] && rm -rf "$VERROU"
  return 0
}

echec_recent() {
  [ "$(champ "$ETAT_INSTALL" state)" = failed ] || return 1
  [ "$(champ "$ETAT_INSTALL" version)" = "$PIN_VERSION" ] || return 1
  quand=$(champ "$ETAT_INSTALL" at) || return 1
  case $quand in ''|*[!0-9]*) return 1 ;; esac
  [ $(( $(maintenant) - quand )) -lt $REESSAI_S ]
}

nettoyer() {  # dossiers temporaires d'installations interrompues, anciennes versions inutilisées depuis 30 jours
  for d in "$PYDIR"/.tmp-*; do
    [ -d "$d" ] || continue
    kill -0 "${d##*.tmp-}" 2>/dev/null || rm -rf "$d"
  done
  for d in "$PYDIR"/cpython-*; do
    [ -d "$d" ] && [ "$d" != "$DIR" ] || continue
    vieux "$d/.tokfit-ok" 43200 && rm -rf "$d"
  done
  return 0
}

echouer() {  # raison détail
  journal "installation de Python échouée : $2"
  ecrire_install failed "$1" "$2"
  [ -n "${TMP_INSTALL:-}" ] && rm -rf "$TMP_INSTALL"
  rendre_verrou
  exit 1
}

installer() {
  raison=$(impossible)
  if [ -n "$raison" ]; then ecrire_install failed python_missing "$raison"; return 1; fi
  prendre_verrou || { journal "installation déjà en cours"; return 0; }
  trap 'rendre_verrou' EXIT
  trap 'ecrire_install failed install_failed interrupted; rendre_verrou; exit 1' INT TERM HUP
  if gere_pret; then ecrire_install ready "" ""; rendre_verrou; return 0; fi
  ecrire_install installing "" ""
  nettoyer
  TMP_INSTALL="$PYDIR/.tmp-$$"
  rm -rf "$TMP_INSTALL"
  mkdir -p "$TMP_INSTALL" || echouer install_failed disk
  partiel="$PYDIR/$ARCHIVE.part"
  telecharger "$URL" "$partiel" || echouer install_failed download
  somme=$(empreinte "$partiel") || echouer install_failed no_hash_tool
  if [ "$somme" != "$SHA" ]; then
    rm -f "$partiel"
    echouer install_failed checksum
  fi
  extraire "$partiel" "$TMP_INSTALL" || echouer install_failed extract
  [ -x "$TMP_INSTALL/python/$EXE_RELATIF" ] || echouer install_failed extract
  python_valide "$TMP_INSTALL/python/$EXE_RELATIF" || echouer install_failed verify
  printf '%s\n' "$PY_VERSION" > "$TMP_INSTALL/python/.tokfit-ok" || echouer install_failed disk
  if ! mv "$TMP_INSTALL/python" "$DIR" 2>/dev/null; then
    gere_pret || echouer install_failed disk
  fi
  rm -rf "$TMP_INSTALL" "$partiel"
  TMP_INSTALL=
  ecrire_install ready "" ""
  journal "Python $PY_VERSION installé : $DIR"
  rendre_verrou
  return 0
}

installer_en_fond() {
  mkdir -p "$PYDIR" 2>/dev/null || return 0
  if [ -f "$LOG" ] && [ "$(taille_de "$LOG")" -gt 1048576 ] 2>/dev/null; then : > "$LOG"; fi
  if a setsid; then
    (setsid sh "$LANCEUR" installer </dev/null >/dev/null 2>>"$LOG" &)
  else
    (trap '' HUP; sh "$LANCEUR" installer </dev/null >/dev/null 2>>"$LOG" &)
  fi
  LANCEE=$(maintenant)
}

# --- Lancement ---------------------------------------------------------------------------------------------
certificats() {
  [ "$SOURCE" = managed ] || return 0
  [ -n "${SSL_CERT_FILE:-}" ] || [ -n "${SSL_CERT_DIR:-}" ] && return 0
  case $CIBLE in *windows*|*darwin*) ;; *)
    for f in $CERTIFICATS; do
      [ -s "$f" ] && { export SSL_CERT_FILE="$f"; return 0; }
    done ;;
  esac
  case $CIBLE in *windows*) return 0 ;; esac
  [ -s /etc/ssl/cert.pem ] && { export SSL_CERT_FILE=/etc/ssl/cert.pem; return 0; }
  # Aucune autorité sur la machine (images Node « slim ») : celles que Node embarque, exportées une fois.
  ca="$CACHE/ca-node.pem"
  if [ ! -s "$ca" ] && a node; then
    mkdir -p "$CACHE" 2>/dev/null
    if node -e 'process.stdout.write(require("tls").rootCertificates.join("\n")+"\n")' > "$ca.$$" 2>/dev/null && [ -s "$ca.$$" ]; then
      mv -f "$ca.$$" "$ca"
    else
      rm -f "$ca.$$"
    fi
  fi
  [ -s "$ca" ] && export SSL_CERT_FILE="$ca"
  return 0
}

lancer_serveur() {
  ecrire_lancement "$SOURCE" "" ""
  certificats
  exec "$PY" -I -X utf8 "$ICI/server.py"
}

# --- Répondeur MCP minimal ---------------------------------------------------------------------------------
repondre() { printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$1" "$2"; }
refuser() { printf '{"jsonrpc":"2.0","id":%s,"error":{"code":%s,"message":"%s"}}\n' "$1" "$2" "$3"; }

methode_de() {  # ligne → méthode (première occurrence), vide sinon
  reste=${1#*\"method\"}
  [ "$reste" = "$1" ] && return 0
  reste=${reste#*\"}
  reste=${reste%%\"*}
  case $reste in *[!A-Za-z0-9/_.-]*) ;; *) printf '%s' "$reste" ;; esac
}

# Identifiant JSON-RPC brut : en fin d'objet (forme du SDK), sinon en tête après "jsonrpc", sinon le dernier.
ident_de() {
  case $1 in *\"id\"*) ;; *) return 0 ;; esac
  printf '%s\n' "$1" | sed -nE '
s/.*,[[:space:]]*"id"[[:space:]]*:[[:space:]]*("[^"\\]*"|-?[0-9]+)[[:space:]]*[}][[:space:]]*$/\1/p
t
s/^[[:space:]]*[{][[:space:]]*("jsonrpc"[[:space:]]*:[[:space:]]*"2\.0"[[:space:]]*,[[:space:]]*)?"id"[[:space:]]*:[[:space:]]*("[^"\\]*"|-?[0-9]+).*/\2/p
t
s/.*"id"[[:space:]]*:[[:space:]]*("[^"\\]*"|-?[0-9]+).*/\1/p'
}

protocole_de() {
  reste=${1#*\"protocolVersion\"}
  demande=
  if [ "$reste" != "$1" ]; then reste=${reste#*\"}; demande=${reste%%\"*}; fi
  for p in $PROTOCOLES; do [ "$p" = "$demande" ] && { printf '%s' "$p"; return 0; }; done
  printf '%s' "${PROTOCOLES%% *}"
}

# Python utilisable maintenant : imposé ou installé ; le système seulement quand l'installation ne viendra pas.
python_maintenant() {
  choisir && return 0
  installation_en_cours && return 1
  if [ -z "$RAISON_IMPOSSIBLE" ] && [ "$(champ "$ETAT_INSTALL" state)" != failed ]; then
    # Installation lancée mais ni finie ni en cours : laissée une minute pour prendre son verrou.
    [ $(( $(maintenant) - ${LANCEE:-$DEPART} )) -lt 60 ] && return 1
  fi
  [ -e "$SESSION/sans-secours" ] && return 1
  systeme && return 0
  : > "$SESSION/sans-secours"
  return 1
}

annonceur() {
  tours=0
  while ! python_maintenant; do
    kill -0 $$ 2>/dev/null || exit 0
    # Une seconde pendant l'installation ordinaire, puis plus lentement (Python installé par une autre session).
    if [ $tours -lt 180 ]; then tours=$((tours + 1)); sleep 1; else sleep 5; fi
  done
  while [ ! -e "$SESSION/initialise" ]; do
    kill -0 $$ 2>/dev/null || exit 0
    sleep 1
  done
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}'
}

relayer() {  # ligne en attente → exec du vrai serveur
  kill "$ANNONCEUR" 2>/dev/null
  trap - EXIT
  rm -rf "$SESSION"
  [ -n "$PROTOCOLE" ] && export TOKFIT_MCP_REPRISE="$PROTOCOLE"
  export TOKFIT_MCP_ATTENTE="$1"
  lancer_serveur
}

repondeur() {
  SESSION=$(mktemp -d 2>/dev/null) || { SESSION="${TMPDIR:-/tmp}/tokfit-$$"; mkdir -p "$SESSION"; }
  PROTOCOLE=
  annonceur &
  ANNONCEUR=$!
  trap 'kill "$ANNONCEUR" 2>/dev/null; rm -rf "$SESSION"' EXIT
  trap 'exit 0' INT TERM HUP
  while IFS= read -r ligne || [ -n "$ligne" ]; do
    [ -n "$ligne" ] || continue
    methode=$(methode_de "$ligne")
    # Sans méthode : la réponse à une demande du serveur (il n'en fait aucune), ignorée.
    [ -n "$methode" ] || continue
    id=$(ident_de "$ligne")
    case $methode in
      initialize)
        PROTOCOLE=$(protocole_de "$ligne")
        [ -n "$id" ] && repondre "$id" "{\"protocolVersion\":\"$PROTOCOLE\",\"capabilities\":{\"tools\":{\"listChanged\":true}},\"serverInfo\":{\"name\":\"$SERVEUR_NOM\",\"version\":\"$SERVEUR_VERSION\"}}"
        ;;
      notifications/initialized) : > "$SESSION/initialise" ;;
      ping) [ -n "$id" ] && repondre "$id" '{}' ;;
      *)
        [ -n "$id" ] || continue
        python_maintenant && relayer "$ligne"
        case $methode in
          tools/list) : > "$SESSION/initialise"; repondre "$id" '{"tools":[]}' ;;
          tools/call) refuser "$id" -32602 "unknown tool" ;;
          *) refuser "$id" -32601 "unknown method: $methode" ;;
        esac
        ;;
    esac
  done
  exit 0
}

serveur() {
  if choisir || systeme; then lancer_serveur; fi
  journal "aucun Python $PIN_MINIMUM+ utilisable sur la machine"
  RAISON_IMPOSSIBLE=$(impossible)
  if [ -z "$RAISON_IMPOSSIBLE" ]; then
    if echec_recent; then
      journal "dernière installation échouée il y a moins de $REESSAI_S s : pas de nouvel essai"
    else
      installation_en_cours || installer_en_fond
      ecrire_lancement none python_installing ""
      repondeur
    fi
  fi
  if [ -n "$RAISON_IMPOSSIBLE" ]; then
    journal "aucun Python utilisable et installation impossible ($RAISON_IMPOSSIBLE)"
    ecrire_lancement none python_missing "$RAISON_IMPOSSIBLE"
  else
    ecrire_lancement none install_failed "$(champ "$ETAT_INSTALL" detail)"
  fi
  repondeur
}

hook() {
  [ $# -ge 1 ] || { journal "hook : script attendu"; exit 2; }
  script=$1
  shift
  if choisir || systeme; then
    certificats
    exec "$PY" -I -X utf8 "$script" "$@"
  fi
  RAISON_IMPOSSIBLE=$(impossible)
  if [ -z "$RAISON_IMPOSSIBLE" ] && ! echec_recent && ! installation_en_cours; then installer_en_fond; fi
  exit 0
}

etat() {
  choisir >/dev/null 2>&1 || true
  raison=$(impossible)
  printf '{"target":"%s","managed":"%s","ready":%s,"installing":%s,"impossible":"%s","downloader":"%s","hash":"%s","install":%s,"launch":%s}\n' \
    "$CIBLE" "$(json_chaine "$DIR")" "$(gere_pret && echo true || echo false)" \
    "$(installation_en_cours && echo true || echo false)" "$raison" "$(outil_telechargement)" "$(outil_somme)" \
    "$(cat "$ETAT_INSTALL" 2>/dev/null || echo null)" "$(cat "$ETAT_LANCEMENT" 2>/dev/null || echo null)"
}

case ${1:-} in
  ''|/d) serveur ;;
  hook) shift; hook "$@" ;;
  installer) installer ;;
  etat) etat ;;
  *) journal "mode inconnu : $1"; exit 2 ;;
esac

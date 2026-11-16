# tokfit : lanceur Windows du serveur MCP `outils` (kernel/server.py) et des hooks écrits en Python.
#
# Même rôle et mêmes fichiers d'état que kernel/launch.sh, sans sh ni Git for Windows : Windows PowerShell 5.1
# (livré avec Windows 10 et 11) ou PowerShell 7. Jamais lancé comme fichier de script (la stratégie d'exécution
# le refuserait) : son texte est lu et exécuté par `iex`, depuis :
#   - plugin.json : `${ComSpec:-sh}` vaut cmd.exe sous Windows, qui lance
#     `powershell … -Command iex([IO.File]::ReadAllText($env:CLAUDE_PLUGIN_ROOT+'/kernel/launch.ps1'))` ;
#   - hooks.json : la commande du hook Stop se lit en sh comme en PowerShell (shell de Claude Code sans Git Bash),
#     et pose TOKFIT_LAUNCH="hook hooks/completion.py claude" avant le même `iex`.
# Arguments : TOKFIT_LAUNCH (« mode arguments… », chemins relatifs au dossier du plugin), sinon ceux du script.
# Modes : (aucun) serveur MCP ; `hook <script> [arguments…]` ; `installer` (appel interne) ; `etat` (JSON).
#
# Python, dans le même ordre que launch.sh : celui que tokfit a déjà installé dans son cache, sinon un Python déjà
# présent (python3, puis python, du PATH ; jamais l'alias du Microsoft Store) s'il atteint MINIMUM et passe le test
# d'import, sinon tokfit installe le sien (python.pins : CPython de python-build-standalone épinglé, SHA-256
# vérifié), même dossier que launch.sh : TOKFIT_CACHE_DIR, sinon XDG_CACHE_HOME\tokfit, sinon
# ~\.cache\tokfit (HOME, sinon USERPROFILE). Téléchargement par curl.exe (Windows 10 1803 et après), sinon
# Invoke-WebRequest ; extraction par tar.exe de Windows. Toujours lancé avec -I et -X utf8. Réglages : TOKFIT_PYTHON, TOKFIT_PYTHON_INSTALL=0,
# TOKFIT_PYTHON_MIRROR, TOKFIT_PYTHON_PINS, TOKFIT_PYTHON_TARGET (cible imposée : essais).
# Sans Python prêt, il répond lui-même au protocole MCP minimal pendant l'installation en arrière-plan, puis
# passe la session au vrai serveur (TOKFIT_MCP_REPRISE, TOKFIT_MCP_ATTENTE), qui hérite de stdin et
# stdout. Rien sur stdout hors du protocole ; le journal va sur stderr (et dans install.log pendant l'installation).
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Off

$TokfitArgs = @()
if ($env:TOKFIT_LAUNCH) { $TokfitArgs = @(-split $env:TOKFIT_LAUNCH) } elseif ($args) { $TokfitArgs = @($args) }
Remove-Item Env:TOKFIT_LAUNCH -ErrorAction SilentlyContinue
$TokfitMode = ''
if ($TokfitArgs.Count -gt 0) { $TokfitMode = [string]$TokfitArgs[0] }

if ($PSScriptRoot) { $ICI = $PSScriptRoot }
elseif ($env:CLAUDE_PLUGIN_ROOT) { $ICI = Join-Path $env:CLAUDE_PLUGIN_ROOT 'kernel' }
else { [Console]::Error.WriteLine('tokfit: dossier du lanceur introuvable (CLAUDE_PLUGIN_ROOT absent)'); exit 1 }
$RACINE = Split-Path -Parent $ICI
$LANCEUR = Join-Path $ICI 'launch.ps1'
# Versions du protocole MCP acceptées, la première par défaut ; nom et version du serveur (kernel/server.py).
$PROTOCOLES = @('2025-06-18', '2025-03-26', '2024-11-05')
$SERVEUR_NOM = 'outils'
$SERVEUR_VERSION = '1.0.0'
$REESSAI_S = 600
$VERROU_MAX_MIN = 30
$JOURNAL_FICHIER = $null

function Journal([string]$m) {
  [Console]::Error.WriteLine("tokfit: $m")
  if ($script:JOURNAL_FICHIER) {
    try { [IO.File]::AppendAllText($script:JOURNAL_FICHIER, "tokfit: $m`n") } catch { }
  }
}

function Maintenant { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

# --- Épinglage ---
$PINS = if ($env:TOKFIT_PYTHON_PINS) { $env:TOKFIT_PYTHON_PINS } else { Join-Path $ICI 'python.pins' }
$PIN = @{ VERSION = ''; RELEASE = ''; MINIMUM = '3.9'; FLAVOR = ''; BASE_URL = '' }
try {
  foreach ($ligne in [IO.File]::ReadAllLines($PINS)) {
    if ($ligne -match '^([A-Za-z0-9_]+)=([A-Za-z0-9._:/+%@-]*)\r?$') { $PIN[$Matches[1]] = $Matches[2] }
  }
} catch { Journal "épinglage illisible : $PINS" }
$MIN = $PIN['MINIMUM'].Split('.')
# Test d'un interpréteur : version minimale, modules du noyau et du connecteur, TLS (une ligne, sans guillemet
# double : PowerShell 5.1 les passe mal aux programmes). Même liste que TEST_PYTHON de launch.sh.
$TEST_PYTHON = "import sys; assert sys.version_info[:2] >= ($($MIN[0]), $($MIN[1])); " +
  'import ast, base64, collections, dataclasses, difflib, fnmatch, functools, hashlib, inspect, json, linecache, logging; ' +
  'import os, pathlib, re, select, shlex, shutil, signal, site, ssl, subprocess, tempfile, threading, time, traceback; ' +
  'import types, typing, unicodedata, urllib.error, urllib.parse, urllib.request, zlib; ' +
  "ssl.create_default_context(); print('tokfit-ok %d.%d.%d' % sys.version_info[:3])"

# --- Cible et cache ---
$WINDOWS = ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)
function Detecter-Cible {
  if ($env:TOKFIT_PYTHON_TARGET) { return $env:TOKFIT_PYTHON_TARGET }
  if (-not $WINDOWS) { return '' }
  $arch = ''
  try { $arch = [string][Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch { }
  if (-not $arch) { $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE } }
  switch -Regex ($arch) {
    '^(X64|AMD64)$' { return 'x86_64-pc-windows-msvc' }
    '^(Arm64|ARM64)$' { return 'aarch64-pc-windows-msvc' }
  }
  return ''
}
$CIBLE = Detecter-Cible
$CLE_CIBLE = $CIBLE.Replace('-', '_')
$SHA = ''; $TAILLE = ''
if ($CIBLE) { $SHA = [string]$PIN["SHA256_$CLE_CIBLE"]; $TAILLE = [string]$PIN["SIZE_$CLE_CIBLE"] }
$NOM = "cpython-$($PIN['VERSION'])+$($PIN['RELEASE'])-$CIBLE"
$ARCHIVE = "$NOM-$($PIN['FLAVOR']).tar.gz"
$BASE = if ($env:TOKFIT_PYTHON_MIRROR) { $env:TOKFIT_PYTHON_MIRROR } else { $PIN['BASE_URL'] }
$URL = "$BASE/$($PIN['RELEASE'])/cpython-$($PIN['VERSION'])%2B$($PIN['RELEASE'])-$CIBLE-$($PIN['FLAVOR']).tar.gz"
$EXE_RELATIF = if ($CIBLE -like '*windows*') { 'python.exe' } else { 'bin/python3' }

if ($env:TOKFIT_CACHE_DIR) { $CACHE = $env:TOKFIT_CACHE_DIR }
elseif ($env:XDG_CACHE_HOME) { $CACHE = Join-Path $env:XDG_CACHE_HOME 'tokfit' }
else {
  $maison = if ($env:HOME) { $env:HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { [IO.Path]::GetTempPath() }
  $CACHE = Join-Path (Join-Path $maison '.cache') 'tokfit'
}
$PYDIR = Join-Path $CACHE 'python'
$DIR = Join-Path $PYDIR $NOM
$EXE = Join-Path $DIR $EXE_RELATIF
$ETAT_INSTALL = Join-Path $PYDIR 'install.json'
$ETAT_LANCEMENT = Join-Path $PYDIR 'launch.json'
$LOG = Join-Path $PYDIR 'install.log'
$VERROU = Join-Path $PYDIR '.verrou'
$DEPART = Maintenant
$UTF8 = New-Object Text.UTF8Encoding($false)

function Ecrire-Json([string]$fichier, $objet) {
  try {
    [void][IO.Directory]::CreateDirectory($PYDIR)
    $tmp = "$fichier.$PID"
    [IO.File]::WriteAllText($tmp, ($objet | ConvertTo-Json -Compress) + "`n", $UTF8)
    Move-Item -LiteralPath $tmp -Destination $fichier -Force -ErrorAction Stop
  } catch { Remove-Item -LiteralPath "$fichier.$PID" -Force -ErrorAction SilentlyContinue }
}

function Ecrire-Install([string]$etat, [string]$raison, [string]$detail) {
  Ecrire-Json $ETAT_INSTALL ([ordered]@{ state = $etat; reason = $raison; detail = $detail; version = $PIN['VERSION'];
    target = $CIBLE; at = (Maintenant); pid = $PID })
}

$script:PY = ''; $script:PY_VERSION = ''; $script:SOURCE = ''
function Ecrire-Lancement([string]$source, [string]$raison, [string]$detail) {
  Ecrire-Json $ETAT_LANCEMENT ([ordered]@{ source = $source; reason = $raison; detail = $detail; path = $script:PY;
    version = $script:PY_VERSION; target = $CIBLE; at = (Maintenant) })
}

function Lire-Etat([string]$fichier) {
  try { return (Get-Content -LiteralPath $fichier -Raw -ErrorAction Stop | ConvertFrom-Json) } catch { return $null }
}

# --- Interpréteurs ---
function Python-Valide([string]$chemin) {
  if (-not $chemin) { return $false }
  try { $sortie = & $chemin -I -c $TEST_PYTHON 2>$null } catch { return $false }
  if ($LASTEXITCODE -ne 0) { return $false }
  $ligne = [string]($sortie | Select-Object -Last 1)
  if ($ligne -match '^tokfit-ok (\S+)') { $script:PY_VERSION = $Matches[1]; return $true }
  return $false
}

function Gere-Pret { (Test-Path -LiteralPath (Join-Path $DIR '.tokfit-ok')) -and (Test-Path -LiteralPath $EXE) }

$script:FORCE_REFUSE = $false
function Choisir {
  if ($env:TOKFIT_PYTHON -and -not $script:FORCE_REFUSE) {
    if (Python-Valide $env:TOKFIT_PYTHON) { $script:PY = $env:TOKFIT_PYTHON; $script:SOURCE = 'forced'; return $true }
    $script:FORCE_REFUSE = $true
    Journal "TOKFIT_PYTHON ignoré : version inférieure à $($PIN['MINIMUM']) ou modules absents ($env:TOKFIT_PYTHON)"
  }
  if (Gere-Pret) {
    $script:PY = $EXE; $script:SOURCE = 'managed'; $script:PY_VERSION = $PIN['VERSION']
    try { (Get-Item -LiteralPath (Join-Path $DIR '.tokfit-ok') -Force -ErrorAction Stop).LastWriteTime = Get-Date } catch { }
    return $true
  }
  return $false
}

# Python déjà présent sur la machine (premier qui passe le test) : utilisé avant toute installation ; jamais
# l'alias du Microsoft Store (WindowsApps), qui ouvrirait le Store au lieu de lancer Python.
function Systeme {
  foreach ($nom in @('python3', 'python')) {
    foreach ($commande in @(Get-Command $nom -CommandType Application -ErrorAction SilentlyContinue)) {
      $chemin = $commande.Source
      if (-not $chemin -or $chemin -match '[\\/]WindowsApps[\\/]') { continue }
      if (Python-Valide $chemin) { $script:PY = $chemin; $script:SOURCE = 'system'; return $true }
    }
  }
  return $false
}

# --- Outils de la machine ---
function Programme([string[]]$noms) {
  foreach ($nom in $noms) {
    $trouve = @(Get-Command $nom -CommandType Application -ErrorAction SilentlyContinue)
    if ($trouve.Count -gt 0) { return $trouve[0].Source }
  }
  return ''
}
# tar et curl de Windows (System32) d'abord : ceux de Git ne comprennent pas les chemins C:\.
function Systeme32([string]$nom) {
  if ($env:SystemRoot) {
    $chemin = Join-Path $env:SystemRoot "System32\$nom.exe"
    if (Test-Path -LiteralPath $chemin) { return $chemin }
  }
  return (Programme @("$nom.exe", $nom))
}
function Outil-Telechargement {
  if (Systeme32 'curl') { return 'curl' }
  if (Get-Command Invoke-WebRequest -ErrorAction SilentlyContinue) { return 'powershell' }
  return ''
}

function Telecharger-Une-Fois([string]$outil, [string]$adresse, [string]$fichier) {
  if ($outil -eq 'curl') {
    & (Systeme32 'curl') -fsSL -C - --connect-timeout 20 --speed-time 60 --speed-limit 1024 --max-time 1500 -o $fichier $adresse 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  }
  Remove-Item -LiteralPath $fichier -Force -ErrorAction SilentlyContinue
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $adresse -OutFile $fichier -UseBasicParsing -TimeoutSec 1500 -ErrorAction Stop
    return $true
  } catch { Journal "téléchargement : $($_.Exception.Message)"; return $false }
}

function Taille-De([string]$fichier) { try { return (Get-Item -LiteralPath $fichier -ErrorAction Stop).Length } catch { return -1 } }

function Telecharger([string]$adresse, [string]$fichier) {
  $outil = Outil-Telechargement
  if (-not $outil) { return $false }
  Journal "téléchargement de $ARCHIVE ($outil)"
  for ($essai = 1; $essai -le 3; $essai++) {
    if ($TAILLE -and (Taille-De $fichier) -gt [long]$TAILLE) { Remove-Item -LiteralPath $fichier -Force }
    if ($TAILLE -and (Taille-De $fichier) -eq [long]$TAILLE) { return $true }
    if (Telecharger-Une-Fois $outil $adresse $fichier) { return $true }
    Journal "essai $essai de téléchargement échoué ($outil)"
    if ($essai -ge 2) { Remove-Item -LiteralPath $fichier -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds ($essai * 2)
  }
  return $false
}

function Empreinte([string]$fichier) {
  try { return (Get-FileHash -LiteralPath $fichier -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() } catch { return '' }
}

# --- Installation ---
# Raison pour laquelle l'installation est impossible ici (vide si elle est possible) : mêmes codes que launch.sh.
function Impossible {
  if ($env:TOKFIT_PYTHON_INSTALL -eq '0') { return 'disabled' }
  if (-not $CIBLE -or -not $SHA -or -not $PIN['VERSION']) { return 'unsupported_platform' }
  if (-not (Outil-Telechargement)) { return 'no_downloader' }
  if (-not (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) { return 'no_hash_tool' }
  if (-not (Systeme32 'tar')) { return 'no_tar' }
  try {
    [void][IO.Directory]::CreateDirectory($PYDIR)
    $essai = Join-Path $PYDIR ".ecriture-$PID"
    [IO.File]::WriteAllText($essai, '')
    Remove-Item -LiteralPath $essai -Force
  } catch { return 'no_cache_dir' }
  return ''
}

function Vieux([string]$chemin, [int]$minutes) {
  try { return ((Get-Date) - (Get-Item -LiteralPath $chemin -Force -ErrorAction Stop).LastWriteTime).TotalMinutes -gt $minutes } catch { return $false }
}

function Vivant($numero) {
  if (-not "$numero" -or "$numero" -notmatch '^\d+$') { return $false }
  return [bool](Get-Process -Id ([int]$numero) -ErrorAction SilentlyContinue)
}

function Installation-En-Cours {
  if (-not (Test-Path -LiteralPath $VERROU)) { return $false }
  $numero = ''
  try { $numero = ([IO.File]::ReadAllText((Join-Path $VERROU 'pid'))).Trim() } catch { }
  if (-not $numero) { return -not (Vieux $VERROU 2) }
  if (-not (Vivant $numero)) { return $false }
  return -not (Vieux $VERROU $VERROU_MAX_MIN)
}

# Verrou = création exclusive du fichier pid (CreateNew, comme `set -C` de launch.sh), jamais la seule création
# du dossier : un seul processus peut le réussir.
function Poser-Pid {
  try {
    [void][IO.Directory]::CreateDirectory($VERROU)
    $flux = New-Object IO.FileStream((Join-Path $VERROU 'pid'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $octets = [Text.Encoding]::ASCII.GetBytes("$PID"); $flux.Write($octets, 0, $octets.Length) } finally { $flux.Dispose() }
    return $true
  } catch { return $false }
}

function Prendre-Verrou {
  if (Poser-Pid) { return $true }
  if (Installation-En-Cours) { return $false }
  Journal "verrou d'installation abandonné repris"
  Remove-Item -LiteralPath $VERROU -Recurse -Force -ErrorAction SilentlyContinue
  return (Poser-Pid)
}

function Rendre-Verrou {
  try { if (([IO.File]::ReadAllText((Join-Path $VERROU 'pid'))).Trim() -eq "$PID") { Remove-Item -LiteralPath $VERROU -Recurse -Force } } catch { }
}

function Echec-Recent {
  $etat = Lire-Etat $ETAT_INSTALL
  if (-not $etat -or $etat.state -ne 'failed' -or $etat.version -ne $PIN['VERSION']) { return $false }
  return ((Maintenant) - [long]$etat.at) -lt $REESSAI_S
}

function Nettoyer {
  foreach ($d in @(Get-ChildItem -LiteralPath $PYDIR -Directory -Force -Filter '.tmp-*' -ErrorAction SilentlyContinue)) {
    if (-not (Vivant ($d.Name.Substring(5)))) { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  }
  foreach ($d in @(Get-ChildItem -LiteralPath $PYDIR -Directory -Filter 'cpython-*' -ErrorAction SilentlyContinue)) {
    if ($d.FullName -ne $DIR -and (Vieux (Join-Path $d.FullName '.tokfit-ok') 43200)) {
      Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

# Installation au premier plan ; `journal` (appel d'Installer-En-Fond) : journal aussi dans install.log, comme le
# 2>>install.log de launch.sh (sous Windows, la fenêtre cachée n'a pas de stderr à rediriger).
function Installer([string]$journal) {
  if ($journal -eq 'journal') { $script:JOURNAL_FICHIER = $LOG }
  $raison = Impossible
  if ($raison) { Ecrire-Install failed python_missing $raison; return 1 }
  if (-not (Prendre-Verrou)) { Journal 'installation déjà en cours'; return 0 }
  $tmp = Join-Path $PYDIR ".tmp-$PID"
  $partiel = Join-Path $PYDIR "$ARCHIVE.part"
  $detail = ''
  try {
    if (Gere-Pret) { Ecrire-Install ready '' ''; return 0 }
    Ecrire-Install installing '' ''
    Nettoyer
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    try { [void][IO.Directory]::CreateDirectory($tmp) } catch { $detail = 'disk'; return 1 }
    if (-not (Telecharger $URL $partiel)) { $detail = 'download'; return 1 }
    $somme = Empreinte $partiel
    if (-not $somme) { $detail = 'no_hash_tool'; return 1 }
    if ($somme -ne $SHA) { Remove-Item -LiteralPath $partiel -Force -ErrorAction SilentlyContinue; $detail = 'checksum'; return 1 }
    & (Systeme32 'tar') -xzf $partiel -C $tmp 2>$null | Out-Null
    $nouveau = Join-Path (Join-Path $tmp 'python') $EXE_RELATIF
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nouveau)) { $detail = 'extract'; return 1 }
    if (-not (Python-Valide $nouveau)) { $detail = 'verify'; return 1 }
    try { [IO.File]::WriteAllText((Join-Path (Join-Path $tmp 'python') '.tokfit-ok'), "$script:PY_VERSION`n") } catch { $detail = 'disk'; return 1 }
    try { Move-Item -LiteralPath (Join-Path $tmp 'python') -Destination $DIR -ErrorAction Stop }
    catch { if (-not (Gere-Pret)) { $detail = 'disk'; return 1 } }
    Remove-Item -LiteralPath $partiel -Force -ErrorAction SilentlyContinue
    Ecrire-Install ready '' ''
    Journal "Python $script:PY_VERSION installé : $DIR"
    return 0
  } finally {
    if ($detail) {
      Journal "installation de Python échouée : $detail"
      Ecrire-Install failed install_failed $detail
    } elseif ((Lire-Etat $ETAT_INSTALL).state -eq 'installing') {
      Ecrire-Install failed install_failed interrupted
    }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Rendre-Verrou
  }
}

$script:LANCEE = $null
function Commande-PowerShell {
  $ps = (Get-Process -Id $PID).Path
  if (-not $ps) { $ps = Programme @('powershell.exe', 'pwsh.exe', 'pwsh') }
  return $ps
}
function Installer-En-Fond {
  try { [void][IO.Directory]::CreateDirectory($PYDIR) } catch { return }
  if ((Taille-De $LOG) -gt 1048576) { try { [IO.File]::WriteAllText($LOG, '') } catch { } }
  $commande = "iex([IO.File]::ReadAllText('" + $LANCEUR.Replace("'", "''") + "'))"
  $env:TOKFIT_LAUNCH = 'installer journal'
  try {
    $options = @{ FilePath = (Commande-PowerShell); ArgumentList = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', "`"$commande`"") }
    # Sous Windows, fenêtre cachée et aucun tube hérité ; ailleurs (essais), stdout et stderr loin du protocole.
    if ($WINDOWS) { $options['WindowStyle'] = 'Hidden' }
    else { $options['RedirectStandardOutput'] = "$LOG.out"; $options['RedirectStandardError'] = "$LOG.err" }
    Start-Process @options | Out-Null
  } catch { Journal "installation en arrière-plan impossible : $($_.Exception.Message)" }
  Remove-Item Env:TOKFIT_LAUNCH -ErrorAction SilentlyContinue
  $script:LANCEE = Maintenant
}

# --- Lancement ---
function Guillemets([string]$argument) {
  if ($argument -and $argument -notmatch '[\s"]') { return $argument }
  return '"' + ($argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

# Lance Python avec stdin, stdout et stderr hérités (le protocole MCP ou l'entrée du hook passent tels quels),
# attend sa fin et sort avec son code.
function Lancer([string[]]$arguments, [hashtable]$env_en_plus) {
  $infos = New-Object Diagnostics.ProcessStartInfo
  $infos.FileName = $script:PY
  $infos.Arguments = (@('-I', '-X', 'utf8') + $arguments | ForEach-Object { Guillemets $_ }) -join ' '
  $infos.UseShellExecute = $false
  if ($env_en_plus) { foreach ($cle in $env_en_plus.Keys) { $infos.EnvironmentVariables[$cle] = [string]$env_en_plus[$cle] } }
  try { $processus = [Diagnostics.Process]::Start($infos) }
  catch { Journal "lancement de $($script:PY) impossible : $($_.Exception.Message)"; exit 1 }
  $processus.WaitForExit()
  exit $processus.ExitCode
}

function Lancer-Serveur([hashtable]$env_en_plus) {
  Ecrire-Lancement $script:SOURCE '' ''
  Lancer @((Join-Path $ICI 'server.py')) $env_en_plus
}

# --- Répondeur MCP minimal ---
$ENTREE = $null; $SORTIE = $null
function Envoyer([string]$texte) {
  $octets = $UTF8.GetBytes($texte + "`n")
  $SORTIE.Write($octets, 0, $octets.Length)
  $SORTIE.Flush()
}

# Python utilisable maintenant : imposé ou installé ; le système seulement quand l'installation ne viendra pas.
$script:SANS_SECOURS = $false
function Python-Maintenant {
  if (Choisir) { return $true }
  if (Installation-En-Cours) { return $false }
  $etat = Lire-Etat $ETAT_INSTALL
  if (-not $script:RAISON_IMPOSSIBLE -and (-not $etat -or $etat.state -ne 'failed')) {
    # Installation lancée mais ni finie ni en cours : laissée une minute pour prendre son verrou.
    $depuis = if ($script:LANCEE) { $script:LANCEE } else { $DEPART }
    if (((Maintenant) - $depuis) -lt 60) { return $false }
  }
  if ($script:SANS_SECOURS) { return $false }
  if (Systeme) { return $true }
  $script:SANS_SECOURS = $true
  return $false
}

function Repondeur {
  $script:ENTREE = [Console]::OpenStandardInput()
  $script:SORTIE = [Console]::OpenStandardOutput()
  $protocole = ''
  $initialise = $false
  $annonce = $false
  $pret = $false
  $prochain = [DateTime]::MinValue
  $tours = 0
  $octet = New-Object byte[] 1
  $ligne = New-Object IO.MemoryStream
  while ($true) {
    # Un octet à la fois : rien de ce qui suit la demande en cours n'est lu, le serveur le lira.
    try { $lecture = $script:ENTREE.ReadAsync($octet, 0, 1) } catch { exit 0 }
    while ($true) {
      try { if ($lecture.Wait(500)) { break } } catch { exit 0 }
      if (-not $pret -and (Get-Date) -ge $prochain) {
        $pret = Python-Maintenant
        $tours++
        # Une seconde pendant l'installation ordinaire, puis plus lentement (Python installé par une autre session).
        $prochain = (Get-Date).AddSeconds($(if ($tours -lt 180) { 1 } else { 5 }))
      }
      if ($pret -and $initialise -and -not $annonce) {
        Envoyer '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}'
        $annonce = $true
      }
    }
    if ($lecture.Result -le 0) {
      if ($ligne.Length -eq 0) { exit 0 }
    } elseif ($octet[0] -ne 10) {
      $ligne.WriteByte($octet[0])
      continue
    }
    $texte = $UTF8.GetString($ligne.ToArray()).TrimEnd("`r")
    $fin = ($lecture.Result -le 0)
    $ligne.SetLength(0)
    if ($texte.Trim()) {
      $message = $null
      try { $message = $texte | ConvertFrom-Json -ErrorAction Stop } catch { }
      # Sans méthode : la réponse à une demande du serveur (il n'en fait aucune), ignorée.
      if ($message -and $message.PSObject.Properties['method']) {
        $methode = [string]$message.method
        $id = $null
        if ($message.PSObject.Properties['id'] -and $null -ne $message.id) { $id = $message.id | ConvertTo-Json -Compress }
        switch ($methode) {
          'initialize' {
            $demande = ''
            if ($message.params -and $message.params.PSObject.Properties['protocolVersion']) { $demande = [string]$message.params.protocolVersion }
            $protocole = if ($PROTOCOLES -contains $demande) { $demande } else { $PROTOCOLES[0] }
            if ($null -ne $id) {
              Envoyer ('{"jsonrpc":"2.0","id":' + $id + ',"result":{"protocolVersion":"' + $protocole +
                '","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"' + $SERVEUR_NOM + '","version":"' + $SERVEUR_VERSION + '"}}}')
            }
          }
          'notifications/initialized' { $initialise = $true }
          'ping' { if ($null -ne $id) { Envoyer ('{"jsonrpc":"2.0","id":' + $id + ',"result":{}}') } }
          default {
            if ($null -ne $id) {
              if ($pret -or (Python-Maintenant)) {
                $reprise = @{ TOKFIT_MCP_ATTENTE = $texte }
                if ($protocole) { $reprise['TOKFIT_MCP_REPRISE'] = $protocole }
                Lancer-Serveur $reprise
              }
              if ($methode -eq 'tools/list') { $initialise = $true; Envoyer ('{"jsonrpc":"2.0","id":' + $id + ',"result":{"tools":[]}}') }
              elseif ($methode -eq 'tools/call') { Envoyer ('{"jsonrpc":"2.0","id":' + $id + ',"error":{"code":-32602,"message":"unknown tool"}}') }
              else { Envoyer ('{"jsonrpc":"2.0","id":' + $id + ',"error":{"code":-32601,"message":"unknown method: ' + ($methode -replace '[^A-Za-z0-9/_.-]', '') + '"}}') }
            }
          }
        }
      }
    }
    if ($fin) { exit 0 }
  }
}

function Serveur {
  if ((Choisir) -or (Systeme)) { Lancer-Serveur @{} }
  Journal "aucun Python $($PIN['MINIMUM'])+ utilisable sur la machine"
  $script:RAISON_IMPOSSIBLE = Impossible
  if (-not $script:RAISON_IMPOSSIBLE) {
    if (Echec-Recent) {
      Journal "dernière installation échouée il y a moins de $REESSAI_S s : pas de nouvel essai"
    } else {
      if (-not (Installation-En-Cours)) { Installer-En-Fond }
      Ecrire-Lancement none python_installing ''
      Repondeur
    }
  }
  if ($script:RAISON_IMPOSSIBLE) {
    Journal "aucun Python utilisable et installation impossible ($($script:RAISON_IMPOSSIBLE))"
    Ecrire-Lancement none python_missing $script:RAISON_IMPOSSIBLE
  } else {
    $etat = Lire-Etat $ETAT_INSTALL
    Ecrire-Lancement none install_failed $(if ($etat) { [string]$etat.detail } else { '' })
  }
  Repondeur
}

function Hook([string[]]$reste) {
  if ($reste.Count -lt 1) { Journal 'hook : script attendu'; exit 2 }
  $fichier = $reste[0]
  if (-not [IO.Path]::IsPathRooted($fichier)) { $fichier = Join-Path $RACINE $fichier }
  if ((Choisir) -or (Systeme)) { Lancer (@($fichier) + @($reste | Select-Object -Skip 1)) @{} }
  $raison = Impossible
  if (-not $raison -and -not (Echec-Recent) -and -not (Installation-En-Cours)) { Installer-En-Fond }
  exit 0
}

function Etat {
  [void](Choisir)
  [ordered]@{ target = $CIBLE; managed = $DIR; ready = [bool](Gere-Pret); installing = [bool](Installation-En-Cours);
    impossible = (Impossible); downloader = (Outil-Telechargement); hash = 'Get-FileHash';
    install = (Lire-Etat $ETAT_INSTALL); launch = (Lire-Etat $ETAT_LANCEMENT) } | ConvertTo-Json -Compress -Depth 4
}

switch ($TokfitMode) {
  '' { Serveur }
  'hook' { Hook @($TokfitArgs | Select-Object -Skip 1) }
  'installer' { exit (Installer ([string]($TokfitArgs | Select-Object -Skip 1 -First 1))) }
  'etat' { Etat; exit 0 }
  default { Journal "mode inconnu : $TokfitMode"; exit 2 }
}

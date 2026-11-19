// Santé de l'outil `agir` (serveur MCP `outils`, kernel/server.py, lancé par kernel/launch.sh, ou kernel/launch.ps1
// sous Windows) : pourquoi il
// manque, dit à la personne dès qu'il manque (bandeau au-dessus de la saisie, band.ts), au service avec les
// compteurs de l'étape (`kernel_reason`, `kernel_detail` : des codes fixes, jamais un chemin), et en entier
// par `/<NAME>`.
//
// Le lanceur écrit son état dans le cache de tokfit (`<cache>/python/install.json` : installation de
// Python ; `launch.json` : interpréteur lancé, ou pourquoi aucun) ; le moteur dit quels outils sont
// proposés (`$.tool.list`). Rien n'est écrit ici, seulement lu. L'état est relu au démarrage de la session,
// puis à intervalles (plus serrés au début : l'installation dure de quelques secondes à une minute) tant que
// `agir` manque, et à chaque étape ; le bandeau disparaît dès que `agir` est là.
import type { EngineInterface } from 'claude-code'
import { inCodeMode, isAccountTool, isKernelTool } from './kernel'
import { keyRefused } from './service'
import { t } from './lang'

// Raisons de l'absence de `agir` : KERNEL_REASONS de service/usage.py (vérifié par tests/test_connector.py).
export const REASONS = ['python_installing', 'python_missing', 'install_failed', 'unsupported_platform',
  'server_starting', 'server_down', 'pack_unavailable', 'key_refused', 'code_mode'] as const
export type Reason = (typeof REASONS)[number]
// Détails : écrits par le lanceur, sauf `no_launch` (lanceur jamais parti) ; `windows` n'est plus produit (le noyau
// tourne sous Windows depuis 0.7.13), gardé pour les anciens connecteurs ; KERNEL_DETAILS du service.
export const DETAILS = ['disabled', 'unsupported_platform', 'no_downloader', 'no_hash_tool', 'no_tar', 'no_cache_dir',
  'download', 'checksum', 'extract', 'verify', 'disk', 'interrupted', 'windows', 'no_launch'] as const
export type Detail = (typeof DETAILS)[number]
export type Diagnosis = { reason: Reason; detail?: Detail }

// Démarrage du serveur MCP (MCP_TIMEOUT de Claude Code : 30 s) : avant ce délai, un outil absent n'est pas une panne.
export const START_GRACE_MS = 60_000
// Installation « en cours » plus vieille que le verrou du lanceur (VERROU_MAX_MIN) : interrompue.
export const INSTALL_STALE_S = 30 * 60
// Relecture tant que `agir` manque : serrée pendant les premières minutes, puis espacée.
export const CHECK_FAST_MS = 5_000
export const CHECK_SLOW_MS = 60_000
export const FAST_FOR_MS = 5 * 60_000
// Relecture à une étape : pas plus souvent que ceci.
export const CHECK_MIN_MS = 2_000

type Json = Record<string, unknown>
export type PythonFiles = { install?: Json; launch?: Json }

// État de la session : début (pour le délai de démarrage), dernier diagnostic (undefined : jamais fait ;
// null : `agir` proposé), relecture en cours, minuterie.
export type Health = {
  since: number | undefined
  at: number | undefined
  diagnosis: Diagnosis | null | undefined
  files: PythonFiles
  busy: boolean
  stop: (() => void) | undefined
}

export function health(): Health {
  return { since: undefined, at: undefined, diagnosis: undefined, files: {}, busy: false, stop: undefined }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function detailOf(value: unknown): Detail | undefined {
  return (DETAILS as readonly string[]).includes(text(value)) ? (text(value) as Detail) : undefined
}

function failure(reason: 'python_missing' | 'install_failed', detail: unknown): Diagnosis {
  const known = detailOf(detail)
  return known ? { reason, detail: known } : { reason }
}

// Cache du lanceur : TOKFIT_CACHE_DIR, sinon ${XDG_CACHE_HOME:-$HOME/.cache}/tokfit (même règle que
// kernel/launch.sh et kernel/launch.ps1 ; sous Windows, HOME, s'il existe, sinon USERPROFILE, comme le lanceur).
export async function cacheDir($: EngineInterface): Promise<string | null> {
  const own = await $.env.get('TOKFIT_CACHE_DIR')
  if (own) return own
  const xdg = await $.env.get('XDG_CACHE_HOME')
  if (xdg) return `${xdg}/tokfit`
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return home ? `${home}/.cache/tokfit` : null
}

async function readJson($: EngineInterface, path: string): Promise<Json | undefined> {
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(path))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : undefined
  } catch {
    // Fichier absent (lanceur jamais parti) ou illisible : rien de su.
    return undefined
  }
}

export async function pythonFiles($: EngineInterface): Promise<PythonFiles> {
  const dir = await cacheDir($)
  if (!dir) return {}
  const [install, launch] = await Promise.all([readJson($, `${dir}/python/install.json`), readJson($, `${dir}/python/launch.json`)])
  return { ...(install ? { install } : {}), ...(launch ? { launch } : {}) }
}

// Pourquoi `agir` manque ; null s'il est proposé, ou si rien ne permet d'en juger (connecteur non relié :
// le serveur ne propose alors aucun outil, sans panne). `refused` : le service a refusé la clé à sa dernière
// réponse ; le paquet du noyau, demandé avec la même clé, n'arrivera pas. `codeMode` : l'outil `REPL` de Code Mode
// est proposé (kernel.ts), le levier ne retire rien, `agir` proposé ou non.
export function diagnose(kernel: boolean, account: boolean, f: PythonFiles, linked: boolean, now: number, since: number,
                         refused = false, codeMode = false): Diagnosis | null {
  if (codeMode) return { reason: 'code_mode' }
  if (kernel) return null
  const source = text(f.launch?.source)
  if (refused && linked) return { reason: 'key_refused' }
  if (account) return { reason: 'pack_unavailable' }
  if (source === 'none') {
    const why = text(f.launch?.reason)
    if (why === 'python_missing' || why === 'install_failed') return failure(why, f.launch?.detail)
    const state = text(f.install?.state)
    if (state === 'failed') return failure(text(f.install?.reason) === 'python_missing' ? 'python_missing' : 'install_failed', f.install?.detail)
    const at = typeof f.install?.at === 'number' ? f.install.at : 0
    if (state === 'installing' && now / 1000 - at > INSTALL_STALE_S) return { reason: 'install_failed', detail: 'interrupted' }
    return { reason: 'python_installing' }
  }
  if (!linked) return null
  if (now - since < START_GRACE_MS) return { reason: 'server_starting' }
  return source === '' ? { reason: 'server_down', detail: 'no_launch' } : { reason: 'server_down' }
}

const DETAIL_TEXT: Record<Detail, readonly [string, string]> = {
  disabled: ['installation de Python désactivée par TOKFIT_PYTHON_INSTALL=0', 'Python installation disabled by TOKFIT_PYTHON_INSTALL=0'],
  unsupported_platform: ['système non pris en charge', 'unsupported system'],
  no_downloader: ['aucun outil de téléchargement : installez curl ou wget', 'no download tool: install curl or wget'],
  no_hash_tool: ['aucun outil de somme SHA-256', 'no SHA-256 checksum tool'],
  no_tar: ['tar absent', 'tar missing'],
  no_cache_dir: ['dossier de cache non inscriptible', 'cache folder not writable'],
  download: ['téléchargement impossible', 'download failed'],
  checksum: ['archive altérée : somme SHA-256 différente', 'corrupted archive: SHA-256 checksum mismatch'],
  extract: ['archive illisible', 'unreadable archive'],
  verify: ['Python installé mais inutilisable', 'Python installed but unusable'],
  disk: ['disque plein ou cache non inscriptible', 'disk full or cache not writable'],
  interrupted: ['installation interrompue', 'installation interrupted'],
  windows: ['Windows : connecteur antérieur à 0.7.13, à mettre à jour', 'Windows: connector older than 0.7.13, update it'],
  no_launch: ['lanceur jamais parti : sh (ou PowerShell sous Windows) introuvable ?', 'launcher never started: sh (or PowerShell on Windows) not found?'],
}

export function detailText(detail: Detail | undefined): string {
  return detail ? t(...DETAIL_TEXT[detail]) : ''
}

// Code Mode actif : ce que tokfit perd, pourquoi, et quoi faire (`/<NAME>`).
export const CODE_MODE_TEXT = 'Code Mode (mode expérimental de Claude Code) est actif dans cette session. Ses scripts appellent '
  + 'Bash, Read et Edit, les outils que tokfit remplace par son outil principal agir : pour ne pas casser Code Mode, tokfit '
  + 'les laisse en place et coupe son outil principal, son plus gros levier d\'économie. Le routage, la compaction et le '
  + 'cache gardé au chaud restent actifs. Nous déconseillons Code Mode avec tokfit : retirez '
  + 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE de votre shell et de ~/.claude/settings.json, puis relancez Claude Code.'
export const CODE_MODE_TEXT_EN = 'Code Mode (an experimental Claude Code mode) is active in this session. Its scripts call '
  + 'Bash, Read and Edit, the tools that tokfit replaces with its main tool agir: so as not to break Code Mode, tokfit '
  + 'leaves them in place and turns off its main tool, its biggest saving. Routing, compaction and the cache kept warm '
  + 'stay active. We advise against Code Mode with tokfit: remove CLAUDE_CODE_EXPERIMENTAL_CODE_MODE from your shell '
  + 'and from ~/.claude/settings.json, then restart Claude Code.'

export function codeModeText(): string {
  return t(CODE_MODE_TEXT, CODE_MODE_TEXT_EN)
}

// Ligne du bandeau, courte ; null quand rien n'est à dire (outil là, ou serveur qui démarre).
export function notice(d: Diagnosis | null | undefined): string | null {
  if (!d) return null
  const why = d.detail ? ` (${detailText(d.detail)})` : ''
  switch (d.reason) {
    case 'python_installing': return t('aucun Python 3.9+ sur la machine : téléchargement de Python en cours, l\'outil principal arrive',
      'no Python 3.9+ on this machine: downloading Python, the main tool is on its way')
    case 'python_missing': return t(`outil principal indisponible${why}`, `main tool unavailable${why}`)
    case 'install_failed': return t(`installation de Python échouée${why}, nouvel essai à la prochaine session`,
      `Python installation failed${why}, trying again next session`)
    case 'unsupported_platform': return t(`outil principal indisponible${why}`, `main tool unavailable${why}`)
    case 'server_starting': return null
    case 'server_down': return t(`outil principal arrêté${why} : /mcp pour relancer le serveur « outils »`,
      `main tool stopped${why}: /mcp to restart the "outils" server`)
    case 'pack_unavailable': return t('outil principal en attente du service (pas encore de réponse) : /tokfit pour le détail',
      'main tool waiting for the service (no answer yet): /tokfit for details')
    case 'code_mode': return t('bridé par Code Mode, outil principal coupé (Code Mode passe par Bash, Read et Edit, que cet outil remplace). '
      + 'Déconseillé : retirez CLAUDE_CODE_EXPERIMENTAL_CODE_MODE puis relancez Claude Code ; /tokfit pour le détail',
    'limited by Code Mode, main tool turned off (Code Mode goes through Bash, Read and Edit, which this tool replaces). '
      + 'Not advised: remove CLAUDE_CODE_EXPERIMENTAL_CODE_MODE then restart Claude Code; /tokfit for details')
    case 'key_refused': return t('clé tokfit refusée par le service (remplacée ou révoquée), clé d\'essai comprise : /tokfit pour rattacher cet appareil à votre compte',
      'tokfit key refused by the service (replaced or revoked), trial key included: /tokfit to link this device to your account')
  }
}

// Relit l'état et le rend ; redessine le bandeau quand ce qu'il montre change.
export async function check($: EngineInterface, h: Health, linked: boolean): Promise<Diagnosis | null> {
  const now = await $.clock.now()
  h.since ??= now
  const tools = await $.tool.list()
  const kernel = tools.some(tool => tool.mcp && isKernelTool(tool.name))
  const account = tools.some(tool => tool.mcp && isAccountTool(tool.name))
  h.files = await pythonFiles($)
  const before = notice(h.diagnosis)
  h.diagnosis = diagnose(kernel, account, h.files, linked, now, h.since, keyRefused(), inCodeMode(tools))
  h.at = now
  if (notice(h.diagnosis) !== before) $.ui.invalidate('ui.render')
  return h.diagnosis
}

// Relecture à une étape ou au rendu, bornée dans le temps ; jamais levée.
export async function refreshed($: EngineInterface, h: Health, linked: boolean): Promise<Diagnosis | null | undefined> {
  if (h.busy || h.diagnosis === null || (h.at !== undefined && (await $.clock.now()) - h.at < CHECK_MIN_MS)) return h.diagnosis
  h.busy = true
  try {
    return await check($, h, linked)
  } catch {
    // Liste des outils ou fichiers illisibles : le diagnostic précédent reste.
    return h.diagnosis
  } finally {
    h.busy = false
  }
}

// Au démarrage de la session : premier diagnostic, puis relectures tant que `agir` manque.
export function watch($: EngineInterface, h: Health, linked: () => Promise<boolean>): void {
  h.stop?.()
  let fast = true
  const tick = async (): Promise<void> => {
    const now = await $.clock.now()
    h.since ??= now
    const d = await refreshed($, h, await linked())
    if (d === null) {
      h.stop?.()
      h.stop = undefined
    } else if (fast && now - h.since >= FAST_FOR_MS) {
      fast = false
      start(CHECK_SLOW_MS)
    }
  }
  const start = (ms: number): void => {
    h.stop?.()
    const timer = $.clock.every(ms, () => { void tick().catch(() => undefined) })
    h.stop = () => timer.cancel()
  }
  start(CHECK_FAST_MS)
  void tick().catch(() => undefined)
}

const SOURCE_TEXT: Record<string, readonly [string, string]> = {
  managed: ['installé par tokfit', 'installed by tokfit'],
  system: ['déjà présent sur la machine', 'already on this machine'],
  forced: ['imposé par TOKFIT_PYTHON', 'set by TOKFIT_PYTHON'],
}

// Diagnostic complet pour `/<NAME>` : Python, installation, serveur, outils, service, version du connecteur.
export function healthReport(d: Diagnosis | null | undefined, f: PythonFiles, tools: { kernel: boolean; account: boolean },
  service: string, version: string | undefined): string {
  const launch = f.launch
  const source = text(launch?.source)
  const known = SOURCE_TEXT[source]
  const offered = t('proposé', 'offered')
  const python = source !== '' && source !== 'none'
    ? `${text(launch?.version)} ${known ? t(...known) : source} (${text(launch?.path)})`
    : source === 'none' ? t(`aucun (${notice(d) ?? text(launch?.reason)})`, `none (${notice(d) ?? text(launch?.reason)})`)
    : t('inconnu (lanceur jamais parti)', 'unknown (launcher never started)')
  const state = text(f.install?.state)
  const failedWhy = detailText(detailOf(f.install?.detail)) || text(f.install?.detail)
  const install = state === 'ready' ? t(`prête (${text(f.install?.version)}, ${text(f.install?.target)})`, `ready (${text(f.install?.version)}, ${text(f.install?.target)})`)
    : state === 'installing' ? t('en cours', 'in progress')
    : state === 'failed' ? t(`échouée (${failedWhy})`, `failed (${failedWhy})`)
    : source === 'system' ? t('inutile (Python de la machine utilisé)', 'not needed (the machine\'s Python is used)')
    : t('jamais lancée', 'never started')
  const stopped = d?.reason === 'server_down' && d.detail ? ` (${detailText(d.detail)})` : ''
  const server = tools.kernel || tools.account ? t('démarré', 'started')
    : d?.reason === 'server_starting' ? t('en démarrage', 'starting')
    : d?.reason === 'server_down' ? t(`arrêté${stopped}`, `stopped${stopped}`) : t('en attente de Python', 'waiting for Python')
  const missing = d ? ` (${notice(d) ?? t('serveur en démarrage', 'server starting')})` : ''
  const kernel = d?.reason === 'code_mode'
    ? t(`${tools.kernel ? 'proposé' : 'absent'}, levier coupé (Code Mode actif)`, `${tools.kernel ? 'offered' : 'missing'}, lever off (Code Mode active)`)
    : tools.kernel ? offered : t(`absent${missing}`, `missing${missing}`)
  return [t('Outil principal :', 'Main tool:'),
    t(`- connecteur : ${version ?? 'version inconnue'}`, `- connector: ${version ?? 'unknown version'}`),
    t(`- Python : ${python}`, `- Python: ${python}`),
    t(`- installation de Python : ${install}`, `- Python installation: ${install}`),
    t(`- serveur MCP « outils » : ${server}`, `- MCP server "outils": ${server}`),
    t(`- outil agir : ${kernel}`, `- agir tool: ${kernel}`),
    t(`- outil compte : ${tools.account ? 'proposé' : 'absent'}`, `- compte tool: ${tools.account ? 'offered' : 'missing'}`),
    t(`- service : ${service}`, `- service: ${service}`),
    ...(d?.reason === 'code_mode' ? ['', codeModeText()] : [])].join('\n')
}

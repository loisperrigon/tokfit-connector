// Santé de l'outil `agir` (serveur MCP `outils`, kernel/server.py, lancé par kernel/launch.sh) : pourquoi il
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
import { isAccountTool, isKernelTool } from './kernel'
import { keyRefused } from './service'

// Raisons de l'absence de `agir` : KERNEL_REASONS de service/usage.py (vérifié par tests/test_connector.py).
export const REASONS = ['python_installing', 'python_missing', 'install_failed', 'unsupported_platform',
  'server_starting', 'server_down', 'pack_unavailable', 'key_refused'] as const
export type Reason = (typeof REASONS)[number]
// Détails : écrits par le lanceur, sauf `windows` et `no_launch` (lanceur jamais parti) ; KERNEL_DETAILS du service.
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
// kernel/launch.sh ; sous Windows, HOME de Git Bash est USERPROFILE).
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
// réponse ; le paquet du noyau, demandé avec la même clé, n'arrivera pas.
export function diagnose(kernel: boolean, account: boolean, f: PythonFiles, linked: boolean, now: number, since: number,
                         refused = false): Diagnosis | null {
  if (kernel) return null
  const source = text(f.launch?.source)
  if (source !== '' && source !== 'none' && text(f.launch?.target).includes('windows')) return { reason: 'unsupported_platform', detail: 'windows' }
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

const DETAIL_TEXT: Record<Detail, string> = {
  disabled: 'installation de Python désactivée par TOKFIT_PYTHON_INSTALL=0',
  unsupported_platform: 'système non pris en charge',
  no_downloader: 'aucun outil de téléchargement : installez curl ou wget',
  no_hash_tool: 'aucun outil de somme SHA-256',
  no_tar: 'tar absent',
  no_cache_dir: 'dossier de cache non inscriptible',
  download: 'téléchargement impossible',
  checksum: 'archive altérée : somme SHA-256 différente',
  extract: 'archive illisible',
  verify: 'Python installé mais inutilisable',
  disk: 'disque plein ou cache non inscriptible',
  interrupted: 'installation interrompue',
  windows: 'Windows : le noyau demande un système POSIX',
  no_launch: 'lanceur jamais parti : `sh` introuvable ?',
}

export function detailText(detail: Detail | undefined): string {
  return detail ? DETAIL_TEXT[detail] : ''
}

// Ligne du bandeau, courte ; null quand rien n'est à dire (outil là, ou serveur qui démarre).
export function notice(d: Diagnosis | null | undefined): string | null {
  if (!d) return null
  const why = d.detail ? ` (${detailText(d.detail)})` : ''
  switch (d.reason) {
    case 'python_installing': return 'aucun Python 3.9+ sur la machine : téléchargement de Python en cours, l\'outil principal arrive'
    case 'python_missing': return `outil principal indisponible${why}`
    case 'install_failed': return `installation de Python échouée${why}, nouvel essai à la prochaine session`
    case 'unsupported_platform': return `outil principal indisponible${why}`
    case 'server_starting': return null
    case 'server_down': return `outil principal arrêté${why} : /mcp pour relancer le serveur « outils »`
    case 'pack_unavailable': return 'outil principal en attente du service (pas encore de réponse) : /tokfit pour le détail'
    case 'key_refused': return 'clé tokfit refusée par le service (remplacée ou révoquée) : dans /plugin, options de tokfit, collez votre clé actuelle ou videz le champ pour l\'essai'
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
  h.diagnosis = diagnose(kernel, account, h.files, linked, now, h.since, keyRefused())
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

const SOURCE_TEXT: Record<string, string> = { managed: 'installé par tokfit', system: 'déjà présent sur la machine', forced: 'imposé par TOKFIT_PYTHON' }

// Diagnostic complet pour `/<NAME>` : Python, installation, serveur, outils, service, version du connecteur.
export function healthReport(d: Diagnosis | null | undefined, f: PythonFiles, tools: { kernel: boolean; account: boolean },
  service: string, version: string | undefined): string {
  const launch = f.launch
  const source = text(launch?.source)
  const python = source !== '' && source !== 'none'
    ? `${text(launch?.version)} ${SOURCE_TEXT[source] ?? source} (${text(launch?.path)})`
    : source === 'none' ? `aucun (${notice(d) ?? text(launch?.reason)})` : 'inconnu (lanceur jamais parti)'
  const state = text(f.install?.state)
  const install = state === 'ready' ? `prête (${text(f.install?.version)}, ${text(f.install?.target)})`
    : state === 'installing' ? 'en cours'
    : state === 'failed' ? `échouée (${detailText(detailOf(f.install?.detail)) || text(f.install?.detail)})`
    : source === 'system' ? 'inutile (Python de la machine utilisé)'
    : 'jamais lancée'
  const server = tools.kernel || tools.account ? 'démarré'
    : d?.reason === 'server_starting' ? 'en démarrage'
    : d?.reason === 'server_down' ? `arrêté${d.detail ? ` (${detailText(d.detail)})` : ''}` : 'en attente de Python'
  const kernel = tools.kernel ? 'proposé' : `absent${d ? ` (${notice(d) ?? 'serveur en démarrage'})` : ''}`
  return ['Outil principal :',
    `- connecteur : ${version ?? 'version inconnue'}`,
    `- Python : ${python}`,
    `- installation de Python : ${install}`,
    `- serveur MCP « outils » : ${server}`,
    `- outil agir : ${kernel}`,
    `- outil compte : ${tools.account ? 'proposé' : 'absent'}`,
    `- service : ${service}`].join('\n')
}

// Liaison avec le service : clé du client et adresse, appels bornés dans le
// temps. Rien ici ne lève ni n'affiche : un échec rend null et l'appelant garde
// le réglage en cours.
//
// La clé vient de la configuration du plugin (`userConfig.api_key`, posée par
// `claude plugin install … --config api_key=ek_…`, gardée dans le trousseau),
// sinon d'un fichier hors dépôt (~/.config/tokfit/config.json, écrit par
// install.sh, ou TOKFIT_CONFIG). Champ par champ, la configuration du
// plugin passe avant le fichier, sauf si le service a refusé sa clé dans ce
// chargement (401, 403) : celle du fichier sert alors. Une valeur mal formée
// laisse le connecteur inerte. Sans clé configurée, ou quand chaque clé
// configurée a été refusée : clé anonyme (key.ts), et dans ce second cas la
// personne en est prévenue une fois (trial.ts). Réponse 402 : message de fin d'essai (trial.ts).
//
// Exception : une application qui lance Claude Code et relaie le service avec
// son propre jeton (Open Codex, host.ts) pose ses deux variables de relais
// (`relayed`) dans le terminal de la conversation ; ce relais passe
// alors avant tout le reste. Son adresse peut être en clair vers une adresse IP
// privée ou la machine elle-même (`relayAddress`), son jeton n'est pas une clé `ek_`.
import type { EngineInterface, HttpResponse, PluginOptions } from 'claude-code'
import { bounded } from './bounded'
import { anonymousKey } from './key'
import { refusedKeyNotice, trialNotice } from './trial'

// Nom du connecteur : ligne d'état et dossier de configuration. La copie
// publique porte le nom de production (connector/publish.py renomme cette
// constante, plugin.json, marketplace.json, install.sh et les variables).
export const NAME = 'tokfit'
// Attente maximale d'une décision. Le service coupe son propre appel avant
// (ROUTE_MOD_TIMEOUT_S de service/route_core.py, test côté service qui lit
// cette ligne) : ce délai ne joue que si le service ou le trajet sont en panne.
export const TIMEOUT_MS = 6000
// Attente maximale d'un envoi de compteurs (jamais sur le chemin d'un message).
export const USAGE_TIMEOUT_MS = 10_000

// Paliers de réflexion que le service connaît (EFFORTS de service/fields.py).
export const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

// Adresse officielle du service : posée dans la copie publique par
// connector/publish.py. Vide dans le dépôt de travail : l'adresse vient alors
// de `service_url` ou du fichier.
export const DEFAULT_URL = 'https://api.tokfit.fr'

export type Link = { url: string; key: string }

// Clé émise par le service : `ek_` + 32 octets en base64 url.
const KEY = /^ek_[A-Za-z0-9_-]{20,200}$/
// La clé ne part qu'en https, ou en clair vers la machine elle-même (essais).
const ADDRESS = /^(https:\/\/[^\s/?#@]+|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?)(\/[^\s?#]*)?$/

// Configuration du client, relue à chaque usage (une clé posée en cours de
// session sert dès le message suivant) ; null tant qu'elle est absente ou
// illisible : le connecteur reste alors inerte.
export async function link($: EngineInterface, options: PluginOptions): Promise<Link | null> {
  const relay = await relayed($)
  if (relay) return relay
  const file = await configFile($)
  const url = (text(options.service_url) || text(file.url) || DEFAULT_URL).replace(/\/+$/, '')
  if (!ADDRESS.test(url)) return null
  const refusedHere = refusedFor(options)
  const configured = [text(options.api_key), text(file.key)].filter(key => key)
  const usable = configured.find(key => !refusedHere.has(`${url} ${key}`))
  const key = usable || (await anonymousKey($, url, options)) || ''
  if (!KEY.test(key)) return null
  if (!usable && configured.length > 0) refusedKeyNotice($, NAME)
  const to = { url, key }
  owners.set(to, refusedHere)
  return to
}

// Clés refusées par le service (« adresse clé »), par chargement du connecteur (clé : ses options) ;
// chaque lien rendu par `link` pointe sur l'ensemble de son chargement.
const refusals = new WeakMap<object, Set<string>>()
const owners = new WeakMap<Link, Set<string>>()

function refusedFor(options: object): Set<string> {
  let found = refusals.get(options)
  if (!found) refusals.set(options, found = new Set())
  return found
}

// Relais d'une application hôte : adresse sans identifiants, en https, ou en http vers un hôte privé
// (`privateHost`) ; jeton sans espace.
const RELAY_URL = /^https?:\/\/([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(:\d{1,5})?(\/[^\s?#]*)?$/
const RELAY_TOKEN = /^[A-Za-z0-9_.~+/=-]{8,512}$/

// Vrai pour `localhost`, un nom Tailscale (`*.ts.net`, ou nom court de MagicDNS : un seul label qui
// commence par une lettre) et une adresse IP littérale de bouclage (127.0.0.0/8, ::1), privée (10/8,
// 172.16/12, 192.168/16, fc00::/7) ou partagée (100.64.0.0/10) ; aucun autre nom n'est privé.
export function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  if (host === 'localhost' || host === '::1') return true
  if (/^[a-z][a-z0-9-]*$/.test(host) || /^([a-z0-9-]+\.)+ts\.net$/.test(host)) return true
  if (host.includes(':')) return /^f[cd][0-9a-f]{0,2}:/.test(host)
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false
  const [a = 0, b = 0] = parts.map(Number)
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
}

// Adresse d'un relais : https sans identifiants, ou http vers un hôte privé.
export function relayAddress(value: string): boolean {
  if (!RELAY_URL.test(value)) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // Adresse illisible : pas de relais.
    return false
  }
  if (url.username !== '' || url.password !== '') return false
  return url.protocol === 'https:' || (url.protocol === 'http:' && privateHost(url.hostname))
}

// Variables posées par l'application hôte sous le nom de sa copie embarquée :
// la copie publique les garde (`publish: keep`, connector/publish.py).
async function relayed($: EngineInterface): Promise<Link | null> {
  try {
    const url = text(await $.env.get('ECONOMISEUR_RELAY_URL')) // publish: keep
    const token = text(await $.env.get('ECONOMISEUR_RELAY_TOKEN')) // publish: keep
    return relayAddress(url) && RELAY_TOKEN.test(token) ? { url: url.replace(/\/+$/, ''), key: token } : null
  } catch {
    // Environnement illisible : pas de relais, la configuration du client peut suffire.
    return null
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function configFile($: EngineInterface): Promise<Record<string, unknown>> {
  try {
    const home = await $.env.get('HOME')
    const path = (await $.env.get('TOKFIT_CONFIG')) || (home ? `${home}/.config/${NAME}/config.json` : '')
    if (!path) return {}
    const parsed: unknown = JSON.parse(await $.fs.read(path))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    // Fichier absent ou illisible : rien à signaler, la configuration du plugin peut suffire.
    return {}
  }
}

// Champ d'une réponse JSON du service ; undefined si elle est illisible.
export function field(text: string, name: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)[name] : undefined
  } catch {
    // Réponse illisible : l'appelant garde le réglage en cours.
    return undefined
  }
}

// Clé refusée par le service (401, 403 : remplacée ou révoquée) ; le bandeau le dit (python.ts). Levé
// seulement par une réponse acceptée : un 404 ne dit rien de la clé.
let refused = false

export function keyRefused(): boolean {
  return refused
}

function noteStatus(to: Link, status: number): void {
  if (status === 401 || status === 403) {
    refused = true
    owners.get(to)?.add(`${to.url} ${to.key}`)
  } else if (status >= 200 && status < 300) {
    refused = false
  }
}

// Au démarrage de la session : la clé est-elle acceptée ? Lecture seule (`/v1/bilan`), pour que le bandeau
// dise une clé refusée avant le premier message, au lieu d'attendre un paquet du noyau qui n'arrivera pas.
// Une clé configurée refusée laisse place à la suivante (celle du fichier, puis la clé anonyme), sondée à son tour.
export async function probeKey($: EngineInterface, options: PluginOptions, timeoutMs: number): Promise<void> {
  let tried = ''
  for (let to = await link($, options); to && to.key !== tried; to = refused ? await link($, options) : null) {
    tried = to.key
    if (!(await probed($, to, timeoutMs))) return
  }
}

async function probed($: EngineInterface, to: Link, timeoutMs: number): Promise<boolean> {
  const reply = await bounded($, `${to.url}/v1/bilan`, { method: 'GET', headers: { authorization: `Bearer ${to.key}` } }, timeoutMs)
  if (reply) noteStatus(to, reply.status)
  return reply !== null
}

// POST JSON vers le service ; null s'il est injoignable ou plus lent que `timeoutMs`.
// Une réponse 402 passe par le message de fin d'essai (trial.ts) avant d'être rendue.
export async function post($: EngineInterface, to: Link, path: string, body: unknown,
                           timeoutMs: number): Promise<HttpResponse | null> {
  const reply = await bounded($, `${to.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${to.key}`, 'x-show-notice': '1' },
    body: JSON.stringify(body),
  }, timeoutMs)
  if (reply) {
    noteStatus(to, reply.status)
    trialNotice($, reply.status, reply.text)
  }
  return reply
}

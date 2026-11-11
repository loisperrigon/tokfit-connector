// Liaison avec le service : clé du client et adresse, appels bornés dans le
// temps. Rien ici ne lève ni n'affiche : un échec rend null et l'appelant garde
// le réglage en cours.
//
// La clé vient de la configuration du plugin (`userConfig.api_key`, posée par
// `claude plugin install … --config api_key=ek_…`, gardée dans le trousseau),
// sinon d'un fichier hors dépôt (~/.config/tokfit/config.json, écrit par
// install.sh, ou TOKFIT_CONFIG). Champ par champ, la configuration du
// plugin passe avant le fichier.
//
// Exception : une application qui lance Claude Code et relaie le service avec
// son propre jeton (Open Codex, host.ts) pose TOKFIT_RELAY_URL et
// TOKFIT_RELAY_TOKEN dans le terminal de la conversation ; ce relais passe
// alors avant tout le reste. Son adresse peut être en clair sur un réseau privé
// (le trajet appartient à l'application), son jeton n'est pas une clé `ek_`.
import type { EngineInterface, HttpResponse, PluginOptions } from 'claude-code'

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
export const DEFAULT_URL = 'https://tokfit.dodoia.re'

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
  const key = text(options.api_key) || text(file.key)
  const url = text(options.service_url) || text(file.url) || DEFAULT_URL
  if (!KEY.test(key) || !ADDRESS.test(url)) return null
  return { url: url.replace(/\/+$/, ''), key }
}

// Relais d'une application hôte : adresse http(s) sans identifiants, jeton sans espace.
const RELAY_URL = /^https?:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?(\/[^\s?#]*)?$/
const RELAY_TOKEN = /^[A-Za-z0-9_.~+/=-]{8,512}$/

async function relayed($: EngineInterface): Promise<Link | null> {
  try {
    const url = text(await $.env.get('TOKFIT_RELAY_URL'))
    const token = text(await $.env.get('TOKFIT_RELAY_TOKEN'))
    return RELAY_URL.test(url) && RELAY_TOKEN.test(token) ? { url: url.replace(/\/+$/, ''), key: token } : null
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

// POST JSON vers le service ; null s'il est injoignable ou plus lent que `timeoutMs`.
export async function post($: EngineInterface, to: Link, path: string, body: unknown,
                           timeoutMs: number): Promise<HttpResponse | null> {
  const stop = new AbortController()
  const request = $.http.fetch(`${to.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${to.key}` },
    body: JSON.stringify(body),
  }).catch(() => null)
  const late = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(() => null, () => null)
  try {
    return await Promise.race([request, late])
  } finally {
    stop.abort()
  }
}

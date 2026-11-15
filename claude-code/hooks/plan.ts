// Plan de session : ce que les leviers appliquent (textes, listes, paramètres), reçu du
// service (`POST /v1/content`, partie `claude`) et gardé en mémoire seulement. Le plugin
// n'en a aucune copie : sans réponse valable, les leviers qui en dépendent restent
// inactifs. Un levier mal formé dans la réponse reste inactif seul.
import type { EngineInterface, PromptComposeSection } from 'claude-code'
import { NAME, field, post } from './service'
import type { Link } from './service'

// Attente maximale du plan : il peut précéder la première requête au modèle.
export const PLAN_TIMEOUT_MS = 3_000
// Après un échec, nouvelle demande au plus tôt après ce délai.
export const PLAN_RETRY_MS = 60_000

export type OutputPlan = {
  long: number; head: number; tail: number; kept: number; repeat: number
  noisy: readonly string[]; modules: readonly string[]; readers: readonly string[]; important: readonly string[]
}

// Liste jointe par le moteur dont chaque entrée est coupée à `entry` caractères.
export type Listing = { type: string; entry: number }

export type KernelPlan = {
  section: string; replaces: string; behind: ReadonlySet<string>; denied: ReadonlySet<string>; refusal: string
  attachment: { type: string; contains: string }; finished: string; listings: readonly Listing[]
}

// Sections du prompt système qui changent d'une session à l'autre, déplacées dans le contexte
// du premier message : le prompt système reste le même, donc relu en cache.
export type PrefixPlan = { context: ReadonlySet<string> }

export type SessionPlan = {
  thinking?: string; persistence?: string; output?: OutputPlan; fanout?: number; kernel?: KernelPlan
  compaction?: string; warm?: string; prefix?: PrefixPlan
  // Client admin seulement : consigne de retour sur les outils, en fin de prompt système (aucun levier témoin).
  feedback?: string
}

// `missing` : code de la dernière réponse sans plan valable (statut HTTP, 0 sans réponse) ;
// undefined tant qu'aucune demande n'a échoué depuis la dernière réussite.
export type Plans = {
  link: string | undefined; asked: number; failed: boolean; plan: Promise<SessionPlan | null> | undefined
  missing: number | undefined
}

export function plans(): Plans {
  return { link: undefined, asked: 0, failed: false, plan: undefined, missing: undefined }
}

type Raw = Record<string, unknown>

function object(value: unknown): Raw | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Raw : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function words(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(word => typeof word === 'string') ? value as string[] : undefined
}

function sectionOf(value: unknown): string | undefined {
  return text(object(value)?.section)
}

function outputOf(value: unknown): OutputPlan | undefined {
  const raw = object(value)
  if (!raw) return undefined
  const [long, head, tail, kept, repeat] = [raw.long, raw.head, raw.tail, raw.kept, raw.repeat].map(count)
  const [noisy, modules, readers, important] = [raw.noisy, raw.modules, raw.readers, raw.important].map(words)
  if (long === undefined || head === undefined || tail === undefined || kept === undefined || repeat === undefined
      || !noisy || !modules || !readers || !important) return undefined
  return { long, head, tail, kept, repeat, noisy, modules, readers, important }
}

function listingOf(value: unknown): Listing | undefined {
  const raw = object(value)
  const type = text(raw?.type)
  const entry = count(raw?.entry)
  return type !== undefined && entry !== undefined && entry > 1 ? { type, entry } : undefined
}

// Listes à raccourcir ; absentes ou illisibles : aucune, sans toucher au reste du levier.
function listingsOf(value: unknown): Listing[] {
  if (!Array.isArray(value)) return []
  const found = value.map(listingOf)
  return found.every((listing): listing is Listing => listing !== undefined) ? found : []
}

function kernelOf(value: unknown): KernelPlan | undefined {
  const raw = object(value)
  const attachment = object(raw?.attachment)
  const [section, replaces, refusal, finished] = [raw?.section, raw?.replaces, raw?.refusal, raw?.finished].map(text)
  const [behind, denied] = [raw?.behind, raw?.denied].map(words)
  const type = text(attachment?.type)
  const contains = text(attachment?.contains)
  if (section === undefined || replaces === undefined || refusal === undefined || finished === undefined || !behind || !denied
      || type === undefined || contains === undefined) return undefined
  return { section, replaces, refusal, finished, behind: new Set(behind), denied: new Set(denied), attachment: { type, contains },
    listings: listingsOf(raw?.listings) }
}

function prefixOf(value: unknown): PrefixPlan | undefined {
  const context = words(object(value)?.context)
  return context ? { context: new Set(context) } : undefined
}

// Plan lu dans une réponse du service ; null si elle n'en porte pas.
export function planOf(reply: string): SessionPlan | null {
  const raw = object(field(reply, 'claude'))
  if (!raw) return null
  const thinking = sectionOf(raw.thinking)
  const persistence = sectionOf(raw.persistence)
  const output = outputOf(raw.output)
  const fanout = count(object(raw.fanout)?.wait_ms)
  const kernel = kernelOf(raw.kernel)
  const compaction = text(object(raw.compaction)?.instructions)
  const warm = text(object(raw.warm)?.prompt)
  const prefix = prefixOf(raw.prefix)
  const feedback = sectionOf(raw.feedback)
  return {
    ...(thinking !== undefined ? { thinking } : {}), ...(persistence !== undefined ? { persistence } : {}),
    ...(output ? { output } : {}), ...(fanout !== undefined ? { fanout } : {}), ...(kernel ? { kernel } : {}),
    ...(compaction !== undefined ? { compaction } : {}), ...(warm !== undefined ? { warm } : {}),
    ...(prefix ? { prefix } : {}), ...(feedback !== undefined ? { feedback } : {}),
  }
}

type Asked = { plan: SessionPlan | null; code: number }

async function asked($: EngineInterface, to: Link): Promise<Asked> {
  const reply = await post($, to, '/v1/content', { parts: ['claude'] }, PLAN_TIMEOUT_MS)
  return { plan: reply?.status === 200 ? planOf(reply.text) : null, code: reply?.status ?? 0 }
}

// Plan de la session pour ce lien : une demande, gardée ; un échec est redemandé après PLAN_RETRY_MS.
export async function sessionPlan($: EngineInterface, h: Plans, to: Link): Promise<SessionPlan | null> {
  const id = `${to.url} ${to.key}`
  const now = await $.clock.now()
  if (h.plan === undefined || h.link !== id || (h.failed && now - h.asked >= PLAN_RETRY_MS)) {
    h.link = id
    h.asked = now
    h.failed = false
    // Panne inattendue de la demande : comptée comme une absence de plan, redemandée plus tard.
    const plan = asked($, to).catch((): Asked => ({ plan: null, code: 0 })).then(({ plan: found, code }) => {
      if (h.plan === plan) {
        h.failed = found === null
        h.missing = found === null ? code : undefined
      }
      return found
    })
    h.plan = plan
  }
  return h.plan
}

// Section de prompt d'un levier, en fin de prompt système.
export function section(lever: string, text: string): PromptComposeSection {
  return { id: `${NAME}:${lever}`, text, scope: 'session' }
}

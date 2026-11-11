// Cache du fil principal gardé au chaud pendant une pause (« fork-ping »).
//
// `$.model.fork` renvoie la dernière requête du fil principal (modèle,
// réflexion, consigne système, outils, messages) suivie d'une consigne d'une
// ligne, sans outil : elle relit tout le préfixe en cache et remet sa durée à
// zéro, sans rien ajouter à la conversation ni lancer de sous-agent (donc sans
// relecture du mode auto, qui relit chaque sous-agent qui rend la main). Le
// connecteur ne décide rien : à la fin d'un tour, il demande au service
// (/v1/warm) quand relancer, attend, relance, et redemande. Tout nouveau pas du
// fil principal, toute compaction du fil (le fork relirait l'ancien préfixe),
// toute fin de session ou toute réponse nulle arrête la chaîne.
// Les compteurs de chaque relance partent avec `ping`.
import type { EngineInterface, ModelEffort, ModelUsage, PluginOptions } from 'claude-code'
import { EFFORTS, USAGE_TIMEOUT_MS, field, link, post } from './service'
import { add, stepOf } from './usage'
import type { Queue } from './usage'

// Consigne de la relance : une réponse de quelques tokens.
export const PING_PROMPT = 'Réponds seulement « ok », sans aucun autre texte.'
// Au-delà, une réponse du service est tenue pour illisible.
const MAX_AFTER_S = 86_400

// Compaction à l'inactivité de Claude Code (2.1.299) : une conversation d'au
// moins IDLE_COMPACT_TOKENS (CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS) laissée ~54 min
// est résumée par le moteur avant que son cache d'une heure n'expire ;
// `"idleCompaction": false` la coupe. Fait transmis au service, qui décide.
const IDLE_COMPACT_SINCE: readonly number[] = [2, 1, 299]
const IDLE_COMPACT_TOKENS = 200_000

// Réglage de la dernière étape du fil principal : celui que la relance reprend.
export type MainSetting = { model: string; effort: unknown }

export type Warm = {
  // Change à chaque pas du fil principal : une chaîne plus ancienne s'arrête.
  generation: number
  // Attente en cours, interrompue par un nouveau pas.
  stop: AbortController | null
  // Relances faites depuis la fin du dernier tour, et quand ce tour a fini.
  pings: number
  restedAt: number
  // Fin de la dernière relance : l'âge du cache du fil repart de là.
  pingedAt: number | undefined
  main: MainSetting | undefined
}

export function warm(): Warm {
  return { generation: 0, stop: null, pings: 0, restedAt: 0, pingedAt: undefined, main: undefined }
}

// Le fil principal repart (ou la session finit) : plus de relance prévue.
export function cancel(w: Warm): void {
  w.generation++
  w.stop?.abort()
  w.stop = null
}

// Retour de l'utilisateur après des relances : leur nombre et la durée de la
// pause (faits du levier `warm` du service), comptés une seule fois.
export async function back($: EngineInterface, w: Warm): Promise<{ after_pings: number; pause_s: number } | undefined> {
  if (w.pings === 0) return undefined
  const pings = w.pings
  w.pings = 0
  return { after_pings: pings, pause_s: Math.max(0, Math.round(((await $.clock.now()) - w.restedAt) / 1000)) }
}

// Attente interrompue par un nouveau pas du fil principal ; vrai si elle est allée au bout.
export async function waited($: EngineInterface, w: Warm, ms: number): Promise<boolean> {
  const stop = new AbortController()
  w.stop = stop
  try {
    await $.clock.sleep(ms, { signal: stop.signal })
    return true
  } catch {
    // Interrompue : l'utilisateur a repris la main.
    return false
  } finally {
    if (w.stop === stop) w.stop = null
  }
}

// Fin d'un tour du fil principal : chaîne de relances tant que le service en veut. Ne lève jamais.
export async function rest($: EngineInterface, w: Warm, options: PluginOptions, q: Queue): Promise<void> {
  cancel(w)
  const generation = w.generation
  w.pings = 0
  try {
    w.restedAt = await $.clock.now()
    while (w.generation === generation) {
      const after = await nextPing($, w, options)
      if (after === null || !(await waited($, w, after * 1000)) || w.generation !== generation) return
      const reply = await $.model.fork({ prompt: PING_PROMPT, ...(await sameEffort($, w)) })
      // Rien à relancer (aucun tour fini, `/clear`) : pas de requête, pas de compteurs.
      if (!('usage' in reply)) return
      await counted($, w, q, reply.usage, 'effort' in reply ? reply.effort : undefined)
      if (!reply.isAnswered) return
      w.pings++
    }
  } catch {
    // Horloge ou relance en échec : plus de relance, rien d'affiché.
  }
}

// Compteurs d'une relance, à part des étapes du modèle (identifiant stable : pause, rang).
async function counted($: EngineInterface, w: Warm, q: Queue, usage: ModelUsage, sent: unknown): Promise<void> {
  w.pingedAt = await $.clock.now()
  const main = w.main
  if (!main) return
  const step = await stepOf(await $.session.id(), 'ping', `ping-${w.restedAt}`, w.pings, sent ?? main.effort,
    { ...usage, model: main.model }, [], { subagent: false, idleS: undefined, ping: true })
  add(q, step)
}

function atLeast(base: string | undefined, wanted: readonly number[]): boolean {
  const parts = (base ?? '').split(/[.-]/).slice(0, wanted.length).map(Number)
  if (parts.length < wanted.length || parts.some(part => !Number.isInteger(part))) return false
  for (const [at, need] of wanted.entries()) {
    const part = parts[at] ?? 0
    if (part !== need) return part > need
  }
  return true
}

// Un fork part au niveau de la session (vu en vrai : fil routé en high,
// relance en low). Réflexion par message (API d'Anthropic, 5.5) : sans effet
// sur le cache. Réflexion pour toute la requête (Bedrock, Vertex, passerelles,
// effort par message refusé) : un autre niveau que celui de la dernière étape
// du fil réécrit toute la conversation au lieu de la relire (types 2.1.318,
// ModelForkRequest.effort). L'option existe depuis 2.1.318.
const FORK_EFFORT_SINCE: readonly number[] = [2, 1, 318]

async function sameEffort($: EngineInterface, w: Warm): Promise<{ effort?: ModelEffort }> {
  const effort = w.main?.effort
  if (typeof effort !== 'string' || !EFFORTS.includes(effort)) return {}
  try {
    return atLeast((await $.session.version()).base, FORK_EFFORT_SINCE) ? { effort: effort as ModelEffort } : {}
  } catch {
    // Version illisible : la relance part comme avant, au niveau de la session.
    return {}
  }
}

// Seuil de la compaction à l'inactivité du moteur, ou undefined s'il n'en fait
// pas ou si le moteur ne sait pas le dire.
async function idleCompactTokens($: EngineInterface): Promise<number | undefined> {
  try {
    if (!atLeast((await $.session.version()).base, IDLE_COMPACT_SINCE)) return undefined
    if ((await $.settings.read({ key: 'idleCompaction' })) === false) return undefined
    const set = Number(await $.env.get('CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS'))
    return Number.isInteger(set) && set > 0 ? set : IDLE_COMPACT_TOKENS
  } catch {
    // Moteur sans version ni réglages lisibles : fait omis, le service décide comme avant.
    return undefined
  }
}

// Secondes avant la prochaine relance selon le service, ou null.
async function nextPing($: EngineInterface, w: Warm, options: PluginOptions): Promise<number | null> {
  const to = await link($, options)
  if (!to || !w.main) return null
  const usage = await $.session.usage()
  const tokens = usage.context.tokens ?? 0
  const idleS = Math.max(0, Math.round(((await $.clock.now()) - w.restedAt) / 1000))
  const idleCompact = await idleCompactTokens($)
  const reply = await post($, to, '/v1/warm', {
    model: w.main.model, context_tokens: tokens, idle_s: idleS, pings: w.pings,
    ...(idleCompact === undefined ? {} : { idle_compact_tokens: idleCompact }),
  }, USAGE_TIMEOUT_MS)
  if (reply?.status !== 200) return null
  const after = field(reply.text, 'after_s')
  return typeof after === 'number' && Number.isInteger(after) && after >= 0 && after <= MAX_AFTER_S ? after : null
}

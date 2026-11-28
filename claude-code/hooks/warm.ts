// Relance du fil principal pendant une pause (`$.model.fork` : la dernière requête du fil
// suivie de la consigne du plan de session, sans outil). À la fin d'un tour, le connecteur
// demande au service (/v1/warm) quand relancer, attend, relance, et redemande. Tout nouveau
// pas du fil principal, toute compaction du fil, toute fin de session ou toute réponse nulle
// arrête la chaîne. Les compteurs de chaque relance partent avec `ping`.
//
// Dans Open Codex, qui met en veille (arrête) le moteur d'une conversation calme depuis
// 30 min, chaque attente armée écrit son échéance (secondes depuis l'epoch) dans le fichier
// que l'application donne par OPEN_CODEX_KEEP_AWAKE ; la veille attend cette échéance
// (bornée côté application). Le fichier est vidé quand plus rien n'est prévu : attente
// interrompue (nouveau pas, compaction, fin), chaîne arrêtée. Le connecteur ne décide rien :
// il rapporte l'échéance rendue par le service. Hors de l'application, rien n'est écrit.
import type { EngineInterface, ModelEffort, ModelUsage, PluginOptions } from 'claude-code'
import { EFFORTS, USAGE_TIMEOUT_MS, field, link, post } from './service'
import { add, stepOf } from './usage'
import type { Queue } from './usage'
import type { Profile } from './host'

// Au-delà, une réponse du service est tenue pour illisible.
const MAX_AFTER_S = 86_400

// Compaction à l'inactivité du moteur (depuis 2.1.299) : seuil par défaut, réglable par
// CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS, coupée par `"idleCompaction": false`. Fait transmis au service.
const IDLE_COMPACT_SINCE: readonly number[] = [2, 1, 299]
const IDLE_COMPACT_TOKENS = 200_000

// Réglage de la dernière étape du fil principal : celui que la relance reprend.
export type MainSetting = { model: string; effort: unknown; pinned?: boolean }

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
  // Fichier « garde-moi éveillé » de l'application hôte, lu une fois ; undefined hors d'elle.
  awake?: Promise<string | undefined>
}

// Nom du fichier dans le dossier de session de l'application (son `keep_awake.rs`).
const AWAKE_FILE = /[\\/]keep-awake$/

function awakePath($: EngineInterface, w: Warm): Promise<string | undefined> {
  return (w.awake ??= $.env.get('OPEN_CODEX_KEEP_AWAKE')
    .then(path => (path && AWAKE_FILE.test(path) ? path : undefined))
    .catch(() => undefined))
}

// Échéance de la prochaine action prévue pendant la pause (ms depuis l'epoch), ou null :
// plus rien de prévu. Pour l'application hôte seulement ; ne lève jamais.
export async function awake($: EngineInterface, w: Warm, untilMs: number | null): Promise<void> {
  try {
    const path = await awakePath($, w)
    if (path) await $.fs.write(path, untilMs === null ? '' : String(Math.ceil(untilMs / 1000)))
  } catch {
    // Fichier inaccessible : la veille suit son délai habituel.
  }
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
    await awake($, w, (await $.clock.now()) + ms)
    await $.clock.sleep(ms, { signal: stop.signal })
    return true
  } catch {
    // Interrompue : l'utilisateur a repris la main. Plus rien de prévu, sauf si une
    // attente plus récente est déjà armée.
    if (w.stop === stop || w.stop === null) await awake($, w, null)
    return false
  } finally {
    if (w.stop === stop) w.stop = null
  }
}

// Fin d'un tour du fil principal : chaîne de relances tant que le service en veut. Ne lève jamais.
// `profile` : profil de session posé par l'hôte (host.ts), joint à chaque demande.
export async function rest($: EngineInterface, w: Warm, options: PluginOptions, q: Queue, prompt: string,
  profile?: Profile): Promise<void> {
  cancel(w)
  const generation = w.generation
  w.pings = 0
  try {
    w.restedAt = await $.clock.now()
    while (w.generation === generation) {
      const after = await nextPing($, w, options, profile)
      if (after === null || !(await waited($, w, after * 1000)) || w.generation !== generation) return
      const reply = await $.model.fork({ prompt, ...(await sameEffort($, w)) })
      // Rien à relancer (aucun tour fini, `/clear`) : pas de requête, pas de compteurs.
      if (!('usage' in reply)) return
      await counted($, w, q, reply.usage, 'effort' in reply ? reply.effort : undefined)
      if (!reply.isAnswered) return
      w.pings++
    }
  } catch {
    // Horloge ou relance en échec : plus de relance, rien d'affiché.
  } finally {
    // Chaîne arrêtée (réponse nulle, relance sans suite, échec) : plus rien de prévu.
    if (w.generation === generation) await awake($, w, null)
  }
}

// Compteurs d'une relance, à part des étapes du modèle (identifiant stable : pause, rang).
async function counted($: EngineInterface, w: Warm, q: Queue, usage: ModelUsage, sent: unknown): Promise<void> {
  w.pingedAt = await $.clock.now()
  const main = w.main
  if (!main) return
  const step = await stepOf(await $.session.id(), 'ping', `ping-${w.restedAt}`, w.pings, sent ?? main.effort,
    { ...usage, model: main.model }, [], { subagent: false, idleS: undefined, ping: true }, main.pinned ? { pinned: true } : {})
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

// La relance reprend la réflexion de la dernière étape du fil (`ModelForkRequest.effort`,
// depuis 2.1.318).
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

// Contexte que relirait la relance : celui de la dernière réponse ; juste après une compaction, aucune
// réponse encore (le moteur ne le dit qu'à la suivante), son estimation par catégories (`breakdown`,
// comme /context). Sans elle, 0 : aucune relance. Vu dans l'essai ACP du 28/11/2026 : 0 envoyé après
// chaque compaction du connecteur, la pause du contexte résumé n'était jamais gardée au chaud.
async function contextTokens($: EngineInterface): Promise<number> {
  const tokens = (await $.session.usage()).context.tokens
  if (tokens !== undefined) return tokens
  try {
    const total = (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.totalTokens
    return typeof total === 'number' && Number.isFinite(total) && total > 0 ? Math.round(total) : 0
  } catch {
    // Répartition illisible : comme avant, aucune relance.
    return 0
  }
}

// Secondes avant la prochaine relance selon le service, ou null.
async function nextPing($: EngineInterface, w: Warm, options: PluginOptions, profile?: Profile): Promise<number | null> {
  const to = await link($, options)
  if (!to || !w.main) return null
  const tokens = await contextTokens($)
  const idleS = Math.max(0, Math.round(((await $.clock.now()) - w.restedAt) / 1000))
  const idleCompact = await idleCompactTokens($)
  const reply = await post($, to, '/v1/warm', {
    model: w.main.model, context_tokens: tokens, idle_s: idleS, pings: w.pings,
    ...(idleCompact === undefined ? {} : { idle_compact_tokens: idleCompact }),
    ...(profile ? { profile } : {}),
  }, USAGE_TIMEOUT_MS)
  if (reply?.status !== 200) return null
  const after = field(reply.text, 'after_s')
  return typeof after === 'number' && Number.isInteger(after) && after >= 0 && after <= MAX_AFTER_S ? after : null
}

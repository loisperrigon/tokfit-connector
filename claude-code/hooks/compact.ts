// Compaction au coût : à la fin d'un tour du fil principal, le service dit si
// les relectures évitées paient la passation (POST /v1/compact) ; le connecteur
// ne décide rien. Les consignes gardent ce dont la suite a besoin.
import type { EngineInterface } from 'claude-code'
import { USAGE_TIMEOUT_MS, field, post } from './service'
import type { Link } from './service'

export const COMPACT_INSTRUCTIONS = 'Garde le but en cours, le plan et ses étapes restantes, les fichiers modifiés ou à modifier, ' +
  'les décisions et leurs raisons, les erreurs non résolues et chaque consigne de l’utilisateur. ' +
  'Résume en une ligne chaque résultat d’outil déjà exploité.'

// Absence de l'utilisateur avant une compaction quand le service n'en dit rien (service
// d'avant `after_s`) : sous la durée de cache la plus courte, 5 min (vu en vrai le 02/11/2026).
export const COMPACT_AFTER_MS = 240_000
// Borne d'un délai rendu par le service : une heure, la durée de cache la plus longue.
const AFTER_MAX_S = 3_600

// Délai d'absence (ms) après lequel compacter si le service le veut ; null s'il ne le
// veut pas, sur toute panne ou réponse illisible. Le service décide aussi du délai.
export async function wanted($: EngineInterface, to: Link, model: string): Promise<number | null> {
  const usage = await $.session.usage()
  const reply = await post($, to, '/v1/compact',
    { model, context_tokens: usage.context.tokens ?? 0, session_id: await $.session.id() }, USAGE_TIMEOUT_MS)
  if (reply?.status !== 200 || field(reply.text, 'compact') !== true) return null
  const after = field(reply.text, 'after_s')
  return typeof after === 'number' && Number.isFinite(after) && after >= 0 && after <= AFTER_MAX_S ? after * 1000 : COMPACT_AFTER_MS
}

// Issue d'une compaction voulue par le service, remontée avec l'étape suivante du fil
// (`compact_try`) : faite, passée par le moteur (`skip`), refusée (`error`), ou
// abandonnée parce que l'utilisateur est revenu (`back`).
export type Try = 'done' | 'skip' | 'error' | 'back'

// `turn.complete` part avant que le tour ne soit clos, et le moteur refuse une
// compaction tant qu'un tour tourne : nouvel essai chaque RETRY_MS, au plus TRIES fois,
// tant que `idle()` dit que l'utilisateur n'a pas repris la main (vu en vrai, 02/11/2026).
const RETRY_MS = 1_000
const TRIES = 5

// Session sans terminal (`-p`, SDK, tchat d'une application hôte) : le moteur y refuse
// `$.session.compact` (« not available in a headless (-p / SDK) session yet: compaction
// here runs inside a turn (a /compact prompt) », vu en vrai le 11/11/2026, Claude Code
// 2.1.322). C'était la cause des compactions jamais faites dans Open Codex.
const HEADLESS = /headless/i

// Compacte avec les consignes et dit l'issue ; ne lève jamais.
export async function compactNow($: EngineInterface, idle: () => boolean): Promise<Try> {
  for (let attempt = 1; idle(); attempt++) {
    try {
      const result = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
      return result.skip ? 'skip' : 'done'
    } catch (error) {
      if (HEADLESS.test(String(error))) return prompted($)
      // Refus du moteur (tour pas encore clos) : nouvel essai, puis abandon dit au service.
      if (attempt >= TRIES) return 'error'
    }
    await $.clock.sleep(RETRY_MS)
  }
  return 'back'
}

// Compaction lancée par la commande `/compact`, avec les mêmes consignes : la seule voie
// d'une session sans terminal (un prompt qui commence par « / » y est refusé à un plugin,
// qui doit passer par `$.command.run`).
async function prompted($: EngineInterface): Promise<Try> {
  try {
    await $.command.run({ command: 'compact', args: COMPACT_INSTRUCTIONS })
    return 'done'
  } catch {
    return 'error'
  }
}

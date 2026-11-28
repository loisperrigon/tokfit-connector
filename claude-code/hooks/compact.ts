// Compaction : à la fin d'un tour du fil principal, le service dit s'il faut compacter et
// après quelle absence de l'utilisateur (POST /v1/compact) ; le connecteur applique, avec les
// consignes du plan de session (plan.ts).
import type { EngineInterface } from 'claude-code'
import { USAGE_TIMEOUT_MS, field, post } from './service'
import type { Link } from './service'
import type { Profile } from './host'

// Borne d'un délai rendu par le service.
const AFTER_MAX_S = 3_600

// Délai d'absence (ms) après lequel compacter ; null si le service ne le veut pas, sur toute
// panne ou réponse illisible. Au plafond de contexte, le service rend 0 : dès la fin du tour.
// `hosted` : dans l'application hôte, dont la rotation des conversations est le plafond (host.ts) ;
// `profile` : profil de session posé par l'hôte (host.ts).
export async function wanted($: EngineInterface, to: Link, model: string, hosted: boolean,
  profile?: Profile): Promise<number | null> {
  const usage = await $.session.usage()
  const reply = await post($, to, '/v1/compact', {
    model, context_tokens: usage.context.tokens ?? 0, session_id: await $.session.id(), host: hosted,
    ...(profile ? { profile } : {}),
  }, USAGE_TIMEOUT_MS)
  if (reply?.status !== 200 || field(reply.text, 'compact') !== true) return null
  const after = field(reply.text, 'after_s')
  return typeof after === 'number' && Number.isFinite(after) && after >= 0 && after <= AFTER_MAX_S ? after * 1000 : null
}

// Compaction du fil annoncée par le moteur (`session.compact`) : arrête-t-elle les relances du cache ?
// Celle du moteur ou de l'utilisateur, oui (`$.model.fork` rejouerait la requête d'avant). Celle du
// connecteur, non : la chaîne repart ensuite sur le résumé. Par `$.session.compact` elle porte le
// déclencheur `plugin` ; sans terminal (SDK, ACP, tchat d'Alfie), la commande /compact est annoncée
// « manual » comme un /compact tapé, d'où `ours` : le connecteur l'attend (essai ACP du 28/11/2026).
export function stopsWarm(trigger: string | undefined, ours: boolean): boolean {
  return !ours && (trigger === 'auto' || trigger === 'manual')
}

// Issue d'une compaction voulue par le service, remontée avec l'étape suivante du fil
// (`compact_try`) : faite, passée par le moteur (`skip`), refusée (`error`), ou
// abandonnée parce que l'utilisateur est revenu (`back`).
export type Try = 'done' | 'skip' | 'error' | 'back'

// Le moteur refuse une compaction tant que le tour n'est pas clos : nouvel essai chaque
// RETRY_MS, au plus TRIES fois, tant que `idle()` dit que l'utilisateur n'a pas repris la main.
const RETRY_MS = 1_000
const TRIES = 5

// Refus du moteur dans une session sans terminal (`-p`, SDK, application hôte).
const HEADLESS = /headless/i

// Compacte avec les consignes et dit l'issue ; ne lève jamais.
export async function compactNow($: EngineInterface, idle: () => boolean, instructions: string): Promise<Try> {
  for (let attempt = 1; idle(); attempt++) {
    try {
      const result = await $.session.compact({ instructions })
      return result.skip ? 'skip' : 'done'
    } catch (error) {
      if (HEADLESS.test(String(error))) return prompted($, instructions)
      if (attempt >= TRIES) return 'error'
    }
    await $.clock.sleep(RETRY_MS)
  }
  return 'back'
}

// Session sans terminal : la commande `/compact`, avec les mêmes consignes.
async function prompted($: EngineInterface, instructions: string): Promise<Try> {
  try {
    await $.command.run({ command: 'compact', args: instructions })
    return 'done'
  } catch {
    // Refus : l'issue part au service avec l'étape suivante (`compact_try`).
    return 'error'
  }
}

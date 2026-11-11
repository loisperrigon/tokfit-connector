// Sous-agents lancés ensemble (« fan-out ») : ceux d'un même type partagent le
// début de leur requête (consigne système et outils). Lancés en même temps,
// chacun l'écrirait dans le cache ; ici, le premier part seul et les suivants
// attendent qu'il ait fini sa première étape, au plus FANOUT_WAIT_MS (le
// préfixe est en cache dès que sa réponse commence), puis le relisent.
// Mécanique pure, sans règle de décision ; un fork n'attend jamais (il relit
// déjà le cache de son parent).
import type { EngineInterface } from 'claude-code'
import { POLICY } from './policy'

export const FANOUT_WAIT_MS = POLICY.fanout_wait_ms

type Leader = { done: Promise<void>; release: () => void }

export type Fanout = {
  // Type de chaque sous-agent lancé, par identifiant.
  types: Map<string, string>
  // Première étape en cours, par type d'agent.
  leaders: Map<string, Leader>
}

export function fanout(): Fanout {
  return { types: new Map(), leaders: new Map() }
}

export function launched(f: Fanout, agentId: string, subagentType: string): void {
  if (subagentType !== 'fork') f.types.set(agentId, subagentType)
}

// Ce que rend `queued` : la fonction à appeler après l'étape, et si l'agent a
// attendu un premier de son type (fait du levier `fanout` du service).
export type Queued = { release: () => void; waited: boolean }

const NOTHING: Queued = { release: () => undefined, waited: false }

// Avant la première étape d'un sous-agent : attend le premier de son type s'il
// est en vol, sinon le devient.
export async function queued($: EngineInterface, f: Fanout, agentId: string): Promise<Queued> {
  const type = f.types.get(agentId)
  if (type === undefined) return NOTHING
  const leader = f.leaders.get(type)
  if (leader) {
    const stop = new AbortController()
    await Promise.race([leader.done, $.clock.sleep(FANOUT_WAIT_MS, { signal: stop.signal }).catch(() => undefined)])
    stop.abort()
    return { release: () => undefined, waited: true }
  }
  let release = (): void => undefined
  const done = new Promise<void>(resolve => { release = resolve })
  const own: Leader = { done, release }
  f.leaders.set(type, own)
  return {
    release: () => {
      own.release()
      if (f.leaders.get(type) === own) f.leaders.delete(type)
    },
    waited: false,
  }
}

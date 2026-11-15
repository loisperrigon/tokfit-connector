// Levier prefix : une section du prompt système que le plan nomme (le chemin de la mémoire, propre au
// projet et au dossier de configuration) en sort, et le contexte du premier message la porte à sa place.
// Le prompt système, alors le même d'une session et d'un projet à l'autre, est relu en cache au lieu
// d'être réécrit. Le moteur calcule ce contexte en même temps qu'il assemble ses sections, souvent avant
// elles : le contexte attend les sections nommées, `PREFIX_WAIT_MS` au plus ; passé ce délai, ou une fois
// le contexte rendu, une section arrivée trop tard reste dans le prompt système (rien ne se perd).
import type { EngineInterface, PromptContextBlock } from 'claude-code'
import { NAME } from './service'

export const PREFIX_WAIT_MS = 1_500

export type Prefix = {
  // Sections retirées, par id : texte du moteur.
  moved: Map<string, string>
  // Sections nommées déjà assemblées par le moteur, retirées ou absentes (texte nul).
  seen: Set<string>
  // Contexte rendu : plus rien ne sort du prompt système.
  closed: boolean
  arrived: (() => void) | undefined
}

export function prefix(): Prefix {
  return { moved: new Map(), seen: new Set(), closed: false, arrived: undefined }
}

// Section nommée par le plan, telle que le moteur l'a calculée : vrai si elle quitte le prompt système.
export function taken(h: Prefix, name: string, text: string | null): boolean {
  const take = text !== null && !h.closed
  if (take) h.moved.set(name, text)
  h.seen.add(name)
  h.arrived?.()
  return take
}

// Blocs à joindre au contexte, après l'attente bornée des sections nommées ; ferme la prise.
export async function carried($: EngineInterface, h: Prefix, names: ReadonlySet<string>,
                              waitMs: number = PREFIX_WAIT_MS): Promise<PromptContextBlock[]> {
  const missing = (): boolean => [...names].some(name => !h.seen.has(name))
  if (!h.closed && missing()) {
    const stop = new AbortController()
    const all = new Promise<void>(resolve => { h.arrived = () => { if (!missing()) resolve() } })
    try {
      await Promise.race([all, $.clock.sleep(waitMs, { signal: stop.signal }).catch(() => undefined)])
    } finally {
      stop.abort()
      h.arrived = undefined
    }
  }
  h.closed = true
  return [...h.moved].map(([name, text]) => ({ name: `${NAME}:${name}`, text }))
}

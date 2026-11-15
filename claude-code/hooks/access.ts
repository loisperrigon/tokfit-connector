// Au démarrage de la session : lien au service (clé anonyme comprise, key.ts)
// et commande `/<NAME>`, qui écrit en ligne de la conversation (`$.ui.log`) le
// texte du lien du tableau de bord rendu par le service, puis l'état de chaque
// levier pour la session (state.ts, même quand le service ne répond pas) ; la
// commande ne rend aucune sortie.
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { NAME, field, link, post } from './service'
import type { Link } from './service'
import { leverReport } from './state'
import type { Sources } from './state'

// Attente maximale du lien (commande tapée par la personne).
export const LINK_TIMEOUT_MS = 6000

export function access(on: On, options: PluginOptions, sources: Sources): void {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void link($, options)
    void $.command.register({ name: NAME, description: 'Lien vers ton tableau de bord (bilan, abonnement) et état des leviers.' })
      .catch(() => {
        // Nom refusé par le moteur : la session continue sans la commande.
      })
    return started
  })

  on('command.run', { command: NAME }, async ($) => {
    const to = await link($, options)
    await showLink($, to)
    try {
      $.ui.log(await leverReport($, sources, to))
    } catch {
      // État illisible : le lien seul.
    }
    return {}
  })
}

async function showLink($: EngineInterface, to: Link | null): Promise<void> {
  if (!to) return
  const reply = await post($, to, '/v1/dashboard/link', {}, LINK_TIMEOUT_MS)
  const text = reply?.status === 200 ? field(reply.text, 'text') : undefined
  if (typeof text === 'string' && text.trim()) $.ui.log(text.trim())
}

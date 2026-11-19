// Au démarrage de la session : lien au service (clé anonyme comprise, key.ts), commande `/<NAME>` et
// surveillance de l'outil principal (python.ts) : `startAccess`, appelé par le hook `session.start` de register.ts
// (le moteur n'admet qu'un hook `session.start` sans filtre pour tout le connecteur). La commande écrit en ligne de la conversation (`$.ui.log`)
// le texte du lien du tableau de bord rendu par le service (dans la langue du client), l'état de chaque levier pour la session
// (state.ts, même quand le service ne répond pas), puis le diagnostic de l'outil principal (Python,
// installation, serveur, outils, service, version du connecteur) ; la commande ne rend aucune sortie.
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { NAME, field, link, post, probeKey } from './service'
import type { Link } from './service'
import { leverReport } from './state'
import type { Sources } from './state'
import { check, healthReport, watch } from './python'
import { isAccountTool, isKernelTool } from './kernel'
import { pluginVersion } from './versions'
import { answer } from './experiments'
import { t } from './lang'

// Attente maximale du lien (commande tapée par la personne).
export const LINK_TIMEOUT_MS = 6000

export function startAccess($: EngineInterface, options: PluginOptions, sources: Sources): void {
  void probeKey($, options, LINK_TIMEOUT_MS).catch(() => {
    // Service injoignable : rien n'est su de la clé, le bandeau garde ses autres raisons.
  })
  void $.command.register({ name: NAME, description: t('Lien vers ton tableau de bord (bilan, abonnement), état des leviers et de l\'outil principal.',
    'Link to your dashboard (savings, subscription), state of the levers and of the main tool.') })
    .catch(() => {
      // Nom refusé par le moteur : la session continue sans la commande.
    })
  try {
    watch($, sources.health, async () => (await link($, options)) !== null)
  } catch {
    // Minuterie refusée : le diagnostic se fait aux étapes et au rendu du bandeau.
  }
}

export function access(on: On, options: PluginOptions, sources: Sources): void {

  on('command.run', { command: NAME }, async ($) => {
    const to = await link($, options)
    await spoken($, sources, to)
    const status = await showLink($, to)
    try {
      $.ui.log(await leverReport($, sources, to))
    } catch {
      // État illisible : le lien seul.
    }
    try {
      $.ui.log(await diagnostic($, sources, to, status))
    } catch {
      // Outils ou fichiers illisibles : le reste est déjà écrit.
    }
    return {}
  })
}

// Lien du tableau de bord écrit dans la conversation ; rend le statut HTTP de la réponse (0 sans réponse,
// null sans lien au service).
async function showLink($: EngineInterface, to: Link | null): Promise<number | null> {
  if (!to) return null
  const reply = await post($, to, '/v1/dashboard/link', {}, LINK_TIMEOUT_MS)
  const text = reply?.status === 200 ? field(reply.text, 'text') : undefined
  if (typeof text === 'string' && text.trim()) $.ui.log(text.trim())
  return reply?.status ?? 0
}

// Langue des textes connue avant d'écrire (réponse de /v1/levers de la session, lang.ts) ; jamais levé.
async function spoken($: EngineInterface, sources: Sources, to: Link | null): Promise<void> {
  if (!to) return
  try {
    await answer($, sources.holdout, to)
  } catch {
    // Service muet : les textes restent dans la langue déjà connue.
  }
}

function serviceText(status: number | null): string {
  if (status === null) return t('non relié (adresse ou clé absente)', 'not linked (address or key missing)')
  if (status === 0) return t('injoignable', 'unreachable')
  if (status === 401 || status === 403) return t(`joignable, clé refusée (${status})`, `reachable, key refused (${status})`)
  if (status >= 200 && status < 300) return t('joignable, clé acceptée', 'reachable, key accepted')
  return t(`joignable, réponse ${status}`, `reachable, answer ${status}`)
}

async function diagnostic($: EngineInterface, sources: Sources, to: Link | null, status: number | null): Promise<string> {
  const d = await check($, sources.health, to !== null)
  const tools = await $.tool.list()
  const present = {
    kernel: tools.some(tool => tool.mcp && isKernelTool(tool.name)),
    account: tools.some(tool => tool.mcp && isAccountTool(tool.name)),
  }
  return healthReport(d, sources.health.files, present, serviceText(status), await pluginVersion($))
}

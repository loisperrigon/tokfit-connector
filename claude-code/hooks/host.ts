// Application qui lance Claude Code et relaie le service pour lui (Open Codex,
// bureau de Lois : son dépôt, docs/routage-modele.md). Elle se signale par deux
// variables posées dans le terminal de chaque conversation :
// - OPEN_CODEX_PANE : identifiant de la conversation dans l'application ;
// - OPEN_CODEX_BRIDGE : fichier de son pont local ({ url, token }, relu à chaque
//   envoi : son port change quand l'application redémarre).
// Elle peut aussi couper des leviers pour la conversation (TOKFIT_OFF,
// experiments.ts) et relayer le service avec son propre jeton
// (TOKFIT_RELAY_URL, TOKFIT_RELAY_TOKEN : service.ts).
//
// Dans cette application, l'issue de chaque décision du fil principal part sur
// son pont (évènement `RouteStatus`), qui l'affiche au-dessus du terminal, et la
// ligne d'état du terminal n'est pas écrite (elle ferait doublon). Rien d'autre
// ne change ; hors de l'application, ce module ne fait rien. Aucun texte de
// message ne part sur le pont : état, famille du modèle, réflexion, raison.
import type { EngineInterface } from 'claude-code'

export type Host = { pane: string; bridge: string }
// Lecture des deux variables, une fois par session (état de la session, register.ts).
export type Seen = { host?: Promise<Host | null> }

// État d'une décision, dans les mots du voyant de l'application.
export type RouteReport =
  | { state: 'pending' }
  | { state: 'ok'; model: string; effort: string; reason: string }
  | { state: 'failing' | 'not_configured'; reason: string }

export function host($: EngineInterface, seen: Seen): Promise<Host | null> {
  seen.host ??= (async () => {
    const pane = await $.env.get('OPEN_CODEX_PANE')
    const bridge = await $.env.get('OPEN_CODEX_BRIDGE')
    return pane && bridge ? { pane, bridge } : null
  })().catch(() => null)
  return seen.host
}

// Ligne d'état du terminal, seulement hors de l'application hôte.
export async function status($: EngineInterface, seen: Seen, text: string | undefined): Promise<void> {
  if (await host($, seen)) return
  $.ui.status(text)
}

// Issue d'une décision postée sur le pont de l'application ; jamais bloquant, jamais levé.
export async function report($: EngineInterface, seen: Seen, route: RouteReport): Promise<void> {
  try {
    const at = await host($, seen)
    if (!at) return
    const bridge = JSON.parse(await $.fs.read(at.bridge)) as { url?: unknown; token?: unknown }
    if (typeof bridge.url !== 'string' || !bridge.url.startsWith('http://127.0.0.1:') || typeof bridge.token !== 'string') return
    await $.http.fetch(bridge.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: bridge.token, pane: at.pane, event: 'RouteStatus', route }),
    })
  } catch {
    // Application fermée ou relancée : le voyant reprendra au prochain message.
  }
}

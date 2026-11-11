// Audit du contexte de départ : une fois par session, après le premier tour du
// fil principal, les lignes de /context et les serveurs MCP avec leurs tokens
// partent au service (POST /v1/context) pour le tableau de bord. Des libellés
// et des nombres seulement : ni chemin de fichier mémoire, ni contenu.
import type { EngineInterface, SessionContextBreakdown } from 'claude-code'
import { USAGE_TIMEOUT_MS, post } from './service'
import type { Link } from './service'

const LABEL = /^[\w .,:()/&+'-]{1,64}$/u

export type ContextSnapshot = {
  session_id: string
  used_tokens: number
  categories: { name: string; tokens: number }[]
  mcp_servers: { server: string; tokens: number }[]
}

export function snapshot(session: string, breakdown: SessionContextBreakdown): ContextSnapshot {
  const servers = new Map<string, number>()
  for (const tool of breakdown.mcpTools) {
    // Un outil différé (chargé à la demande) ne pèse pas sur le départ.
    if (tool.isLoaded && LABEL.test(tool.serverName)) servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + Math.round(tool.tokens))
  }
  return {
    session_id: session,
    used_tokens: Math.round(breakdown.totalTokens),
    categories: breakdown.categories.filter(row => row.kind === 'used' && LABEL.test(row.name))
      .slice(0, 40).map(row => ({ name: row.name, tokens: Math.round(row.tokens) })),
    mcp_servers: [...servers].slice(0, 100).map(([server, tokens]) => ({ server, tokens })),
  }
}

// Ne lève jamais : un audit perdu ne change rien pour le client.
export async function audit($: EngineInterface, to: Link): Promise<void> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const breakdown = usage.context.breakdown
    if (!breakdown) return
    await post($, to, '/v1/context', snapshot(await $.session.id(), breakdown), USAGE_TIMEOUT_MS)
  } catch {
    // Répartition illisible : rien à remonter.
  }
}

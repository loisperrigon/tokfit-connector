// Audit du contexte de départ : une fois par session, des libellés et des
// nombres vers /v1/context, jamais un chemin de fichier mémoire.
import { describe, expect, test } from 'claude-code/testing'
import type { SessionContextBreakdown } from 'claude-code'
import { SESSION, URL, complete, step, user, world } from './support'

const BREAKDOWN: SessionContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 3_100.4, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 12_000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 40_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { name: 'Free space', tokens: 150_000, color: 'inactive', isDeferred: false, kind: 'free' },
  ],
  totalTokens: 15_100, maxTokens: 200_000, rawMaxTokens: 200_000, autocompactSource: 'model-default', percentage: 8,
  gridRows: [], model: 'claude-opus-5-5',
  memoryFiles: [{ path: '/home/client/secret-projet/CLAUDE.md', type: 'Project', tokens: 900 }],
  mcpTools: [
    { name: 'mcp__oc-ads__run', serverName: 'oc-ads', tokens: 7_000, isLoaded: true },
    { name: 'mcp__oc-ads__list', serverName: 'oc-ads', tokens: 3_000, isLoaded: true },
    { name: 'mcp__brain__search', serverName: 'brain', tokens: 2_000, isLoaded: true },
    { name: 'mcp__web__fetch', serverName: 'web', tokens: 5_000, isLoaded: false },
  ],
  agents: [], isAutoCompactEnabled: true, apiUsage: null,
}

describe('audit du contexte de départ', () => {
  test('après le premier tour : catégories utilisées et serveurs MCP, une seule fois par session', async ($, on) => {
    const w = world(on, { messages: [user('x')], breakdown: BREAKDOWN })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await step($, 0, { turnId: 't2' })
    await complete($, 't2')
    await w.clock.settle()
    const sent = w.sent.filter(s => s.url === `${URL}/v1/context`)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toEqual({
      session_id: SESSION, used_tokens: 15_100,
      categories: [{ name: 'System prompt', tokens: 3_100 }, { name: 'MCP tools', tokens: 12_000 }],
      mcp_servers: [{ server: 'oc-ads', tokens: 10_000 }, { server: 'brain', tokens: 2_000 }],
    })
    expect(JSON.stringify(w.sent)).not.toContain('secret-projet')
  })

  test('sans répartition : rien ne part', async ($, on) => {
    const w = world(on, { messages: [user('x')] })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    expect(w.sent.filter(s => s.url.endsWith('/v1/context'))).toEqual([])
  })
})

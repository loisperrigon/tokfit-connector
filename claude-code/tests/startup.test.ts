// Ouverture de session : la liste des leviers (`/v1/levers`) et le plan de session (`/v1/content`)
// partent ensemble dès le démarrage, sans attendre le premier message ni l'une l'autre.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { step, user, world } from './support'

async function started($: Engine): Promise<void> {
  await $.session.start({ cwd: '/projet', surface: null, isInteractive: false })
}

describe('ouverture de session', () => {
  test('au démarrage : leviers et plan demandés ensemble, aucun n\u2019attend l\u2019autre', async ($, on) => {
    const w = world(on, { levers: () => 'silent', content: () => 'silent' })
    await started($)
    await w.clock.settle()
    expect(w.leverCalls()).toHaveLength(1)
    expect(w.contentCalls()).toHaveLength(1)
  })

  test('premier message après le démarrage : les réponses déjà reçues servent, rien n\u2019est redemandé', async ($, on) => {
    const w = world(on, { messages: [user('x')] })
    await started($)
    await w.clock.settle()
    await step($, 0)
    expect(w.leverCalls()).toHaveLength(1)
    expect(w.contentCalls()).toHaveLength(1)
    expect(w.routes()).toHaveLength(1)
  })

  test('sans lien au service : rien ne part au démarrage', async ($, on) => {
    const w = world(on, { config: null, anonymous: () => ({ status: 503 }) })
    await started($)
    await w.clock.settle()
    expect(w.leverCalls()).toHaveLength(0)
    expect(w.contentCalls()).toHaveLength(0)
  })

  test('section du prompt (levier prefix) : le plan est demandé sans attendre la liste des leviers', async ($, on) => {
    const w = world(on, { levers: () => 'silent', content: () => 'silent' })
    void $.prompt.section({ name: 'memory', text: 'TEST-mémoire' })
    await w.clock.settle()
    expect(w.leverCalls()).toHaveLength(1)
    expect(w.contentCalls()).toHaveLength(1)
  })

  test('outils du noyau (levier kernel) : le plan est demandé sans attendre la liste des leviers', async ($, on) => {
    const w = world(on, { levers: () => 'silent', content: () => 'silent', tools: ['Read', 'mcp__plugin_tokfit_outils__agir'] })
    void $.tool.describe({ tool: 'Read', description: 'lit un fichier', provider: { plugin: 'engine', tier: 'core' } })
    await w.clock.settle()
    expect(w.leverCalls()).toHaveLength(1)
    expect(w.contentCalls()).toHaveLength(1)
  })
})

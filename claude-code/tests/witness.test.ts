// Test témoin : le texte des messages ne quitte la machine que vers /v1/route
// (pour la décision) ; il n'est jamais stocké, journalisé, affiché, ni joint
// aux compteurs.
import { expect, test } from 'claude-code/testing'
import { SESSION, agent, assistant, complete, end, step, user, world } from './support'
import type { Reply } from './support'

const WITNESS = 'TEMOIN-connecteur-7f3a-texte-libre'

const cases: [string, Reply][] = [
  ['décision appliquée', { status: 200, body: { model: 'sonnet', effort: 'low' } }],
  ['service en erreur', { status: 502, body: { error: `écho ${WITNESS}` } }],
  ['clé refusée', { status: 401, body: { error: `écho ${WITNESS}` } }],
  ['réponse illisible', { status: 200, text: `<html>${WITNESS}</html>` }],
]

for (const [name, reply] of cases) {
  test(`${name} : le texte n’est ni stocké, ni journalisé, ni affiché, ni compté`, async ($, on) => {
    const w = world(on, {
      messages: [user(`premier ${WITNESS}`), assistant(`réponse ${WITNESS}`), user(`[low] ${WITNESS} explique ce fichier`)],
      route: () => reply, usage: () => ({ status: 500, body: { error: `écho ${WITNESS}` } }),
      files: { '/projet/.claude/agents/aide.md': '---\nname: aide\n---\nconsigne' },
      agentMessages: { 'agent-1': [user(`${WITNESS} sous-tâche`), assistant(`fait ${WITNESS}`), user(`reprends ${WITNESS}`)] },
    })
    await step($, 0, { turnId: 't1' })
    await agent($, `${WITNESS} sous-tâche`, { type: 'aide' })
    await step($, 0, { turnId: 'a-t1', agentId: 'agent-1' })
    // Reprise du sous-agent, puis un fork du fil principal.
    await step($, 0, { turnId: 'a-t2', agentId: 'agent-1' })
    await agent($, `${WITNESS} vérifie`, { fork: true })
    await step($, 0, { turnId: 'f-t1', agentId: 'agent-2' })
    await $.session.compact({ trigger: 'manual', messages: [user(WITNESS)] })
    await complete($, 't1')
    await w.clock.settle()
    await end($)

    // Le texte part vers la décision, et seulement là.
    expect(JSON.stringify(w.routes())).toContain(WITNESS)
    const elsewhere = w.sent.filter(s => !s.url.endsWith('/v1/route'))
    expect(elsewhere.length).toBeGreaterThan(0)
    expect(JSON.stringify(elsewhere)).not.toContain(WITNESS)
    expect(JSON.stringify(w.usages().map(u => u.body))).toContain(SESSION)
    // Rien d'écrit sur la machine (ni fichier, ni magasin du plugin, ni journal, ni commande).
    expect(w.written).toEqual([])
    expect(JSON.stringify(w.shown)).not.toContain(WITNESS)
  })
}

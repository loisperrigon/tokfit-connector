// Routage par message en bêta, coupé pour le client (service/router.py) : les deux réponses
// neutres du service laissent le réglage en place dans ce connecteur et dans tous ceux déjà
// publiés (0.6 à 0.7.10, même `underUser`, `routed` et `decide`). Fil principal : 200 sans
// réglage ; sous-agent : 204, car un 200 sans modèle y poserait le modèle du parent.
import { describe, expect, test } from 'claude-code/testing'
import { agent, messages, step, user, world } from './support'
import type { Reply } from './support'

const MAIN_OFF: Reply = { status: 200, body: { model: null, effort: null, lean_thinking: true } }
const SUBAGENT_OFF: Reply = { status: 204, text: '' }
const off = (body: Record<string, unknown>): Reply => (body.kind === 'subagent' ? SUBAGENT_OFF : MAIN_OFF)

describe('routage bêta coupé : ni modèle ni effort changés', () => {
  test('fil principal : réglage gardé, ligne d’état sur ce réglage, rien d’autre montré', async ($, on) => {
    const w = world(on, { messages: [user('corrige le bug du bouton')], route: off })
    await step($, 0)
    expect(w.routes()).toHaveLength(1)
    expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.shown).toContain('ui.status opus · high')
    expect(messages(w)).toEqual([])
  })

  test('fil principal : le plancher d’effort de la personne reste le sien', async ($, on) => {
    const w = world(on, { messages: [user('x')], env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' }, route: off })
    await step($, 0, { effort: 'xhigh' })
    expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' })
  })

  test('sous-agent : 204, le modèle demandé au lancement reste', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: off })
    expect(await agent($, 'relis le module', { model: 'sonnet' })).toBe('sonnet')
    await step($, 0, { turnId: 'a-t1', agentId: 'agent-1', model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(w.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(messages(w)).toEqual([])
  })

  test('sous-agent : un 200 sans modèle poserait le modèle du parent (d’où le 204)', async ($, on) => {
    world(on, { messages: [user('x')], route: () => MAIN_OFF })
    expect(await agent($, 'relis le module', { model: 'sonnet' })).toBe('claude-opus-5-5')
  })
})

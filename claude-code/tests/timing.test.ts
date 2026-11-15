// Faits de durée joints aux compteurs (timing.ts) : attente du modèle, temps des
// outils, durée du tour jusqu'à la réponse finale ; des nombres seulement.
import { describe, expect, test } from 'claude-code/testing'
import { aborted, complete, step, user, world } from './support'
import type { World } from './support'
import { duration, ran, timing, toolTime } from '../hooks/timing'

type Sent = Record<string, unknown>

function sentSteps(w: World): Sent[] {
  return w.usages().flatMap(sent => (sent.body as { steps: Sent[] }).steps)
}

// Lance `run`, fait avancer l'horloge du monde de `ms` pendant qu'il attend, puis le termine.
async function during<T>(w: World, ms: number, run: Promise<T>): Promise<T> {
  await w.clock.advance(ms)
  return run
}

describe('durées des étapes', () => {
  test('attente du modèle, outils de la boucle et durée du tour', async ($, on) => {
    const w = world(on, { messages: [user('x')], slow: { step: 1_500, tool: 2_000 }, read: () => 'contenu' })
    await during(w, 1_500, step($, 0, { turnId: 't1' }))
    await during(w, 2_000, $.tool.call({ tool: 'Read', tool_use_id: 'tu-1', file_path: '/x' }))
    await during(w, 1_500, step($, 1, { turnId: 't1' }))
    await complete($, 't1')
    await w.clock.settle()
    const steps = sentSteps(w)
    expect(steps.map(s => [s.model_ms, s.tool_ms, s.turn_ms])).toEqual([
      [1_500, undefined, undefined],
      // La dernière étape porte la durée du tour, de sa première étape à sa fin.
      [1_500, 2_000, 5_000],
    ])
  })

  test('outils en parallèle : comptés une fois ; ceux d’un sous-agent sur sa propre étape', async ($, on) => {
    const w = world(on, { messages: [user('x')], slow: { tool: 1_000 }, read: () => 'contenu' })
    await step($, 0, { turnId: 't1' })
    await during(w, 1_000, Promise.all([
      $.tool.call({ tool: 'Read', tool_use_id: 'tu-1', file_path: '/a' }),
      $.tool.call({ tool: 'Read', tool_use_id: 'tu-2', file_path: '/b' }),
    ]))
    await during(w, 1_000, $.tool.call({ tool: 'Read', tool_use_id: 'tu-3', file_path: '/c', agentId: 'agent-1' }))
    await step($, 0, { turnId: 't1', agentId: 'agent-1' })
    await step($, 1, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    expect(sentSteps(w).map(s => [s.subagent, s.tool_ms])).toEqual([[undefined, undefined], [true, 1_000], [undefined, 1_000]])
  })

  test('tour interrompu : pas de durée de tour, et ses outils ne passent pas au tour suivant', async ($, on) => {
    const w = world(on, { messages: [user('x')], slow: { tool: 1_000 }, read: () => 'contenu' })
    await step($, 0, { turnId: 't1' })
    await during(w, 1_000, $.tool.call({ tool: 'Read', tool_use_id: 'tu-1', file_path: '/x' }))
    await aborted($, 't1')
    await w.clock.advance(5_000)
    await step($, 0, { turnId: 't2' })
    await complete($, 't2')
    await w.clock.settle()
    const steps = sentSteps(w)
    expect(steps.map(s => [s.tool_ms, s.turn_ms])).toEqual([[undefined, undefined], [undefined, undefined]])
  })

  test('durée bornée, nulle ou illisible : absente', () => {
    expect(duration(0)).toBeUndefined()
    expect(duration(Number.NaN)).toBeUndefined()
    expect(duration(12.4)).toBe(12)
    expect(duration(1e12)).toBe(604_800_000)
    const t = timing()
    ran(t, 'main', 10, 20)
    ran(t, 'main', 15, 30)
    ran(t, 'main', 40, 45)
    ran(t, 'main', 50, 50)
    expect(toolTime(t, 'main')).toEqual({ tool_ms: 25 })
    expect(toolTime(t, 'main')).toEqual({})
  })
})

// Faits de durée joints aux compteurs (timing.ts) : attente du modèle, phase des
// outils, durée du tour jusqu'à la réponse finale ; des nombres seulement.
import { describe, expect, test } from 'claude-code/testing'
import type { TurnStepInput } from 'claude-code'
import { aborted, complete, step, user, world } from './support'
import type { World } from './support'
import { duration, responded, timing, toolTime } from '../hooks/timing'

type Sent = Record<string, unknown>

function sentSteps(w: World): Sent[] {
  return w.usages().flatMap(sent => (sent.body as { steps: Sent[] }).steps)
}

// Lance `run`, fait avancer l'horloge du monde de `ms` pendant qu'il attend, puis le termine.
async function during<T>(w: World, ms: number, run: Promise<T>): Promise<T> {
  await w.clock.advance(ms)
  return run
}

// La réponse de chaque étape demande une lecture, sauf aux étapes `last` de la boucle.
const reading = (last: (e: TurnStepInput) => boolean) => (e: TurnStepInput) =>
  last(e) ? [] : [{ name: 'Read', input: { file_path: '/x' } }]

describe('durées des étapes', () => {
  test('attente du modèle, phase des outils de la boucle et durée du tour', async ($, on) => {
    const w = world(on, { messages: [user('x')], slow: { step: 1_500 }, uses: reading(e => e.index === 1) })
    await during(w, 1_500, step($, 0, { turnId: 't1' }))
    // Outils, permissions et crochets : tout ce qui sépare la réponse de l'envoi de l'étape suivante.
    await w.clock.advance(2_000)
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

  test('phase des outils lue sur les étapes : un outil qu’aucun crochet du connecteur ne vise est compté', async ($, on) => {
    const w = world(on, { messages: [user('x')], slow: { tool: 1_000 }, uses: reading(e => e.index === 1) })
    await step($, 0, { turnId: 't1' })
    await during(w, 1_000, $.tool.call({ tool: 'WebFetch', tool_use_id: 'tu-1', url: 'https://exemple.test', prompt: 'titre' }))
    await step($, 1, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    expect(sentSteps(w).map(s => s.tool_ms)).toEqual([undefined, 1_000])
  })

  test('chaque boucle a sa phase d’outils ; une réponse finale n’en ouvre pas', async ($, on) => {
    const w = world(on, { messages: [user('x')], uses: reading(e => e.agentId === undefined ? e.index === 1 : e.index === 2) })
    await step($, 0, { turnId: 't1' })
    await w.clock.advance(500)
    await step($, 0, { turnId: 'a1', agentId: 'agent-1' })
    await w.clock.advance(1_000)
    await step($, 1, { turnId: 'a1', agentId: 'agent-1' })
    await w.clock.advance(300)
    await step($, 1, { turnId: 't1' })
    await w.clock.advance(4_000)
    await step($, 0, { turnId: 't2' })
    await complete($, 't2')
    await w.clock.settle()
    expect(sentSteps(w).map(s => [s.subagent, s.tool_ms])).toEqual([
      [undefined, undefined], [true, undefined], [true, 1_000], [undefined, 1_800], [undefined, undefined],
    ])
  })

  test('tour interrompu : pas de durée de tour, et sa phase d’outils ne passe pas au tour suivant', async ($, on) => {
    const w = world(on, { messages: [user('x')], uses: reading(e => e.turnId === 't2') })
    await step($, 0, { turnId: 't1' })
    await w.clock.advance(1_000)
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
    responded(t, 'main', 10, 2)
    expect(toolTime(t, 'main', 1, 35)).toEqual({ tool_ms: 25 })
    expect(toolTime(t, 'main', 2, 50)).toEqual({})
    responded(t, 'main', 10, 1)
    expect(toolTime(t, 'main', 0, 35)).toEqual({})
    responded(t, 'main', 10, 1)
    responded(t, 'main', 20, 0)
    expect(toolTime(t, 'main', 1, 35)).toEqual({})
  })
})

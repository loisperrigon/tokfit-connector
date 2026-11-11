// Sous-agents lancés ensemble : ceux d'un même type attendent que le premier
// ait écrit leur début commun dans le cache (au plus FANOUT_WAIT_MS).
import { describe, expect, test } from 'claude-code/testing'
import { FANOUT_WAIT_MS } from '../hooks/fanout'
import { URL, config, spawn, step, user, world } from './support'
import type { Options, World } from './support'
import type { Engine } from 'claude-code/testing'

function entered(w: World): string[] {
  return w.steps.map(s => s.agentId ?? 'main')
}

// Deux sous-agents lancés, puis leurs premières étapes en même temps.
async function together($: Engine, w: World, types: [string, string], fork = false): Promise<Promise<unknown>[]> {
  for (const type of types) await spawn($, 'tâche', { type, ...(fork && type === 'fork' ? { fork: true as const } : {}) })
  const runs = [step($, 0, { turnId: 'a1', agentId: 'agent-1' }), step($, 0, { turnId: 'a2', agentId: 'agent-2' })]
  await w.clock.settle()
  return runs
}

// Étapes de sous-agents retenues jusqu'à `release()`.
function gate(): { options: Options; release: () => void } {
  let open = (): void => undefined
  const opened = new Promise<void>(resolve => { open = resolve })
  return { options: { messages: [user('x')], holdAgent: () => opened }, release: () => open() }
}

describe('fan-out', () => {
  test('même type : le second attend le premier, au plus le délai', async ($, on) => {
    const g = gate()
    const w = world(on, g.options)
    const runs = await together($, w, ['Explore', 'Explore'])
    expect(entered(w)).toEqual(['agent-1'])
    await w.clock.advance(FANOUT_WAIT_MS)
    expect(entered(w)).toEqual(['agent-1', 'agent-2'])
    g.release()
    await Promise.all(runs)
  })

  test('le premier répond avant le délai : le second part aussitôt', async ($, on) => {
    const g = gate()
    const w = world(on, g.options)
    const runs = await together($, w, ['Explore', 'Explore'])
    g.release()
    await w.clock.settle()
    expect(entered(w)).toEqual(['agent-1', 'agent-2'])
    await Promise.all(runs)
  })

  for (const [name, key, types] of [
    ['types différents', undefined, ['Explore', 'general-purpose']],
    ['sans clé', 'mauvaise', ['Explore', 'Explore']],
  ] as const) {
    test(`${name} : aucune attente`, async ($, on) => {
      const g = gate()
      const w = world(on, { ...g.options, ...(key ? { config: config(URL, key) } : {}) })
      const runs = await together($, w, [types[0], types[1]])
      expect(entered(w)).toEqual(['agent-1', 'agent-2'])
      g.release()
      await Promise.all(runs)
    })
  }

  test('un fork n’attend jamais', async ($, on) => {
    const g = gate()
    const w = world(on, g.options)
    const runs = await together($, w, ['fork', 'fork'], true)
    expect(entered(w)).toEqual(['agent-1', 'agent-2'])
    g.release()
    await Promise.all(runs)
  })
})

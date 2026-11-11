// Compaction au coût : à la fin d'un tour du fil principal, le service dit s'il
// faut compacter ; le connecteur compacte avec ses consignes, puis les relances
// du cache partent sur la conversation résumée.
import { describe, expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { COMPACT_INSTRUCTIONS, compactNow } from '../hooks/compact'
import { SESSION, URL, complete, config, step, user, world } from './support'
import type { Reply } from './support'

const YES = (): Reply => ({ status: 200, body: { compact: true } })

function stepsOf(body: Record<string, unknown>): Record<string, unknown>[] {
  return body.steps as Record<string, unknown>[]
}

describe('compaction au coût', () => {
  test('fin de tour : le service est consulté avec le modèle, le contexte et la session', async ($, on) => {
    const w = world(on, { messages: [user('x')] })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    expect(w.compacts()).toHaveLength(1)
    expect(w.compacts()[0]?.url).toBe(`${URL}/v1/compact`)
    expect(w.compacts()[0]?.body).toEqual({ model: 'claude-opus-5-5', context_tokens: 42_000, session_id: SESSION })
    expect(w.compactions).toEqual([])
  })

  test('le service dit oui : compaction après 4 min d’absence, cache froid signalé au message suivant', async ($, on) => {
    const w = world(on, { messages: [user('x')], compact: YES })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    // La réponse reste à l'écran tant que l'utilisateur peut la lire.
    await w.clock.advance(239_000)
    expect(w.compactions).toEqual([])
    await w.clock.advance(1_000)
    expect(w.compactions).toEqual([{ instructions: COMPACT_INSTRUCTIONS }])
    await step($, 0, { turnId: 't2' })
    expect(w.routes().at(-1)?.body).toMatchObject({ cache_cold: true, model_cache: {} })
  })

  test('l’utilisateur revient avant : ni compaction ni relance de cette pause', async ($, on) => {
    const w = world(on, { messages: [user('x')], compact: YES })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(100_000)
    await step($, 0, { turnId: 't2' })
    await w.clock.advance(300_000)
    expect(w.compactions).toEqual([])
    expect(w.warms()).toEqual([])
  })

  test('la relance du cache est demandée après la compaction', async ($, on) => {
    const w = world(on, { messages: [user('x')], compact: YES })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(240_000)
    const order = w.sent.map(s => s.url.slice(URL.length)).filter(path => path === '/v1/compact' || path === '/v1/warm')
    expect(order).toEqual(['/v1/compact', '/v1/warm'])
  })

  for (const [name, options] of [
    ['service en panne', { compact: (): Reply => 'down' }],
    ['réponse illisible', { compact: (): Reply => ({ status: 200, text: 'oui' }) }],
    ['sans clé', { compact: YES, config: config(URL, 'mauvaise') }],
  ] as const) {
    test(`${name} : aucune compaction`, async ($, on) => {
      const w = world(on, { messages: [user('x')], ...options })
      await step($, 0, { turnId: 't1' })
      await complete($, 't1')
      await w.clock.settle()
      expect(w.compactions).toEqual([])
    })
  }

  test('le délai d’absence est celui que rend le service', async ($, on) => {
    const w = world(on, { messages: [user('x')], compact: () => ({ status: 200, body: { compact: true, after_s: 5 } }) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(4_000)
    expect(w.compactions).toEqual([])
    await w.clock.advance(1_000)
    expect(w.compactions).toEqual([{ instructions: COMPACT_INSTRUCTIONS }])
  })

  // Vu en vrai le 11/11/2026 (Claude Code 2.1.322) : dans le tchat d'Open Codex (mode SDK), aucune
  // compaction voulue par le service n'avait jamais lieu, le moteur refusant `$.session.compact`.
  // Le banc ne joue pas la commande /compact du moteur : moteur réduit à ce que `compactNow` appelle ;
  // la compaction réelle est vérifiée par l'essai `connector/e2e/run.sh compact`.
  function headless(run: (input: unknown) => Promise<unknown>): EngineInterface {
    const refused = async (): Promise<never> => {
      throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn')
    }
    return { session: { compact: refused }, command: { run }, clock: { sleep: async () => undefined } } as unknown as EngineInterface
  }

  test('session sans terminal : le moteur refuse, la compaction passe par la commande /compact', async () => {
    const ran: unknown[] = []
    const outcome = await compactNow(headless(async input => { ran.push(input); return {} }), () => true)
    expect(outcome).toBe('done')
    expect(ran).toEqual([{ command: 'compact', args: COMPACT_INSTRUCTIONS }])
  })

  test('session sans terminal, commande refusée elle aussi : issue « error », rien ne lève', async () => {
    const outcome = await compactNow(headless(async () => { throw new Error('past a host limit') }), () => true)
    expect(outcome).toBe('error')
  })

  test('issue remontée avec l’étape suivante du fil : faite, refusée, utilisateur revenu', async ($, on) => {
    const done = world(on, { messages: [user('x')], compact: YES })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await done.clock.settle()
    await done.clock.advance(240_000)
    await step($, 0, { turnId: 't2' })
    await step($, 1, { turnId: 't2' })
    await complete($, 't2')
    await done.clock.settle()
    const after = stepsOf(done.usages().at(-1)?.body ?? {})
    expect(after[0]).toMatchObject({ compact_try: 'done', compacted_from: 42_000 })
    expect(after[1]).not.toHaveProperty('compact_try')
  })

  test('issue remontée : compaction refusée par le moteur (tour en cours), dite au service', async ($, on) => {
    const w = world(on, { messages: [user('x')], compact: YES, compactRefused: 'a turn is running' })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(250_000)
    expect(w.compactions).toEqual([])
    await step($, 0, { turnId: 't2' })
    await complete($, 't2')
    await w.clock.settle()
    expect(stepsOf(w.usages().at(-1)?.body ?? {})[0]).toMatchObject({ compact_try: 'error' })
    expect(stepsOf(w.usages().at(-1)?.body ?? {})[0]).not.toHaveProperty('compacted_from')
  })

  test('issue remontée : l’utilisateur est revenu avant le délai', async ($, on) => {
    const w = world(on, { messages: [user('x')], compact: YES })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(100_000)
    await step($, 0, { turnId: 't2' })
    await complete($, 't2')
    await w.clock.settle()
    expect(stepsOf(w.usages().at(-1)?.body ?? {})[0]).toMatchObject({ compact_try: 'back' })
  })

  test('fin d’un sous-agent : rien', async ($, on) => {
    const w = world(on, { messages: [user('x')], compact: YES })
    await step($, 0, { turnId: 't1', agentId: 'agent-1' })
    await complete($, 't1', 'agent-1')
    await w.clock.settle()
    expect(w.compacts()).toEqual([])
  })
})

// Compteurs de tokens : remontés par lots vers /v1/usage, avec la session et
// un identifiant d'étape stable (renvoi sans double compte), jamais bloquants.
import { describe, expect, test } from 'claude-code/testing'
import { SESSION, URL, complete, end, messages, step, turn, user, world } from './support'
import type { Reply } from './support'

type Sent = Record<string, unknown>

function stepsOf(body: Sent): Sent[] {
  return body.steps as Sent[]
}

describe('remontée par lots', () => {
  test('un lot par tour, à la fin du tour, avec session et compteurs', async ($, on) => {
    const w = world(on, {
      messages: [user('x')], route: () => ({ status: 200, body: { model: 'sonnet', effort: 'low' } }),
      rateLimits: [{ kind: 'five_hour', percentUsed: 12.5 }, { kind: 'seven_day', percentUsed: 40 }],
    })
    await step($, 0, { turnId: 't1' })
    await step($, 1, { turnId: 't1' })
    await step($, 2, { turnId: 't1' })
    expect(w.usages()).toEqual([])
    await complete($, 't1')
    await w.clock.settle()
    expect(w.usages()).toHaveLength(1)
    const sent = w.usages()[0]
    expect(sent?.url).toBe(`${URL}/v1/usage`)
    const steps = stepsOf(sent?.body ?? {})
    expect(steps).toHaveLength(3)
    expect(steps[0]).toEqual({
      step_id: expect.stringMatching(/^[a-f0-9]{32}$/), session_id: SESSION, model: 'claude-sonnet-5-5', effort: 'low',
      input: 10, cache_read: 50_000, cache_write: 2_000, output: 800, quota_percent: 40,
    })
    expect(new Set(steps.map(s => s.step_id)).size).toBe(3)
  })

  test('sous-agent : ses étapes comptent, avec un identifiant distinct', async ($, on) => {
    const w = world(on, { messages: [user('x')] })
    await step($, 0, { turnId: 't1' })
    await step($, 0, { turnId: 't1', agentId: 'agent-1' })
    await complete($, 't1')
    await w.clock.settle()
    const steps = stepsOf(w.usages()[0]?.body ?? {})
    expect(steps).toHaveLength(2)
    expect(steps[0]?.step_id).not.toBe(steps[1]?.step_id)
  })

  test('lot plein : envoyé sans attendre la fin du tour', async ($, on) => {
    const w = world(on, { messages: [user('x')] })
    for (let index = 0; index < 50; index++) await step($, index, { turnId: 't1' })
    await w.clock.settle()
    expect(w.usages()).toHaveLength(1)
    expect(stepsOf(w.usages()[0]?.body ?? {})).toHaveLength(50)
  })

  test('fin de session : ce qui reste part', async ($, on) => {
    const w = world(on, { messages: [user('x')] })
    await step($, 0, { turnId: 't1' })
    await end($)
    expect(stepsOf(w.usages()[0]?.body ?? {})).toHaveLength(1)
  })

  test('sans configuration : rien à remonter', async ($, on) => {
    const w = world(on, { config: null, messages: [user('x')] })
    await turn($, 't1', 2)
    await end($)
    expect(w.sent).toEqual([])
  })

  test('étape sans compteurs (aucune réponse de l’API) : rien à remonter', async ($, on) => {
    const w = world(on, { messages: [user('x')], counted: false })
    await turn($, 't1', 2)
    await end($)
    expect(w.usages()).toEqual([])
  })
})

describe('renvoi et idempotence', () => {
  test('lot refusé (500 ou réseau) : renvoyé au tour suivant avec les mêmes identifiants', async ($, on) => {
    const replies: Reply[] = [{ status: 500 }, 'down', { status: 200, body: { recorded: 3, duplicates: 0, rejected: 0 } }]
    const w = world(on, { messages: [user('x')], usage: () => replies.shift() ?? { status: 200 } })
    await turn($, 't1', 2)
    await w.clock.settle()
    await turn($, 't2', 1)
    await w.clock.settle()
    await turn($, 't3', 1)
    await w.clock.settle()
    const ids = w.usages().map(u => stepsOf(u.body).map(s => s.step_id))
    expect(ids).toHaveLength(3)
    expect(ids[1]?.slice(0, 2)).toEqual(ids[0])
    expect(ids[2]?.slice(0, 3)).toEqual(ids[1])
    expect(ids[2]).toHaveLength(4)
    // Accepté : plus rien à renvoyer.
    await end($)
    expect(w.usages()).toHaveLength(3)
    expect(messages(w)).toEqual([])
  })

  test('même étape vue deux fois (reprise) : même identifiant', async ($, on) => {
    const w = world(on, { messages: [user('x')] })
    await step($, 0, { turnId: 't1' })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    const steps = stepsOf(w.usages()[0]?.body ?? {})
    expect(steps.map(s => s.step_id)).toEqual([steps[0]?.step_id])
  })

  for (const status of [401, 422]) {
    test(`lot refusé (${status}) : abandonné, sans message ni renvoi`, async ($, on) => {
      const w = world(on, { messages: [user('x')], usage: () => ({ status, body: { error: 'x' } }) })
      await turn($, 't1', 1)
      await w.clock.settle()
      await end($)
      expect(w.usages()).toHaveLength(1)
      expect(messages(w)).toEqual([])
    })
  }

  test('service muet : l’envoi abandonne sans bloquer le tour suivant', async ($, on) => {
    let silent = true
    const w = world(on, { messages: [user('x')], usage: () => (silent ? 'silent' : { status: 200, body: {} }) })
    await turn($, 't1', 1)
    await w.clock.advance(10_000)
    silent = false
    await turn($, 't2', 1)
    await w.clock.settle()
    expect(w.usages()).toHaveLength(2)
    expect(stepsOf(w.usages()[1]?.body ?? {})).toHaveLength(2)
  })
})

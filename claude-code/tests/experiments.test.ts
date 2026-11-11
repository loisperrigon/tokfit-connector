import { EXECUTION_SECTION } from '../hooks/thinking'
// Leviers coupés pour une session (mesure de leur gain) : le connecteur demande
// la liste une fois par session et n'applique pas ceux qu'elle cite.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { CORE_PROMPT, SESSION, complete, end, spawn, step, user, world } from './support'
import type { Options, Reply, World } from './support'

type Sent = Record<string, unknown>

const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] }
const LONG = Array.from({ length: 1_000 }, (_, n) => `ligne ${n}`).join('\n')
const FRENCH = [user('Peux-tu corriger le test qui échoue dans ce fichier ?')]

function cut(...levers: string[]): Options['levers'] {
  return (): Reply => ({ status: 200, body: { off: levers } })
}

async function sentSteps($: Engine, w: World): Promise<Sent[]> {
  await end($)
  await w.clock.settle()
  return w.usages().flatMap(sent => sent.body.steps as Sent[])
}

describe('leviers coupés pour la session', () => {
  test('une seule demande par session, avec son identifiant seulement', async ($, on) => {
    const w = world(on, { messages: FRENCH })
    await $.prompt.compose(COMPOSE)
    await step($, 0, { turnId: 't1' })
    await step($, 1, { turnId: 't1' })
    expect(w.leverCalls().map(sent => sent.body)).toEqual([{ session_id: SESSION }])
  })

  test('réflexion coupée : ni section ni lean_thinking', async ($, on) => {
    const w = world(on, { messages: FRENCH, levers: cut('thinking') })
    expect((await $.prompt.compose(COMPOSE)).sections).toEqual([...CORE_PROMPT, EXECUTION_SECTION])
    await step($, 0, { turnId: 't1' })
    expect((await sentSteps($, w))[0]?.lean_thinking).toBeUndefined()
  })

  test('sorties coupées : la sortie passe entière', async ($, on) => {
    const w = world(on, { messages: FRENCH, bash: () => ({ stdout: LONG }), levers: cut('output') })
    await step($, 0, { turnId: 't1' })
    const got = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect('result' in got && (got.result as { stdout: string }).stdout).toBe(LONG)
    expect(w.leverCalls()).toHaveLength(1)
  })

  test('compaction et relance coupées : ni demande de compaction ni de relance', async ($, on) => {
    const w = world(on, { messages: FRENCH, levers: cut('compaction', 'warm'), warm: () => ({ status: 200, body: { after_s: 10 } }) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(600_000)
    expect(w.compacts()).toEqual([])
    expect(w.warms()).toEqual([])
    expect(w.forks).toEqual([])
  })

  test('sous-agents groupés coupés : le second part sans attendre', async ($, on) => {
    let open = (): void => undefined
    const opened = new Promise<void>(resolve => { open = resolve })
    const w = world(on, { messages: FRENCH, holdAgent: () => opened, levers: cut('fanout') })
    for (const _ of [1, 2]) await spawn($, 'tâche', { type: 'Explore' })
    const runs = [step($, 0, { turnId: 'a1', agentId: 'agent-1' }), step($, 0, { turnId: 'a2', agentId: 'agent-2' })]
    // Sans attente, le second entre aussitôt, sans que l'horloge n'avance.
    await w.clock.settle()
    expect(w.steps.map(s => s.agentId)).toEqual(['agent-1', 'agent-2'])
    open()
    await Promise.all(runs)
  })

  for (const [name, reply] of [['service en panne', (): Reply => 'down'], ['réponse illisible', (): Reply => ({ status: 200, text: 'oups' })]] as const) {
    test(`${name} : tous les leviers restent actifs`, async ($, on) => {
      const w = world(on, { messages: FRENCH, levers: reply })
      expect((await $.prompt.compose(COMPOSE)).sections).toHaveLength(CORE_PROMPT.length + 2)
      await step($, 0, { turnId: 't1' })
      expect((await sentSteps($, w))[0]?.lean_thinking).toBe(true)
    })
  }
})

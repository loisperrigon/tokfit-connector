// Service en panne : les messages ne l'attendent pas plus d'une fois, et le bandeau dit « tokfit dégradé »
// tant que le routage échoue ; la première réponse referme la panne.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { step, user, world } from './support'
import type { Reply } from './support'
import { NAME } from '../hooks/service'
import { FIRST_WAIT_MS, MAX_WAIT_MS, failed, holding, outage } from '../hooks/outage'

const PROPS = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: {} }

async function band($: Engine): Promise<string | undefined> {
  const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const text = (await ui.find({ key: 'tokfit-health' }))?.text
  await ui.unmount()
  return text
}

describe('service muet', () => {
  test('un seul délai : les messages suivants partent sans attendre, la demande reprend après l’attente', async ($, on) => {
    let reply: Reply = 'silent'
    const w = world(on, { messages: [user('x')], route: () => reply })
    const first = step($, 0, { turnId: 't1' })
    await w.clock.advance(6_000)
    await first
    expect(w.routes()).toHaveLength(1)
    await step($, 0, { turnId: 't2' })  // part tout de suite : aucune avance d'horloge
    expect(w.routes()).toHaveLength(1)
    expect(w.steps[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(await band($)).toContain('dégradé')
    reply = { status: 200, body: { model: 'sonnet', effort: 'low' } }
    await w.clock.advance(FIRST_WAIT_MS)
    await step($, 0, { turnId: 't3' })
    expect(w.routes()).toHaveLength(2)
    expect(w.steps[2]).toMatchObject({ model: 'sonnet', effort: 'low' })
    expect(await band($)).toBeUndefined()
  })

  test('attente doublée à chaque délai, bornée à 5 min', () => {
    const o = outage()
    const waits: number[] = []
    for (let i = 0; i < 6; i++) { failed(o, 0, true); waits.push(o.wait) }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, MAX_WAIT_MS, MAX_WAIT_MS])
    expect(holding(o, MAX_WAIT_MS - 1)).toBe(true)
    expect(holding(o, MAX_WAIT_MS)).toBe(false)
  })
})

describe('coupure franche', () => {
  test('réseau coupé : chaque message redemande (rien à attendre), bandeau dégradé', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: () => 'down' })
    await step($, 0, { turnId: 't1' })
    await step($, 0, { turnId: 't2' })
    expect(w.routes()).toHaveLength(2)
    expect(await band($)).toContain('dégradé')
  })

  test('502 du relais frontal (service arrêté derrière) : dégradé ; 502 du service avec son erreur : non', async ($, on) => {
    let reply: Reply = { status: 502, text: '<html>Bad Gateway</html>' }
    const w = world(on, { messages: [user('x')], route: () => reply })
    await step($, 0, { turnId: 't1' })
    expect(await band($)).toContain('dégradé')
    reply = { status: 502, body: { error: 'Décision indisponible : réglage gardé.' } }
    await step($, 0, { turnId: 't2' })
    expect(w.routes()).toHaveLength(2)
    expect(await band($)).toBeUndefined()
  })
})

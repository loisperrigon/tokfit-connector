// Bandeau du gain au-dessus de la saisie (hooks/badge.ts, hooks/band.ts) : chiffres du bilan du service.
import { describe, expect, test } from 'claude-code/testing'
import { BADGE_EVERY_MS, DELTA_MS, FRAMES, FRAME_MS, badgeText, gainOf } from '../hooks/badge'
import { complete, step, user, world } from './support'

const BILAN = { saved_usd: 74.2, reference_cost: 161.3, saved_percent: 46, seconds_saved: 9540, saved_kind: 'estimated', text: 'x' }
const PROPS = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: {} }

describe('bandeau tokfit', () => {
  test('texte : argent économisé sur la référence, part et attente gagnée', () => {
    expect(badgeText(gainOf(JSON.stringify(BILAN))!)).toBe("≈ 74 $ économisés sur 161 $ · −46 % · 2 h 39 d'attente en moins")
    expect(badgeText(gainOf(JSON.stringify({ saved_usd: 0.4, reference_cost: 1.2, seconds_saved: 600 }))!)).toBe("≈ 0,40 $ économisés sur 1,20 $ · −33 % · 10 min d'attente en moins")
    // Mesuré face aux sessions témoins : sans « ≈ ».
    expect(badgeText(gainOf(JSON.stringify({ ...BILAN, saved_kind: 'measured' }))!)).toBe("74 $ économisés sur 161 $ · −46 % · 2 h 39 d'attente en moins")
    expect(gainOf(JSON.stringify({ saved_usd: null, reference_cost: 3 }))).toBeUndefined()
    expect(gainOf(JSON.stringify({ saved_usd: -2, reference_cost: 3 }))).toBeUndefined()
    expect(gainOf('<html>')).toBeUndefined()
  })

  test('après un tour : le montant monte puis se fixe sur le terminal, aucun bandeau du gain sur Desktop ; bilan lu une fois dans le délai', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: () => ({ status: 200, body: { model: 'sonnet', effort: 'low' } }),
                          bilan: () => ({ status: 200, body: BILAN }) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    const first = await $.ui.mount({ plugin: 'tokfit', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect((await first.find({ key: 'tokfit-band' }))?.text).toMatch(/^✦ tokfit {2}≈ 0,00 \$ économisés sur 161 \$/)
    await first.unmount()
    // Desktop : pas de bandeau du gain (il est dans la ligne d'état, test suivant).
    const desktop = await $.ui.mount({ plugin: 'tokfit', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
    expect(await desktop.find({ key: 'tokfit-band' })).toBeUndefined()
    await desktop.unmount()
    await w.clock.advance(FRAMES * FRAME_MS * 2)
    const ui = await $.ui.mount({ plugin: 'tokfit', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect((await ui.find({ key: 'tokfit-band' }))?.text).toBe("✦ tokfit  ≈ 74 $ économisés sur 161 $  ▰▰▰▰▰▱▱▱▱▱ −46 %  ·  ⏱ 2 h 39 d'attente en moins")
    await ui.unmount()
    await step($, 0, { turnId: 't2' })
    await complete($, 't2')
    await w.clock.settle()
    expect(w.sent.filter(s => s.url.endsWith('/v1/bilan'))).toHaveLength(1)
    // La ligne d'état garde la seule décision.
    expect(w.shown.filter(l => l.startsWith('ui.status')).at(-1)).toBe('ui.status sonnet · low')
  })

  test('Desktop : le gain monte dans la ligne d\'état, puis le gain du tour s\'y montre et s\'efface', async ($, on) => {
    let saved = 74.2
    const w = world(on, { surfaces: ['desktop'], messages: [user('x')], route: () => ({ status: 200, body: { model: 'sonnet', effort: 'low' } }),
                          bilan: () => ({ status: 200, body: { ...BILAN, saved_usd: saved } }) })
    const lines = (): string[] => w.shown.filter(l => l.startsWith('ui.status '))
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(FRAMES * FRAME_MS * 2)
    expect(lines().at(-1)).toBe('ui.status sonnet · low · ≈ 74 $ économisés · −46 %')
    // Le montant est monté par étapes, sans gain du tour au premier relevé.
    expect(lines().filter(l => /≈ \d+ \$ économisés/.test(l)).length).toBeGreaterThan(3)
    expect(lines().some(l => l.includes('+'))).toBe(false)
    saved = 80
    await w.clock.advance(BADGE_EVERY_MS)
    await step($, 0, { turnId: 't2' })
    await complete($, 't2')
    await w.clock.settle()
    expect(lines().at(-1)).toMatch(/^ui\.status sonnet · low · ≈ \d+ \$ économisés · −46 % · \+5,80 \$ [✦✧✶✷✸✹✺]$/)
    await w.clock.advance(FRAMES * FRAME_MS * 2)
    expect(lines().at(-1)).toBe('ui.status sonnet · low · ≈ 80 $ économisés · −46 % · +5,80 $ ↑')
    await w.clock.advance(DELTA_MS)
    expect(lines().at(-1)).toBe('ui.status sonnet · low · ≈ 80 $ économisés · −46 %')
    // Décision suivante : la ligne garde le gain.
    await step($, 0, { turnId: 't3' })
    expect(lines().at(-1)).toBe('ui.status sonnet · low · ≈ 80 $ économisés · −46 %')
  })

  test('bilan indisponible : pas de bandeau', async ($, on) => {
    const w = world(on, { messages: [user('x')], bilan: () => ({ status: 502 }) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    const ui = await $.ui.mount({ plugin: 'tokfit', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ key: 'tokfit-band' })).toBeUndefined()
    await ui.unmount()
  })
})

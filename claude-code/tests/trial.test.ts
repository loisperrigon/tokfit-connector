// Message de fin d'essai (hooks/trial.ts) : le texte du service, montré une fois à la personne
// comme ligne de la conversation, jamais au modèle ; aucun texte du connecteur.
import { describe, expect, test } from 'claude-code/testing'
import { complete, step, user, world } from './support'
import type { Reply } from './support'

function ended(notice: string | null): Reply {
  return { status: 402, body: { error: 'trial_ended', message: 'Message toujours présent', url: 'https://site.test/prix', notice } }
}

describe("fin d'essai", () => {
  test('402 avec notice : le texte du service montré une fois, tel quel, hors du prompt', async ($, on) => {
    const notice = 'Ton essai tokfit de 7 jours est terminé. Pour continuer : https://site.test/tableau?t=abc'
    const w = world(on, { messages: [user('x')], route: () => ended(notice), warm: () => ended(null), compact: () => ended(null) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await step($, 0, { turnId: 't2' })
    await complete($, 't2')
    await w.clock.settle()
    expect(w.shown.filter(line => line.includes('essai'))).toEqual([`ui.log ${notice}`])
    // Le modèle ne le reçoit pas : ni dans ses messages ni dans son prompt.
    expect(JSON.stringify(w.steps)).not.toContain('essai')
    // Le connecteur dit au service qu'il montre ce message.
    expect(w.routes()[0]?.headers).toMatchObject({ 'x-show-notice': '1' })
    // Réglage de l'utilisateur gardé.
    expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  })

  test('402 sans notice (déjà montrée pendant la période) : rien à l’écran', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: () => ended(null) })
    await step($, 0)
    expect(w.shown).toEqual([])
  })

  test('le même texte rendu deux fois (réponses simultanées) : montré une fois', async ($, on) => {
    const notice = 'Essai fini, texte rejoué 9f2c.'
    const w = world(on, { messages: [user('x')], route: () => ended(notice) })
    await step($, 0, { turnId: 't1' })
    await step($, 0, { turnId: 't2' })
    expect(w.shown.filter(line => line.includes('9f2c'))).toHaveLength(1)
  })

  test('séquences du terminal retirées, longueur bornée ; une autre erreur ne montre rien', async ($, on) => {
    const w = world(on, {
      messages: [user('x')], route: () => ended('\u001b[2Jfin 7d1e' + 'x'.repeat(5000)),
      usage: () => ({ status: 500, body: { notice: 'jamais montré' } }),
    })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    const [line] = w.shown.filter(text => text.includes('7d1e'))
    expect(line?.startsWith('ui.log [2Jfin 7d1e')).toBe(true)
    expect(line?.length).toBe('ui.log '.length + 2000)
    expect(JSON.stringify(w.shown)).not.toContain('jamais montré')
  })
})

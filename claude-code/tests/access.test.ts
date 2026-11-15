// Accès sans inscription, côté session (hooks/access.ts) : clé anonyme obtenue dès le démarrage,
// commande `/<NAME>` qui montre le lien du tableau de bord écrit par le service, jamais au modèle.
import { describe, expect, test } from 'claude-code/testing'
import { ANONYMOUS_KEY, URL, step, user, world } from './support'
import { NAME } from '../hooks/service'
import { STORE_ENTRY } from '../hooks/key'

const ADDRESS_ONLY = JSON.stringify({ url: URL })
const PRESENTATION = { isFullscreen: false, columns: 120 }

describe('démarrage et tableau de bord', () => {
  test('au démarrage : clé anonyme obtenue avant le premier message, commande enregistrée', async ($, on) => {
    const w = world(on, { config: ADDRESS_ONLY, messages: [user('x')] })
    await $.session.start({ cwd: '/projet', surface: null, isInteractive: false })
    await w.clock.settle()
    expect(w.anonymousCalls()).toHaveLength(1)
    expect(w.store[STORE_ENTRY]).toEqual({ url: URL, key: ANONYMOUS_KEY })
    expect(w.commands).toEqual([NAME])
    await step($, 0)
    expect(w.anonymousCalls()).toHaveLength(1)
  })

  test('commande : le texte du service en ligne de la conversation, aucune sortie pour le modèle', async ($, on) => {
    const text = 'Ton tableau de bord, lien valable 24 h : https://site.test/tableau?t=abc'
    const w = world(on, { config: ADDRESS_ONLY, dashboard: () => ({ status: 200, body: { url: 'https://site.test/tableau?t=abc', text } }) })
    const result = await $.command.run({ command: NAME, args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
    expect(result.text).toBeUndefined()
    expect(w.shown[0]).toBe(`ui.log ${text}`)
    expect(w.shown).toHaveLength(2)
    expect(w.shown[1]).toMatch(/^ui\.log Leviers de cette session :/)
    expect(w.sent.find(s => s.url.endsWith('/v1/dashboard/link'))?.headers).toMatchObject({ authorization: `Bearer ${ANONYMOUS_KEY}` })
  })

  test('commande, tableau de bord en erreur : aucun lien, l’état des leviers seul', async ($, on) => {
    const w = world(on, { config: ADDRESS_ONLY, dashboard: () => ({ status: 503, body: { error: 'Tableau de bord indisponible.' } }) })
    await $.command.run({ command: NAME, args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
    expect(w.shown).toHaveLength(1)
    expect(w.shown[0]).toMatch(/^ui\.log Leviers de cette session :/)
  })
})

// Essai sans inscription (hooks/key.ts) : sans clé configurée, une clé anonyme est demandée au
// service, rangée dans le magasin du plugin et jamais montrée ; une clé configurée passe avant.
import { describe, expect, test } from 'claude-code/testing'
import { ANONYMOUS_KEY, KEY, URL, complete, config, step, unconfigured, user, world } from './support'
import { KEY_TIMEOUT_MS, RETRY_MS, STORE_ENTRY } from '../hooks/key'
import { refusedKeyText } from '../hooks/trial'
import { NAME } from '../hooks/service'

const ADDRESS_ONLY = JSON.stringify({ url: URL })

describe('clé anonyme', () => {
  test('premier démarrage sans clé : clé demandée, rangée, utilisée, jamais montrée', async ($, on) => {
    const w = world(on, { config: ADDRESS_ONLY, messages: [user('bonjour')] })
    await step($, 0, { turnId: 't1' })
    await step($, 1, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    // Une seule demande, sans corps ni identité.
    expect(w.anonymousCalls()).toHaveLength(1)
    expect(w.anonymousCalls()[0]?.headers).not.toHaveProperty('authorization')
    expect(w.anonymousCalls()[0]?.body).toEqual({})
    expect(w.store[STORE_ENTRY]).toEqual({ url: URL, key: ANONYMOUS_KEY })
    expect(w.routes()[0]?.headers).toMatchObject({ authorization: `Bearer ${ANONYMOUS_KEY}` })
    // Écrite seulement dans le magasin du plugin ; ni affichée ni journalisée.
    expect(w.written).toHaveLength(1)
    expect(w.written[0]?.startsWith('store.set ')).toBe(true)
    expect(JSON.stringify(w.shown)).not.toContain(ANONYMOUS_KEY)
  })

  test('clé déjà rangée pour ce service : aucune demande', async ($, on) => {
    const w = world(on, { config: ADDRESS_ONLY, messages: [user('x')], store: { [STORE_ENTRY]: { url: URL, key: ANONYMOUS_KEY } } })
    await step($, 0)
    expect(w.anonymousCalls()).toEqual([])
    expect(w.routes()[0]?.headers).toMatchObject({ authorization: `Bearer ${ANONYMOUS_KEY}` })
    expect(w.written).toEqual([])
  })

  test('clé rangée pour un autre service : jamais envoyée ici, une clé est demandée', async ($, on) => {
    const other = 'ek_' + 'o'.repeat(43)
    const w = world(on, { config: ADDRESS_ONLY, messages: [user('x')], store: { [STORE_ENTRY]: { url: 'https://autre.test', key: other } } })
    await step($, 0)
    expect(w.anonymousCalls()).toHaveLength(1)
    expect(JSON.stringify(w.sent)).not.toContain(other)
  })

  test('clé dans le fichier de configuration : prioritaire, rien demandé ni écrit', async ($, on) => {
    const w = world(on, { config: config(URL, KEY), messages: [user('x')] })
    await step($, 0)
    expect(w.anonymousCalls()).toEqual([])
    expect(w.routes()[0]?.headers).toMatchObject({ authorization: `Bearer ${KEY}` })
    expect(w.written).toEqual([])
  })

  test('clé dans la configuration du plugin : prioritaire, même sur une clé rangée',
       { options: { api_key: KEY, service_url: URL } }, async ($, on) => {
    const w = world(on, { config: null, messages: [user('x')], store: { [STORE_ENTRY]: { url: URL, key: ANONYMOUS_KEY } } })
    await step($, 0)
    expect(w.anonymousCalls()).toEqual([])
    expect(w.routes()[0]?.headers).toMatchObject({ authorization: `Bearer ${KEY}` })
  })

  test('clé configurée refusée (401) : clé anonyme à la place, dite une fois, rien d\'autre d\'écrit',
       { options: { api_key: KEY, service_url: URL } }, async ($, on) => {
    const w = world(on, { config: null, messages: [user('x')], refusedKeys: [KEY] })
    await $.session.start({ cwd: '/projet', surface: null, isInteractive: false })
    await w.clock.settle()
    await step($, 0, { turnId: 't1' })
    await step($, 0, { turnId: 't2' })
    expect(w.sent.filter(s => s.url.endsWith('/v1/bilan')).map(s => s.headers)).toEqual([
      expect.objectContaining({ authorization: `Bearer ${KEY}` }),
      expect.objectContaining({ authorization: `Bearer ${ANONYMOUS_KEY}` }),
    ])
    expect(w.anonymousCalls()).toHaveLength(1)
    expect(w.routes().map(r => r.headers)).toEqual([
      expect.objectContaining({ authorization: `Bearer ${ANONYMOUS_KEY}` }),
      expect.objectContaining({ authorization: `Bearer ${ANONYMOUS_KEY}` }),
    ])
    expect(w.store[STORE_ENTRY]).toEqual({ url: URL, key: ANONYMOUS_KEY })
    expect(w.shown.filter(line => line.includes('refusée'))).toEqual([`ui.log ${refusedKeyText(NAME)}`])
    expect(JSON.stringify(w.shown)).not.toContain(KEY)
  })

  test('clé configurée refusée dans le fichier aussi : la clé anonyme passe après les deux',
       { options: { api_key: KEY, service_url: URL } }, async ($, on) => {
    const second = 'ek_' + 's'.repeat(43)
    const w = world(on, { config: config(URL, second), messages: [user('x')], refusedKeys: [KEY, second] })
    await $.session.start({ cwd: '/projet', surface: null, isInteractive: false })
    await w.clock.settle()
    await step($, 0)
    expect(w.sent.filter(s => s.url.endsWith('/v1/bilan')).map(s => s.headers.authorization))
      .toEqual([`Bearer ${KEY}`, `Bearer ${second}`, `Bearer ${ANONYMOUS_KEY}`])
    expect(w.routes()[0]?.headers).toMatchObject({ authorization: `Bearer ${ANONYMOUS_KEY}` })
  })

  test('sans adresse configurée : connecteur inerte, ou adresse officielle seule (copie publique)', async ($, on) => {
    const w = world(on, { config: null, messages: [user('x')] })
    await step($, 0)
    await unconfigured(w.sent, () => {})
  })

  test('refus du service (limite) : leviers inactifs en silence, nouvelle demande après le délai', async ($, on) => {
    let answer: { status: number; body?: unknown } = { status: 429, body: { error: 'Trop de clés demandées depuis cette adresse.' } }
    const w = world(on, { config: ADDRESS_ONLY, messages: [user('x')], anonymous: () => answer })
    await step($, 0, { turnId: 't1' })
    await step($, 0, { turnId: 't2' })
    expect(w.anonymousCalls()).toHaveLength(1)
    expect(w.routes()).toEqual([])
    expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.shown).toEqual([])
    expect(w.written).toEqual([])
    answer = { status: 201, body: { key: ANONYMOUS_KEY } }
    await w.clock.advance(RETRY_MS)
    await step($, 0, { turnId: 't3' })
    expect(w.anonymousCalls()).toHaveLength(2)
    expect(w.routes()).toHaveLength(1)
  })

  test('service muet : attente bornée, puis le message part sur son réglage', async ($, on) => {
    const w = world(on, { config: ADDRESS_ONLY, messages: [user('x')], anonymous: () => 'silent' })
    const pending = step($, 0)
    await w.clock.advance(KEY_TIMEOUT_MS - 100)
    expect(w.steps).toEqual([])
    await w.clock.advance(100)
    await pending
    expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.shown).toEqual([])
  })

  test('réponse sans clé valable : rien rangé, rien envoyé avec', async ($, on) => {
    const w = world(on, { config: ADDRESS_ONLY, messages: [user('x')], anonymous: () => ({ status: 201, body: { key: 'pas-une-cle' } }) })
    await step($, 0)
    expect(w.routes()).toEqual([])
    expect(w.store).toEqual({})
  })
})

// Décision par message : le connecteur envoie des faits, applique
// { model, effort } et garde le réglage en cours sur toute erreur, lenteur ou
// clé refusée, sans rien montrer.
import { describe, expect, test } from 'claude-code/testing'
import { KEY, SESSION, URL, assistant, config, step, user, world } from './support'
import type { Reply } from './support'
import { DEFAULT_URL } from '../hooks/service'

const OTHER = 'ek_' + 'z'.repeat(43)

describe('configuration', () => {
  test('sans fichier de configuration : aucun appel, réglage inchangé', async ($, on) => {
    const w = world(on, { config: null, messages: [user('bonjour')] })
    await step($, 0)
    expect(w.sent).toEqual([])
    expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.shown).toEqual([])
  })

  test('clé et adresse lues dans le fichier hors dépôt', async ($, on) => {
    const w = world(on, { messages: [user('bonjour')] })
    await step($, 0)
    expect(w.routes()).toHaveLength(1)
    expect(w.routes()[0]?.url).toBe(`${URL}/v1/route`)
    expect(w.routes()[0]?.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'content-type': 'application/json' })
  })

  test('clé dans la configuration du plugin (trousseau, --config api_key=…) : pas besoin de fichier',
       { options: { api_key: KEY, service_url: URL } }, async ($, on) => {
    const w = world(on, { config: null, messages: [user('x')] })
    await step($, 0)
    expect(w.routes()).toHaveLength(1)
    expect(w.routes()[0]?.url).toBe(`${URL}/v1/route`)
    expect(w.routes()[0]?.headers).toMatchObject({ authorization: `Bearer ${KEY}` })
  })

  test('configuration du plugin prioritaire sur le fichier, champ par champ', { options: { api_key: OTHER } }, async ($, on) => {
    const w = world(on, { config: config('https://fichier.test', KEY), messages: [user('x')] })
    await step($, 0)
    expect(w.routes()[0]?.url).toBe('https://fichier.test/v1/route')
    expect(w.routes()[0]?.headers).toMatchObject({ authorization: `Bearer ${OTHER}` })
  })

  test('clé du plugin sans adresse nulle part : adresse officielle', { options: { api_key: KEY } }, async ($, on) => {
    const w = world(on, { config: null, messages: [user('x')] })
    await step($, 0)
    expect(w.sent.map(request => request.url)).toEqual([`${DEFAULT_URL}/v1/route`])
  })

  test('fichier sans adresse : adresse officielle', async ($, on) => {
    const w = world(on, { config: JSON.stringify({ key: KEY }), messages: [user('x')] })
    await step($, 0)
    expect(w.sent.map(request => request.url)).toEqual([`${DEFAULT_URL}/v1/route`])
  })

  test('TOKFIT_CONFIG désigne un autre fichier', async ($, on) => {
    const w = world(on, { configPath: '/tmp/essai.json', env: { TOKFIT_CONFIG: '/tmp/essai.json' }, messages: [user('x')] })
    await step($, 0)
    expect(w.routes()).toHaveLength(1)
  })

  const refused: [string, string][] = [
    ['JSON illisible', '{'], ['pas un objet', '[]'], ['clé mal formée', config(URL, 'pas-une-cle')],
    ['adresse en clair hors machine', config('http://service.test', KEY)], ['autre protocole', config('ftp://x', KEY)],
  ]
  for (const [name, text] of refused) {
    test(`${name} : rien ne part, rien d’affiché`, async ($, on) => {
      const w = world(on, { config: text, messages: [user('x')] })
      await step($, 0)
      expect(w.sent).toEqual([])
      expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
      expect(w.shown).toEqual([])
    })
  }

  test('adresse locale en http acceptée (essais sur la machine)', async ($, on) => {
    const w = world(on, { config: config('http://127.0.0.1:8790/', KEY), messages: [user('x')] })
    await step($, 0)
    expect(w.routes()[0]?.url).toBe('http://127.0.0.1:8790/v1/route')
  })
})

describe('décision appliquée', () => {
  test('modèle et réflexion du service sur toutes les étapes du tour, modèle gardé au tour suivant', async ($, on) => {
    let answer: Reply = { status: 200, body: { model: 'sonnet', effort: 'low' } }
    const w = world(on, { messages: [user('renomme cette variable')], route: () => answer })
    await step($, 0, { turnId: 't1' })
    await step($, 1, { turnId: 't1' })
    expect(w.steps.map(s => [s.model, s.effort])).toEqual([['sonnet', 'low'], ['sonnet', 'low']])
    expect(w.routes()).toHaveLength(1)
    // Tour suivant : nouvelle demande ; sans avis sur le modèle, celui choisi reste.
    answer = { status: 200, body: { model: null, effort: 'medium' } }
    await step($, 0, { turnId: 't2' })
    expect(w.routes()).toHaveLength(2)
    expect(w.routes()[1]?.body.model).toBe('sonnet')
    expect(w.steps[2]).toMatchObject({ model: 'sonnet', effort: 'medium' })
  })

  test('fin d\'un sous-agent en arrière-plan : pas une demande de l\'utilisateur, réglage du tour gardé', async ($, on) => {
    const msgs = [user('lance la revue en arrière-plan')]
    const w = world(on, { messages: msgs, route: () => ({ status: 200, body: { model: 'sonnet', effort: 'low' } }) })
    await step($, 0, { turnId: 't1' })
    msgs.push(assistant('lancé'), user('<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>'))
    await step($, 0, { turnId: 't2' })
    expect(w.routes()).toHaveLength(1)
    expect(w.steps[1]).toMatchObject({ model: 'sonnet', effort: 'low' })
    // Le message suivant de l'utilisateur est routé, sans la notification dans ses échanges précédents.
    msgs.push(assistant('fini'), user('merci, corrige le premier point'))
    await step($, 0, { turnId: 't3' })
    expect(w.routes()).toHaveLength(2)
    expect(JSON.stringify(w.routes()[1]?.body)).not.toContain('task-notification')
  })

  test('identifiant complet de modèle rendu par le service : appliqué tel quel', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: () => ({ status: 200, body: { model: 'claude-sonnet-5-5', effort: 'low' } }) })
    await step($, 0)
    expect(w.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' })
  })

  test('réponse sans avis : réglage inchangé', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: () => ({ status: 200, body: { model: null, effort: null } }) })
    await step($, 0)
    expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  })

  test('la décision se voit sur la ligne d’état, sans dire comment elle est prise', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: () => ({ status: 200, body: { model: 'sonnet', effort: 'low' } }) })
    await step($, 0)
    expect(w.shown).toHaveLength(1)
    expect(w.shown[0]).toContain('sonnet · low')
    expect(w.shown[0]).not.toMatch(/raison|probabilit|%/i)
  })
})

describe('repli sur le réglage en cours', () => {
  const failures: [string, Reply][] = [
    ['clé refusée (401)', { status: 401, body: { error: 'Clé absente, inconnue ou révoquée.' } }],
    ['trop de requêtes (429)', { status: 429, body: { error: 'Trop de requêtes.' } }],
    ['service en erreur (502)', { status: 502, body: { error: 'Décision indisponible : réglage gardé.' } }],
    ['service non configuré (503)', { status: 503, body: { error: 'x' } }],
    ['décision trop lente (504)', { status: 504, body: { error: 'x' } }],
    ['réponse illisible', { status: 200, text: '<html>' }],
    ['valeurs inconnues', { status: 200, body: { model: 'gpt-9', effort: 'énorme' } }],
    ['réseau coupé', 'down'],
  ]
  for (const [name, reply] of failures) {
    test(`${name} : message parti tel quel, rien d’affiché`, async ($, on) => {
      const w = world(on, { messages: [user('x')], route: () => reply })
      await step($, 0)
      expect(w.routes()).toHaveLength(1)
      expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
      expect(w.shown).toEqual([])
    })
  }

  test('après une décision, un échec efface la ligne d’état sans message', async ($, on) => {
    let reply: Reply = { status: 200, body: { model: 'sonnet', effort: 'low' } }
    const w = world(on, { messages: [user('x')], route: () => reply })
    await step($, 0, { turnId: 't1' })
    reply = { status: 401, body: { error: 'Clé absente, inconnue ou révoquée.' } }
    w.shown.length = 0
    await step($, 0, { turnId: 't2' })
    expect(w.shown).toEqual([])
    // Le modèle choisi avant reste (pas de réécriture du cache), l'effort revient au réglage.
    expect(w.steps[1]).toMatchObject({ model: 'sonnet', effort: 'high' })
  })

  test('service muet : abandon à 6 s, le message part avec le réglage en cours', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: () => 'silent' })
    const pending = step($, 0)
    await w.clock.advance(5_900)
    expect(w.steps).toEqual([])
    await w.clock.advance(100)
    await pending
    expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.shown).toEqual([])
  })
})

describe('faits envoyés', () => {
  test('message borné, échanges précédents, session, réglage en cours', async ($, on) => {
    const long = 'a'.repeat(10_000) + 'FIN'
    const w = world(on, {
      messages: [user('premier'), assistant('réponse un'), user('deuxième'), assistant('réponse deux'), user(long)],
      rateLimits: [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 40 }],
    })
    await step($, 0)
    const facts = w.routes()[0]?.body ?? {}
    expect(facts).toMatchObject({
      kind: 'main', session_id: SESSION, model: 'claude-opus-5-5', effort: 'high', conversation_tokens: 42_000,
      previous_exchanges: ['premier', 'deuxième'], last_assistant_message: 'réponse deux',
      keep_model: false, keep_effort: false, cache_cold: false, images_attached: false,
      rate_limits: [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 40 }],
    })
    const message = String(facts.message)
    expect(message.length).toBeLessThan(5_000)
    expect(message.endsWith('FIN')).toBe(true)
    // Le corps reste loin du plafond du service (64 Ko).
    expect(JSON.stringify(facts).length).toBeLessThan(20_000)
  })

  test('balise de l’utilisateur : son choix passe avant le service, même en panne', async ($, on) => {
    const w = world(on, { messages: [user('[opus] [max] refonte complète')], route: () => 'down' })
    await step($, 0, { model: 'claude-sonnet-5-5', effort: 'low' })
    expect(w.routes()[0]?.body).toMatchObject({ keep_model: true, keep_effort: true, model: 'opus' })
    expect(w.steps[0]).toMatchObject({ model: 'opus', effort: 'max' })
  })

  test('balise de réflexion seule : le service ne choisit que le modèle', async ($, on) => {
    const w = world(on, { messages: [user('[low] petite question')], route: () => ({ status: 200, body: { model: 'haiku', effort: null } }) })
    await step($, 0)
    expect(w.routes()[0]?.body).toMatchObject({ keep_model: false, keep_effort: true })
    expect(w.steps[0]).toMatchObject({ model: 'haiku', effort: 'low' })
  })

  test('compaction : le cache de la conversation est froid jusqu’à la réponse suivante', async ($, on) => {
    const w = world(on, { messages: [user('x')] })
    await step($, 0, { turnId: 't1' })
    await $.session.compact({ trigger: 'manual', messages: [user('résumé')] })
    await step($, 0, { turnId: 't2' })
    await step($, 0, { turnId: 't3' })
    expect(w.routes().map(r => r.body.cache_cold)).toEqual([false, true, false])
    expect(w.routes()[2]?.body.model_cache).toMatchObject({ opus: { idle_s: 0 } })
  })
})

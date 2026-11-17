// Décision par message : le connecteur envoie des faits, applique
// { model, effort } et garde le réglage en cours sur toute erreur, lenteur ou
// clé refusée, sans rien montrer.
import { describe, expect, test } from 'claude-code/testing'
import { KEY, SESSION, URL, aborted, assistant, complete, config, messages, step, submit, unconfigured, user, world } from './support'
import type { Options, Reply } from './support'
import { DEFAULT_URL } from '../hooks/service'

const OTHER = 'ek_' + 'z'.repeat(43)

describe('configuration', () => {
  test('sans fichier de configuration : aucun appel, réglage inchangé (adresse officielle seule en copie publique)', async ($, on) => {
    const w = world(on, { config: null, messages: [user('bonjour')] })
    await step($, 0)
    await unconfigured(w.sent, () => {
      expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
      expect(w.shown).toEqual([])
    })
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

  // Adresse officielle : vide dans le dépôt de travail, posée dans la copie
  // publique (connector/publish.py). Les deux copies passent ces essais.
  const official = (sent: { url: string }[]) =>
    DEFAULT_URL ? expect(sent.map((call) => call.url)).toContain(`${DEFAULT_URL}/v1/route`) : expect(sent).toEqual([])

  test('clé du plugin sans adresse nulle part : adresse officielle, sinon rien ne part', { options: { api_key: KEY } }, async ($, on) => {
    const w = world(on, { config: null, messages: [user('x')] })
    await step($, 0)
    official(w.sent)
  })

  test('adresse absente du fichier : adresse officielle, sinon rien ne part', async ($, on) => {
    const w = world(on, { config: JSON.stringify({ key: KEY }), messages: [user('x')] })
    await step($, 0)
    official(w.sent)
    if (!DEFAULT_URL) expect(w.shown).toEqual([])
  })

  test('TOKFIT_CONFIG désigne un autre fichier', async ($, on) => {
    const w = world(on, { configPath: '/tmp/essai.json', env: { TOKFIT_CONFIG: '/tmp/essai.json' }, messages: [user('x')] })
    await step($, 0)
    expect(w.routes()).toHaveLength(1)
  })

  // Fichier illisible : traité comme absent (copie publique : clé d'essai à l'adresse officielle).
  const unreadable: [string, string][] = [['JSON illisible', '{'], ['pas un objet', '[]']]
  for (const [name, text] of unreadable) {
    test(`${name} : comme sans fichier`, async ($, on) => {
      const w = world(on, { config: text, messages: [user('x')] })
      await step($, 0)
      await unconfigured(w.sent, () => {
        expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
        expect(w.shown).toEqual([])
      })
    })
  }

  const refused: [string, string][] = [
    ['clé mal formée', config(URL, 'pas-une-cle')],
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

  test('message tapé pendant le travail : le tour qui le reprend garde modèle et réflexion', async ($, on) => {
    const msgs = [user('refais tout le module et teste chaque fonction')]
    let answer: Reply = { status: 200, body: { model: 'opus', effort: 'high' } }
    const w = world(on, { messages: msgs, route: () => answer })
    await step($, 0, { turnId: 't1' })
    await step($, 1, { turnId: 't1' })
    // Claude Code interrompt l'étape, puis relance le travail avec ce seul message.
    answer = { status: 200, body: { model: 'haiku', effort: 'low' } }
    await submit($, 'pense aussi aux tests', 't1')
    await aborted($, 't1')
    await submit($, 'pense aussi aux tests')
    msgs.push(assistant(''), user('pense aussi aux tests'))
    await step($, 0, { turnId: 't2' })
    await step($, 1, { turnId: 't2' })
    expect(w.routes()).toHaveLength(1)
    expect(w.steps.slice(2).map(s => [s.model, s.effort])).toEqual([['claude-opus-5-5', 'high'], ['claude-opus-5-5', 'high']])
    // Fin normale du travail : le message suivant est une nouvelle demande.
    await complete($, 't2')
    msgs.push(assistant('fini'), user('merci, résume'))
    await submit($, 'merci, résume')
    await step($, 0, { turnId: 't3' })
    expect(w.routes()).toHaveLength(2)
    expect(w.steps[4]).toMatchObject({ model: 'haiku', effort: 'low' })
  })

  test('message tapé pendant un tour fini sans interruption : routé au tour suivant', async ($, on) => {
    const msgs = [user('lance les tests')]
    const w = world(on, { messages: msgs, route: () => ({ status: 200, body: { model: 'sonnet', effort: 'medium' } }) })
    await step($, 0, { turnId: 't1' })
    // Lu dans le tour en cours (outil passé en arrière-plan) : le tour finit normalement.
    await submit($, 'et ensuite le lint', 't1')
    await complete($, 't1')
    msgs.push(assistant('fait'), user('et ensuite le lint'))
    await step($, 0, { turnId: 't2' })
    expect(w.routes()).toHaveLength(2)
  })

  test('arrêt puis nouvelle demande tapée à l\'arrêt : routée', async ($, on) => {
    const msgs = [user('refais tout')]
    const w = world(on, { messages: msgs, route: () => ({ status: 200, body: { model: 'opus', effort: 'high' } }) })
    await step($, 0, { turnId: 't1' })
    await aborted($, 't1')
    msgs.push(assistant(''), user('autre chose : renomme x'))
    await submit($, 'autre chose : renomme x')
    await step($, 0, { turnId: 't2' })
    expect(w.routes()).toHaveLength(2)
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
    expect(w.shown[0]).toBe('ui.status sonnet · low')
    expect(w.shown[0]).not.toMatch(/jev|openrouter|%/i)
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

  // Cas réel du 03/11 : « arrête-toi après ce travail, fais bien les journaux »,
  // seul, ressemblait à une tâche légère ; le service doit savoir qu'un long
  // travail est en cours et que des sous-agents vont encore rendre leurs résultats.
  test('travail en cours : sous-agents actifs du fil et étapes depuis le dernier message', async ($, on) => {
    const w = world(on, {
      messages: [user('migre tout le module')],
      roster: [
        { id: 'a1', status: 'running' }, { id: 'a2', status: 'waiting' }, { id: 'a3', status: 'completed' },
        { id: 'a4', status: 'idle' }, { id: 'a5', status: 'running', parentId: 'a1' },
      ],
    })
    await step($, 0, { turnId: 't1' })
    for (let index = 1; index < 5; index++) await step($, index, { turnId: 't1' })
    await complete($, 't1')
    await step($, 0, { turnId: 't2' })
    expect(w.routes()[0]?.body).toMatchObject({ agents_running: 2, steps_since_last_message: 0 })
    // Le premier pas du tour suivant ne compte pas : seules les 5 étapes du tour précédent.
    expect(w.routes()[1]?.body).toMatchObject({ agents_running: 2, steps_since_last_message: 5 })
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

  // Claude Code passe le tour d'un message contenant `ultrathink` en xhigh (2.1.311).
  test('ultrathink : la réflexion du message reste au moteur, le service ne choisit que le modèle', async ($, on) => {
    const w = world(on, { messages: [user('ultrathink : pourquoi ce test échoue ?')], route: () => ({ status: 200, body: { model: 'sonnet', effort: 'low' } }) })
    await step($, 0, { effort: 'xhigh' })
    expect(w.routes()[0]?.body).toMatchObject({ keep_model: false, keep_effort: true })
    expect(w.steps[0]).toMatchObject({ model: 'sonnet', effort: 'xhigh' })
  })

  for (const value of ['1', 'true']) {
    test(`CLAUDE_CODE_DISABLE_ULTRATHINK=${value} : le mot n’a plus d’effet, le service choisit aussi la réflexion`, async ($, on) => {
      const w = world(on, { messages: [user('ultrathink : pourquoi ce test échoue ?')], env: { CLAUDE_CODE_DISABLE_ULTRATHINK: value },
        route: () => ({ status: 200, body: { model: 'sonnet', effort: 'low' } }) })
      await step($, 0)
      expect(w.routes()[0]?.body).toMatchObject({ keep_model: false, keep_effort: false })
      expect(w.steps[0]).toMatchObject({ model: 'sonnet', effort: 'low' })
    })
  }

  test('CLAUDE_CODE_DISABLE_ULTRATHINK=0 : ultrathink garde son effet', async ($, on) => {
    const w = world(on, { messages: [user('ultrathink')], env: { CLAUDE_CODE_DISABLE_ULTRATHINK: '0' } })
    await step($, 0)
    expect(w.routes()[0]?.body).toMatchObject({ keep_effort: true })
  })

  // Effort réglé par l'utilisateur (variable d'environnement, réglage) : plancher, jamais un défaut du modèle.
  describe('effort réglé par l’utilisateur', () => {
    const down: () => Reply = () => ({ status: 200, body: { model: 'sonnet', effort: 'low' } })

    test('CLAUDE_CODE_EFFORT_LEVEL : transmis au service, jamais abaissé', async ($, on) => {
      const w = world(on, { messages: [user('petite question')], env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' }, route: down })
      await step($, 0)
      expect(w.routes()[0]?.body).toMatchObject({ min_effort: 'high', keep_effort: false })
      expect(w.steps[0]).toMatchObject({ model: 'sonnet', effort: 'high' })
    })

    test('le service peut proposer plus haut', async ($, on) => {
      const w = world(on, { messages: [user('refonte')], env: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' },
        route: () => ({ status: 200, body: { model: null, effort: 'xhigh' } }) })
      await step($, 0)
      expect(w.steps[0]).toMatchObject({ effort: 'xhigh' })
    })

    test('service sans avis et effort en cours sous le plancher : le plancher', async ($, on) => {
      const w = world(on, { messages: [user('x')], env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' },
        route: () => ({ status: 200, body: { model: null, effort: null } }) })
      await step($, 0, { effort: 'medium' })
      expect(w.steps[0]).toMatchObject({ effort: 'high' })
    })

    test('service sans avis et effort en cours au-dessus du plancher : rien ne change', async ($, on) => {
      const w = world(on, { messages: [user('x')], env: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' },
        route: () => ({ status: 200, body: { model: null, effort: null } }) })
      await step($, 0, { effort: 'xhigh' })
      expect(w.steps[0]).toMatchObject({ effort: 'xhigh' })
    })

    test('réglage effortLevel quand la variable manque', async ($, on) => {
      const w = world(on, { messages: [user('x')], settings: { effortLevel: 'medium' }, route: () => ({ status: 200, body: { model: null, effort: 'low' } }) })
      await step($, 0)
      expect(w.routes()[0]?.body).toMatchObject({ min_effort: 'medium' })
      expect(w.steps[0]).toMatchObject({ effort: 'medium' })
    })

    test('la variable passe devant le réglage : auto ou unset, aucun plancher', async ($, on) => {
      const w = world(on, { messages: [user('x')], env: { CLAUDE_CODE_EFFORT_LEVEL: 'auto' }, settings: { effortLevel: 'medium' },
        route: () => ({ status: 200, body: { model: null, effort: 'low' } }) })
      await step($, 0)
      expect(w.routes()[0]?.body).not.toHaveProperty('min_effort')
      expect(w.steps[0]).toMatchObject({ effort: 'low' })
    })

    // Résolu comme le moteur : l'entrée du modèle de la session dans `modelSettings` (où `/effort`
    // range son choix) d'abord, couche par couche ; l'`effortLevel` d'une couche plus forte que
    // celle de l'utilisateur (choix de réflexion d'une application) passe devant son entrée.
    const resolved: [string, Partial<Options>, string | undefined][] = [
      ['entrée du modèle de la session : passe devant effortLevel', { settings: { effortLevel: 'xhigh',
        modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' }, 'claude-sonnet-5-5': { effortLevel: 'low' } } } }, 'high'],
      ['clé sans suffixe de fenêtre ni casse', { settings: { modelSettings: { 'Claude-Opus-5-5': { effortLevel: 'Medium' } } } }, 'medium'],
      ['entrée d’un autre modèle seulement : effortLevel', { settings: { effortLevel: 'medium',
        modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'low' } } } }, 'medium'],
      ['entrée illisible : effortLevel', { settings: { effortLevel: 'medium', modelSettings: { 'claude-opus-5-5': { effortLevel: 42 } } } }, 'medium'],
      ['effortLevel d’une couche plus forte : passe devant l’entrée de l’utilisateur', { layers: {
        user: { modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } }, flag: { effortLevel: 'xhigh' } } }, 'xhigh'],
      ['entrée d’une couche plus forte : passe devant', { layers: {
        user: { modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }, local: { modelSettings: { 'claude-opus-5-5': { effortLevel: 'low' } } } } }, 'low'],
      ['effortLevel de l’utilisateur après les entrées des autres couches', { layers: {
        user: { effortLevel: 'xhigh' }, project: { modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } } } }, 'medium'],
      ['moteur sans lecture par couche : sa fusion', { noLayers: true, settings: { effortLevel: 'xhigh',
        modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } } }, 'high'],
    ]
    for (const [name, options, floor] of resolved) {
      test(name, async ($, on) => {
        const w = world(on, { messages: [user('x')], ...options, route: () => ({ status: 200, body: { model: null, effort: null } }) })
        await step($, 0, { model: 'claude-opus-5-5[1m]', effort: 'low' })
        expect(w.routes()[0]?.body).toMatchObject({ min_effort: floor })
      })
    }

    const unusable: Record<string, string>[] = [{}, { CLAUDE_CODE_EFFORT_LEVEL: 'énorme' }]
    for (const env of unusable) {
      test(`aucun réglage valide (${JSON.stringify(env)}) : pas de plancher, le service décide`, async ($, on) => {
        const w = world(on, { messages: [user('x')], env, settings: { effortLevel: 42 }, route: down })
        await step($, 0)
        expect(w.routes()[0]?.body).not.toHaveProperty('min_effort')
        expect(w.steps[0]).toMatchObject({ effort: 'low' })
      })
    }

    test('balise du message : choix plus précis, elle passe devant le plancher', async ($, on) => {
      const w = world(on, { messages: [user('[low] petite question')], env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' }, route: down })
      await step($, 0)
      expect(w.steps[0]).toMatchObject({ effort: 'low' })
    })

    test('limite du compte : ce que le service impose passe devant le plancher', async ($, on) => {
      const notice = 'La réflexion high est bloquée sur ce compte : medium à la place.'
      const w = world(on, { messages: [user('x')], env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' },
        route: () => ({ status: 200, body: { model: null, effort: 'medium', notice } }) })
      await step($, 0)
      expect(w.steps[0]).toMatchObject({ effort: 'medium' })
    })

    test('service en panne : le réglage de l’utilisateur reste', async ($, on) => {
      const w = world(on, { messages: [user('x')], env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' }, route: () => 'down' })
      await step($, 0)
      expect(w.steps[0]).toMatchObject({ effort: 'high' })
    })
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

// Audit du 10/11/2026 : 9 % des messages disent seuls leur difficulté. Le service reçoit
// de quoi situer le message : le modèle choisi pour la session, le début de la demande qui
// a ouvert la conversation, et ce que le tour précédent a modifié.
describe('mémoire de la conversation', () => {
  test('premier message : le modèle de la session, rien avant lui', async ($, on) => {
    const w = world(on, { messages: [user('où en est-on sur ce projet ?')] })
    await step($, 0)
    expect(w.routes()[0]?.body).toMatchObject({ session_model: 'claude-opus-5-5', first_message: '', last_turn_edits: 0 })
  })

  test('suite : début de la conversation et fichiers modifiés depuis le message précédent', async ($, on) => {
    const opening = 'Refonds le module de paiement ' + 'x'.repeat(2_000)
    const w = world(on, { messages: [user(opening), assistant('fait'), user('et la suite ?')], read: () => 'b' })
    await step($, 0, { turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: '/p/a.ts', old_string: 'b', new_string: 'B' })
    await $.tool.call({ tool: 'Read', file_path: '/p/a.ts' })
    await $.tool.call({ tool: 'Edit', file_path: '/p/c.ts', old_string: 'b', new_string: 'C' })
    await complete($, 't1')
    await step($, 0, { turnId: 't2' })
    const [first, second] = w.routes().map(sent => sent.body)
    expect(first).toMatchObject({ first_message: opening.slice(0, 600), last_turn_edits: 0 })
    expect(second).toMatchObject({ first_message: opening.slice(0, 600), last_turn_edits: 2 })
    // Le début de la conversation ne part qu'avec la demande de décision.
    expect(w.sent.filter(sent => JSON.stringify(sent.body).includes('Refonds le module')).every(sent => sent.url.endsWith('/v1/route'))).toBe(true)
  })

  test('session sur Fable : le service la connaît, peut en descendre et y revenir', async ($, on) => {
    const answers: Reply[] = [{ status: 200, body: { model: 'opus', effort: 'medium' } }, { status: 200, body: { model: 'claude-fable-5-2', effort: 'high' } }]
    const w = world(on, { messages: [user('petite question')], route: () => answers.shift() ?? 'down' })
    await step($, 0, { turnId: 't1', model: 'claude-fable-5-2' })
    await complete($, 't1')
    await step($, 0, { turnId: 't2', model: 'claude-fable-5-2' })
    expect(w.routes().map(sent => [sent.body.model, sent.body.session_model])).toEqual([
      ['claude-fable-5-2', 'claude-fable-5-2'], ['opus', 'claude-fable-5-2'],
    ])
    expect(w.steps.map(seen => [seen.model, seen.effort])).toEqual([['opus', 'medium'], ['claude-fable-5-2', 'high']])
  })

  test('balise [fable] : le choix de l’utilisateur passe avant le service', async ($, on) => {
    const w = world(on, { messages: [user('[fable] refonte complète')], route: () => 'down' })
    await step($, 0)
    expect(w.routes()[0]?.body).toMatchObject({ keep_model: true, model: 'fable' })
    expect(w.steps[0]).toMatchObject({ model: 'fable' })
  })
})

describe('limites du compte', () => {
  const NOTICE = 'Opus est bloqué sur ce compte : Sonnet à la place.'

  test('réglage imposé par une limite : il passe devant la balise, sa phrase est montrée une fois, hors du prompt', async ($, on) => {
    const msgs = [user('[opus] [max] refonte complète')]
    const w = world(on, { messages: msgs, route: () => ({ status: 200, body: { model: 'sonnet', effort: null, notice: NOTICE } }) })
    await step($, 0, { turnId: 't1' })
    expect(w.routes()[0]?.body).toMatchObject({ keep_model: true, keep_effort: true, model: 'opus' })
    // Le modèle imposé passe devant la balise ; la réflexion, non bloquée, reste celle de la balise.
    expect(w.steps[0]).toMatchObject({ model: 'sonnet', effort: 'max' })
    msgs.push(assistant('fait'), user('[opus] encore'))
    await step($, 0, { turnId: 't2' })
    expect(w.steps[1]).toMatchObject({ model: 'sonnet' })
    expect(messages(w)).toEqual([`ui.log ${NOTICE}`])
    expect(JSON.stringify(w.steps)).not.toContain('bloqué')
  })

  test('réflexion imposée par une limite : elle passe devant la balise de réflexion', async ($, on) => {
    const notice = 'La réflexion max est bloquée sur ce compte : xhigh à la place.'
    const w = world(on, { messages: [user('[max] refonte')], route: () => ({ status: 200, body: { model: null, effort: 'xhigh', notice } }) })
    await step($, 0)
    expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' })
    expect(messages(w)).toEqual([`ui.log ${notice}`])
  })

  test('sans phrase du service, la balise passe toujours devant', async ($, on) => {
    const w = world(on, { messages: [user('[opus] refonte')], route: () => ({ status: 200, body: { model: 'sonnet', effort: 'low' } }) })
    await step($, 0, { model: 'claude-sonnet-5-5' })
    expect(w.steps[0]).toMatchObject({ model: 'opus', effort: 'low' })
    expect(messages(w)).toEqual([])
  })
})

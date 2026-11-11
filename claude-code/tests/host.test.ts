import { EXECUTION_SECTION } from '../hooks/thinking'
// Application hôte (Open Codex) : relais du service avec son jeton, issue de
// chaque décision sur son pont local au lieu de la ligne d'état, leviers coupés
// par ses réglages. Hors de l'application, rien de cela ne joue.
import { describe, expect, test } from 'claude-code/testing'
import { CORE_PROMPT, KEY, URL, agent, step, user, world } from './support'
import type { Options, Reply, Sent, World } from './support'

const RELAY = 'http://dodoia-vps:7420/tokfit'
const TOKEN = 'ocd_' + 'b'.repeat(40)
const BRIDGE_FILE = '/support/bridge.json'
const BRIDGE = 'http://127.0.0.1:47321/'
const HOST = { OPEN_CODEX_PANE: 'pane-7', OPEN_CODEX_BRIDGE: BRIDGE_FILE }
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] }

function inside(on: Parameters<typeof world>[0], options: Options = {}): World {
  return world(on, {
    ...options,
    env: { ...HOST, ...options.env },
    files: { [BRIDGE_FILE]: JSON.stringify({ url: BRIDGE, token: 'pont-secret' }), ...options.files },
  })
}

function bridged(w: World): Sent[] {
  return w.sent.filter(sent => sent.url === BRIDGE)
}

function reports(w: World): unknown[] {
  return bridged(w).map(sent => sent.body.route)
}

describe('relais d’une application hôte', () => {
  test('adresse et jeton du relais passent avant la configuration du client', async ($, on) => {
    const w = world(on, { env: { ECONOMISEUR_RELAY_URL: `${RELAY}/`, ECONOMISEUR_RELAY_TOKEN: TOKEN }, messages: [user('x')] }) // publish: keep
    await step($, 0)
    expect(w.routes()).toHaveLength(1)
    expect(w.routes()[0]?.url).toBe(`${RELAY}/v1/route`)
    expect(w.routes()[0]?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` })
  })

  test('relais seul, sans fichier ni clé du client', async ($, on) => {
    const w = world(on, { config: null, env: { ECONOMISEUR_RELAY_URL: RELAY, ECONOMISEUR_RELAY_TOKEN: TOKEN }, messages: [user('x')] }) // publish: keep
    await step($, 0)
    expect(w.routes()[0]?.url).toBe(`${RELAY}/v1/route`)
  })

  const refused: [string, Record<string, string>][] = [
    ['adresse avec identifiants', { ECONOMISEUR_RELAY_URL: 'http://moi@hote:1/x', ECONOMISEUR_RELAY_TOKEN: TOKEN }], // publish: keep
    ['autre protocole', { ECONOMISEUR_RELAY_URL: 'ftp://hote/x', ECONOMISEUR_RELAY_TOKEN: TOKEN }], // publish: keep
    ['jeton avec espace', { ECONOMISEUR_RELAY_URL: RELAY, ECONOMISEUR_RELAY_TOKEN: 'a b c d e f g h' }], // publish: keep
    ['jeton absent', { ECONOMISEUR_RELAY_URL: RELAY }], // publish: keep
  ]
  for (const [name, env] of refused) {
    test(`${name} : relais ignoré, configuration du client`, async ($, on) => {
      const w = world(on, { env, messages: [user('x')] })
      await step($, 0)
      expect(w.routes()[0]?.url).toBe(`${URL}/v1/route`)
      expect(w.routes()[0]?.headers).toMatchObject({ authorization: `Bearer ${KEY}` })
    })
  }
})

describe('voyant de l’application hôte', () => {
  test('décision : attente puis issue sur le pont, pas de ligne d’état', async ($, on) => {
    const w = inside(on, {
      messages: [user('renomme cette variable')],
      route: () => ({ status: 200, body: { model: 'sonnet', effort: 'low', reason: 'sonnet-low 64%' } }),
    })
    await step($, 0)
    expect(w.steps[0]).toMatchObject({ model: 'sonnet', effort: 'low' })
    expect(reports(w)).toEqual([
      { state: 'pending' },
      { state: 'ok', model: 'sonnet', effort: 'low', reason: 'sonnet-low 64%' },
    ])
    expect(bridged(w)[0]?.body).toMatchObject({ token: 'pont-secret', pane: 'pane-7', event: 'RouteStatus' })
    expect(w.shown).toEqual([])
  })

  test('sans raison rendue par le service : issue sans raison', async ($, on) => {
    const w = inside(on, { messages: [user('x')], route: () => ({ status: 200, body: { model: null, effort: 'medium' } }) })
    await step($, 0)
    expect(reports(w).at(-1)).toEqual({ state: 'ok', model: 'opus', effort: 'medium', reason: '' })
  })

  const failures: [string, Reply, unknown][] = [
    ['décideur non configuré', { status: 503, body: { error: 'clé absente' } }, { state: 'not_configured', reason: 'service 503 : clé absente' }],
    ['erreur', { status: 502, body: { error: 'Décision indisponible' } }, { state: 'failing', reason: 'service 502 : Décision indisponible' }],
    ['injoignable', 'down', { state: 'failing', reason: 'service injoignable' }],
    ['muet', 'silent', { state: 'failing', reason: 'délai dépassé (6 s)' }],
    ['réponse illisible', { status: 200, text: '<html>' }, { state: 'failing', reason: 'réponse illisible' }],
  ]
  for (const [name, reply, shown] of failures) {
    test(`${name} : réglage gardé, cause sur le pont`, async ($, on) => {
      const w = inside(on, { messages: [user('x')], route: () => reply })
      const pending = step($, 0)
      if (reply === 'silent') await w.clock.advance(6_000)
      await pending
      expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
      expect(reports(w)).toEqual([{ state: 'pending' }, shown])
      expect(w.shown).toEqual([])
    })
  }

  test('choix entier de l’utilisateur : le voyant ne bouge pas', async ($, on) => {
    const w = inside(on, { messages: [user('[haiku] [low] liste les fichiers')] })
    await step($, 0)
    expect(w.steps[0]).toMatchObject({ model: 'haiku', effort: 'low' })
    expect(reports(w)).toEqual([])
  })

  test('sous-agents : rien sur le pont', async ($, on) => {
    const w = inside(on, { messages: [user('x')], route: () => ({ status: 200, body: { model: 'haiku', effort: 'medium' } }) })
    await step($, 0)
    await agent($, 'lis le dossier')
    expect(reports(w)).toHaveLength(2)
  })

  test('pont illisible ou hors machine : décision appliquée, rien d’envoyé', async ($, on) => {
    const w = inside(on, {
      files: { [BRIDGE_FILE]: JSON.stringify({ url: 'http://ailleurs.test/', token: 't' }) },
      messages: [user('x')], route: () => ({ status: 200, body: { model: 'sonnet', effort: 'low' } }),
    })
    await step($, 0)
    expect(w.steps[0]).toMatchObject({ model: 'sonnet' })
    expect(w.sent.filter(sent => !sent.url.startsWith(URL))).toEqual([])
  })

  test('hors de l’application : ligne d’état comme avant, rien sur un pont', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: () => ({ status: 200, body: { model: 'sonnet', effort: 'low', reason: 'r' } }) })
    await step($, 0)
    expect(w.shown).toEqual(['ui.status sonnet · low'])
    expect(w.sent.every(sent => sent.url.startsWith(URL))).toBe(true)
  })

  test('le texte des messages ne part pas sur le pont', async ($, on) => {
    const witness = 'TEMOIN-pont-91c2'
    const w = inside(on, { messages: [user(`corrige ${witness}`)], route: () => ({ status: 502, body: { error: 'x' } }) })
    await step($, 0)
    expect(bridged(w).length).toBeGreaterThan(0)
    expect(JSON.stringify(bridged(w))).not.toContain(witness)
  })
})

describe('leviers coupés par l’application hôte', () => {
  test('routage coupé : aucune demande, réglage du moteur, balises comprises', async ($, on) => {
    const w = inside(on, { env: { ECONOMISEUR_OFF: 'routing' }, messages: [user('[haiku] x')] }) // publish: keep
    await step($, 0)
    await agent($, 'lis le dossier', { model: 'opus' })
    expect(w.routes()).toEqual([])
    expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.spawned[0]?.model).toBe('opus')
    expect(reports(w)).toEqual([])
  })

  test('routage rendu ou coupé en cours de conversation par ECONOMISEUR_OFF_FILE, sans relance', async ($, on) => { // publish: keep
    const OFF_FILE = '/support/off'
    const w = inside(on, {
      env: { ECONOMISEUR_OFF_FILE: OFF_FILE, ECONOMISEUR_OFF: 'routing' }, // publish: keep
      files: { [OFF_FILE]: '' },
      messages: [user('x')],
    })
    // Le fichier prime sur la variable de lancement : routage actif.
    await step($, 0)
    expect(w.routes()).toHaveLength(1)
    // Modèle choisi par l'utilisateur : le fichier coupe le routage au message suivant.
    w.files[OFF_FILE] = 'routing'
    await w.clock.advance(1_000)
    await step($, 0)
    expect(w.routes()).toHaveLength(1)
    // Rendu au routage.
    w.files[OFF_FILE] = ''
    await w.clock.advance(1_000)
    await step($, 0)
    expect(w.routes()).toHaveLength(2)
  })

  test('fichier de leviers illisible : la variable fait foi', async ($, on) => {
    const gone = inside(on, { env: { ECONOMISEUR_OFF_FILE: '/support/absent', ECONOMISEUR_OFF: 'routing' }, messages: [user('x')] }) // publish: keep
    await step($, 0)
    expect(gone.routes()).toEqual([])
  })

  test('réflexion coupée par l’hôte, le reste actif', async ($, on) => {
    const w = inside(on, { env: { ECONOMISEUR_OFF: ' thinking , ../x' }, messages: [user('x')] }) // publish: keep
    expect((await $.prompt.compose(COMPOSE)).sections).toEqual([...CORE_PROMPT, EXECUTION_SECTION])
    await step($, 0)
    expect(w.routes()).toHaveLength(1)
  })
})

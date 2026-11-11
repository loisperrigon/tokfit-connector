// Cache gardé au chaud pendant une pause (fork-ping) : le service dit quand
// relancer ; le connecteur relance la dernière requête du fil par $.model.fork,
// sans sous-agent ni routage, et la compte à part.
import { describe, expect, test } from 'claude-code/testing'
import { PING_PROMPT } from '../hooks/warm'
import { SESSION, URL, complete, config, end, step, user, world } from './support'
import type { Reply } from './support'

type Sent = Record<string, unknown>

const SONNET = (): Reply => ({ status: 200, body: { model: 'sonnet', effort: 'low' } })

// Répond `delays[n]` à la n-ième demande, puis null.
function delays(...values: (number | null)[]): (body: Sent) => Reply {
  let n = 0
  return () => ({ status: 200, body: { after_s: n < values.length ? values[n++] ?? null : null } })
}

describe('fork-ping', () => {
  test('fin de tour du fil principal : le service est consulté avec le contexte du fil', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: SONNET })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    expect(w.warms()).toHaveLength(1)
    expect(w.warms()[0]?.url).toBe(`${URL}/v1/warm`)
    expect(w.warms()[0]?.body).toEqual({ model: 'claude-sonnet-5-5', context_tokens: 42_000, idle_s: 0, pings: 0 })
    expect(w.spawned).toEqual([])
  })

  test('au délai rendu, une relance part par $.model.fork, sans sous-agent ni demande de routage', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: SONNET, warm: delays(270, null) })
    await step($, 0, { turnId: 't1', effort: 'low' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(269_000)
    expect(w.forks).toEqual([])
    await w.clock.advance(1_000)
    await w.clock.settle()
    expect(w.forks).toEqual([PING_PROMPT])
    expect(w.spawned).toEqual([])
    expect(w.routes()).toHaveLength(1)
    // Seconde demande : une relance faite, 270 s de pause.
    expect(w.warms()).toHaveLength(2)
    expect(w.warms()[1]?.body).toEqual({ model: 'claude-sonnet-5-5', context_tokens: 42_000, idle_s: 270, pings: 1 })
    await end($)
    await w.clock.settle()
    const steps = w.usages().flatMap(sent => sent.body.steps as Sent[])
    const pings = steps.filter(s => s.ping === true)
    expect(pings).toHaveLength(1)
    expect(pings[0]).toEqual({ step_id: expect.any(String), session_id: SESSION, model: 'claude-sonnet-5-5', effort: 'low',
      input: 4, cache_read: 52_000, cache_write: 300, output: 2, ping: true })
  })

  // Un fork part au niveau de la session (vu en vrai : fil routé en high,
  // relance en low) ; là où la réflexion vaut pour toute la requête, un autre
  // niveau que celui du fil réécrit toute la conversation en cache (types
  // 2.1.318, ModelForkRequest.effort). Option `effort` depuis 2.1.318.
  test('2.1.318 et plus : la relance reprend la réflexion de la dernière étape du fil', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: SONNET, warm: delays(270, null), version: '2.1.318' })
    await step($, 0, { turnId: 't1', effort: 'xhigh' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(270_000)
    await w.clock.settle()
    expect(w.forkEfforts).toEqual(['low'])
  })

  test('avant 2.1.318 : pas d’option inconnue du moteur', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: SONNET, warm: delays(270, null), version: '2.1.317' })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(270_000)
    await w.clock.settle()
    expect(w.forkEfforts).toEqual([undefined])
  })

  test('la relance est comptée avec la réflexion que le moteur dit avoir envoyée', async ($, on) => {
    const usage = { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 300 }
    const w = world(on, { messages: [user('x')], route: SONNET, warm: delays(270, null), version: '2.1.318',
      fork: () => ({ isAnswered: true as const, text: 'ok', usage, effort: 'medium' as const }) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(270_000)
    await w.clock.settle()
    await end($)
    await w.clock.settle()
    const pings = w.usages().flatMap(sent => sent.body.steps as Sent[]).filter(s => s.ping === true)
    expect(pings[0]?.effort).toBe('medium')
  })

  test('au retour, la première étape dit combien de relances et combien de pause', async ($, on) => {
    const w = world(on, { messages: [user('x')], warm: delays(3_300, null) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(3_300_000)
    await w.clock.settle()
    await w.clock.advance(1_000_000)
    await step($, 0, { turnId: 't2' })
    await step($, 1, { turnId: 't2' })
    await end($)
    await w.clock.settle()
    const main = w.usages().flatMap(sent => sent.body.steps as Sent[]).filter(s => s.ping !== true)
    expect(main[1]).toMatchObject({ after_pings: 1, pause_s: 4_300 })
    expect(main[2]?.after_pings).toBeUndefined()
  })

  test('après une relance, l’âge du cache du fil repart de la relance', async ($, on) => {
    const w = world(on, { messages: [user('x')], warm: delays(270, null) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(270_000)
    await w.clock.settle()
    await w.clock.advance(30_000)
    await step($, 0, { turnId: 't2' })
    await end($)
    await w.clock.settle()
    const steps = w.usages().flatMap(sent => sent.body.steps as Sent[]).filter(s => s.ping !== true)
    expect(steps.at(-1)).toMatchObject({ idle_s: 30 })
    expect(w.routes().at(-1)?.body.model_cache).toEqual({ opus: { idle_s: 30, tokens: 52_810 } })
  })

  test('rien à relancer ou relance en erreur : la chaîne s’arrête', async ($, on) => {
    const w = world(on, { messages: [user('x')], warm: delays(270, 270, 270), fork: () => ({ isAnswered: false, reason: 'nothing-to-fork' }) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(3_600_000)
    expect(w.forks).toHaveLength(1)
    expect(w.warms()).toHaveLength(1)
  })

  test('l’utilisateur revient avant le délai : rien ne part', async ($, on) => {
    const w = world(on, { messages: [user('x')], warm: delays(270) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(100_000)
    await step($, 0, { turnId: 't2' })
    await w.clock.advance(600_000)
    expect(w.forks).toEqual([])
  })

  for (const [name, options] of [
    ['réponse nulle', { warm: delays(null) }],
    ['service en panne', { warm: (): Reply => 'down' }],
    ['clé invalide', { warm: delays(270), config: config(URL, 'mauvaise') }],
  ] as const) {
    test(`${name} : aucun fork`, async ($, on) => {
      const w = world(on, { messages: [user('x')], ...options })
      await step($, 0, { turnId: 't1' })
      await complete($, 't1')
      await w.clock.settle()
      await w.clock.advance(3_600_000)
      expect(w.spawned).toEqual([])
      expect(w.warms().length).toBeLessThanOrEqual(1)
    })
  }

  // Compaction à l'inactivité de Claude Code (2.1.299) : une conversation d'au
  // moins 200 k tokens laissée ~54 min est compactée par le moteur. Le service
  // reçoit ce seuil pour ne pas relancer un cache que le moteur va résumer.
  for (const [name, options, expected] of [
    ['2.1.299 et plus, réglage par défaut', { version: '2.1.318' }, 200_000],
    ['seuil changé par CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS', { version: '2.1.318', env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '150000' } }, 150_000],
    ['seuil illisible : celui du moteur', { version: '2.1.318', env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: 'beaucoup' } }, 200_000],
    ['coupée par « idleCompaction »: false', { version: '2.1.318', settings: { idleCompaction: false } }, undefined],
    ['avant 2.1.299', { version: '2.1.298' }, undefined],
    ['version de développement', { version: '2.1.320-dev.20261105.t101500.sha1a2b3c4' }, 200_000],
  ] as const) {
    test(`compaction à l’inactivité, ${name} : seuil dit au service`, async ($, on) => {
      const w = world(on, { messages: [user('x')], ...options })
      await step($, 0, { turnId: 't1' })
      await complete($, 't1')
      await w.clock.settle()
      expect(w.warms()).toHaveLength(1)
      expect(w.warms()[0]?.body.idle_compact_tokens).toBe(expected)
    })
  }

  test('le fil compacté par le moteur pendant la pause : la chaîne s’arrête (le fork relirait l’ancien préfixe)', async ($, on) => {
    const w = world(on, { messages: [user('x')], warm: delays(270, 270, 270) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(270_000)
    await w.clock.settle()
    expect(w.forks).toHaveLength(1)
    await $.session.compact({ trigger: 'auto', messages: [user('résumé')] })
    await w.clock.advance(600_000)
    await w.clock.settle()
    expect(w.forks).toHaveLength(1)
  })

  test('la compaction d’un sous-agent pendant la pause ne coupe pas les relances du fil', async ($, on) => {
    const w = world(on, { messages: [user('x')], warm: delays(270, 270, null) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await $.session.compact({ trigger: 'auto', agentId: 'agent-3', messages: [user('résumé')] })
    await w.clock.advance(540_000)
    await w.clock.settle()
    expect(w.forks).toHaveLength(2)
  })

  test('la fin d’un sous-agent ou une fin de session ne relance rien', async ($, on) => {
    const w = world(on, { messages: [user('x')], warm: delays(270) })
    await step($, 0, { turnId: 't1', agentId: 'agent-9' })
    await complete($, 't1', 'agent-9')
    await w.clock.settle()
    expect(w.warms()).toEqual([])
    await step($, 0, { turnId: 't2' })
    await complete($, 't2')
    await w.clock.settle()
    await end($)
    await w.clock.advance(600_000)
    expect(w.forks).toEqual([])
  })
})

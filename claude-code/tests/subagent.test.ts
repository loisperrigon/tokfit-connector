// Sous-agents : tous routés, quoi qu'aient fixé l'agent principal (appel
// Agent), la définition de l'agent, un plugin, un workflow ou le réglage du
// compte. Seules les balises de l'utilisateur passent avant, pour les
// sous-agents de son message. Le modèle se pose au lancement et sur chaque
// étape, la réflexion sur chaque étape. Un fork ou une reprise envoie les vrais
// faits de cache : le service décide si changer de modèle vaut la réécriture.
import { describe, expect, test } from 'claude-code/testing'
import { agent, assistant, spawn, step, user, world } from './support'
import type { Reply } from './support'

const ROUTED: Reply = { status: 200, body: { model: 'haiku', effort: 'low' } }
// Tokens laissés dans le cache par une étape du monde simulé (usageOf).
const CACHED = 10 + 50_000 + 2_000 + 800

describe('nouveau sous-agent : le service décide, quoi qu’il soit fixé', () => {
  test('general-purpose sans modèle : modèle au lancement, réflexion sur ses étapes', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: () => ROUTED })
    expect(await agent($, 'liste les fichiers de tests')).toBe('haiku')
    await step($, 0, { turnId: 'a-t1', agentId: 'agent-1', model: 'claude-haiku-5-5' })
    expect(w.routes()).toHaveLength(1)
    expect(w.routes()[0]?.body).toMatchObject({
      kind: 'subagent', origin: 'call', subagent_type: 'general-purpose', message: 'liste les fichiers de tests',
      conversation_tokens: 0, model: 'claude-opus-5-5', keep_model: false, keep_effort: false,
      requested_model: '', requested_effort: '',
    })
    expect(w.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' })
  })

  // Cas, appel, origine envoyée au service (pour son journal), environnement.
  const fixed: [string, Parameters<typeof agent>[2], string, Record<string, string>?][] = [
    ['modèle fixé par l’agent principal', { model: 'sonnet' }, 'call'],
    ['réflexion fixée par l’agent principal', { effort: 'high' }, 'call'],
    ['agent intégré (Explore)', { type: 'Explore' }, 'builtin'],
    ['agent d’un plugin', { type: 'revue:relecteur', provider: 'revue' }, 'plugin'],
    ['agent du projet qui fixe son modèle', { type: 'fixe' }, 'custom'],
    ['agent d’un workflow', { type: 'general-purpose', workflow: true }, 'workflow'],
    ['coéquipier d’une équipe', { type: 'teammate', isTeammate: true }, 'teammate'],
    ['CLAUDE_CODE_SUBAGENT_MODEL posé', {}, 'call', { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' }],
  ]
  for (const [name, call, origin, env] of fixed) {
    test(`${name} : routé, la décision du service passe devant`, async ($, on) => {
      const w = world(on, {
        messages: [user('x')], route: () => ROUTED, ...(env ? { env } : {}),
        files: { '/projet/.claude/agents/fixe.md': '---\nname: fixe\nmodel: opus\neffort: max\n---\n' },
      })
      await $.agent.offer({ agent: 'Explore', description: 'x', source: 'built-in', provider: { plugin: 'engine', tier: 'core' } })
      expect(await agent($, 'relis le module', call)).toBe('haiku')
      await step($, 0, { turnId: 'a-t1', agentId: 'agent-1', model: 'claude-opus-5-5', effort: 'max' })
      expect(w.routes()).toHaveLength(1)
      expect(w.routes()[0]?.body).toMatchObject({
        origin, requested_model: call?.model ?? '', requested_effort: call?.effort ?? '',
      })
      expect(w.steps[0]).toMatchObject({ model: 'haiku', effort: 'low' })
    })
  }

  test('modèle imposé à tous les sous-agents (…_FORCE) : le modèle est aussi reposé sur chaque étape', async ($, on) => {
    const w = world(on, {
      messages: [user('x')], route: () => ROUTED,
      env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' },
    })
    await agent($, 'x')
    // Le moteur fait passer son modèle imposé avant celui du lancement.
    await step($, 0, { turnId: 'a-t1', agentId: 'agent-1', model: 'claude-sonnet-5-5' })
    await step($, 1, { turnId: 'a-t1', agentId: 'agent-1', model: 'claude-sonnet-5-5' })
    expect(w.steps.map(s => s.model)).toEqual(['haiku', 'haiku'])
  })

  test('service sans avis sur le modèle : le sous-agent suit le modèle en cours du fil principal', async ($, on) => {
    const w = world(on, {
      messages: [user('x')],
      route: body => body.kind === 'main' ? { status: 200, body: { model: 'sonnet', effort: 'low' } }
        : { status: 200, body: { model: null, effort: 'medium' } },
    })
    await step($, 0, { turnId: 't1' })
    // Explore se serait lancé sur son propre modèle : il suit celui que le service a gardé.
    expect(await agent($, 'cherche', { type: 'Explore' })).toBe('sonnet')
    expect(w.routes()[1]?.body).toMatchObject({ kind: 'subagent', model: 'sonnet' })
    await step($, 0, { turnId: 'a-t1', agentId: 'agent-1', model: 'claude-sonnet-5-5' })
    expect(w.steps[1]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
  })

  test('première étape avant que le lancement ne rende l’identifiant : décision retrouvée par la consigne', async ($, on) => {
    const w = world(on, {
      messages: [user('x')], route: () => ROUTED, agentMessages: { 'agent-1': [user('compte les lignes')] },
      // Le moteur fait tourner la première étape pendant le lancement.
      whileSpawning: async () => { await step($, 0, { turnId: 'a-t1', agentId: 'agent-1' }) },
    })
    await agent($, 'compte les lignes')
    expect(w.steps[0]).toMatchObject({ model: 'haiku', effort: 'low' })
  })

  test('sous-agent d’un sous-agent : le modèle en cours est celui de son parent', async ($, on) => {
    const w = world(on, {
      messages: [user('x')],
      route: body => body.message === 'parent' ? ROUTED : { status: 200, body: { model: null, effort: 'medium' } },
    })
    await agent($, 'parent')
    await agent($, 'enfant', { parentAgentId: 'agent-1', parentModel: 'claude-opus-5-5' })
    expect(w.routes()[1]?.body).toMatchObject({ model: 'haiku' })
  })
})

describe('fork : contexte hérité, vrais faits de cache', () => {
  test('du fil principal : taille du contexte, modèle en cours et cache envoyés ; décision posée sur ses étapes', async ($, on) => {
    const w = world(on, {
      messages: [user('x')],
      route: body => body.kind === 'main' ? { status: 200, body: { model: 'sonnet', effort: 'low' } }
        : { status: 200, body: { model: 'haiku', effort: 'medium' } },
    })
    await step($, 0, { turnId: 't1' })
    await w.clock.advance(20_000)
    // Le moteur ignore le modèle d'un fork au lancement : il démarre sur celui du parent.
    expect(await agent($, 'vérifie la suite', { fork: true })).toBe('claude-opus-5-5')
    expect(w.routes()[1]?.body).toMatchObject({
      kind: 'subagent', origin: 'fork', message: 'vérifie la suite', conversation_tokens: 42_000, model: 'sonnet',
      model_cache: { sonnet: { idle_s: 20, tokens: CACHED } }, cache_cold: false, keep_model: false,
    })
    await step($, 0, { turnId: 'f-t1', agentId: 'agent-1' })
    await step($, 1, { turnId: 'f-t1', agentId: 'agent-1' })
    expect(w.steps.slice(1).map(s => [s.model, s.effort])).toEqual([['haiku', 'medium'], ['haiku', 'medium']])
  })

  test('service qui garde le modèle : le fork tourne sur le modèle du parent, pas sur celui de la session', async ($, on) => {
    const w = world(on, {
      messages: [user('x')],
      route: body => body.kind === 'main' ? { status: 200, body: { model: 'sonnet', effort: 'low' } }
        : { status: 200, body: { model: null, effort: null } },
    })
    await step($, 0, { turnId: 't1' })
    await agent($, 'x', { fork: true })
    await step($, 0, { turnId: 'f-t1', agentId: 'agent-1' })
    expect(w.steps[1]).toMatchObject({ model: 'sonnet', effort: 'high' })
  })

  test('service en panne : le fork reste sur le modèle du parent (cache gardé), sans message', async ($, on) => {
    let reply: Reply = { status: 200, body: { model: 'sonnet', effort: 'low' } }
    const w = world(on, { messages: [user('x')], route: () => reply })
    await step($, 0, { turnId: 't1' })
    reply = 'down'
    w.shown.length = 0
    await agent($, 'x', { fork: true })
    await step($, 0, { turnId: 'f-t1', agentId: 'agent-1' })
    expect(w.steps[1]).toMatchObject({ model: 'sonnet', effort: 'high' })
    expect(w.shown).toEqual([])
  })

  test('après une compaction du fil principal : cache froid signalé', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: () => ROUTED })
    await $.session.compact({ trigger: 'manual', messages: [user('résumé')] })
    await agent($, 'x', { fork: true })
    expect(w.routes()[0]?.body).toMatchObject({ kind: 'subagent', origin: 'fork', cache_cold: true, model_cache: {} })
  })
})

describe('reprise d’un sous-agent (SendMessage, coéquipier réveillé)', () => {
  test('nouveau tour d’un agent connu : son message, la taille et l’âge de son cache', async ($, on) => {
    let reply: Reply = ROUTED
    const w = world(on, {
      messages: [user('x')], route: () => reply,
      agentMessages: { 'agent-1': [user('tâche'), assistant('fait'), user('ajoute aussi les tests')] },
    })
    await agent($, 'tâche')
    await step($, 0, { turnId: 'a-t1', agentId: 'agent-1', model: 'claude-haiku-5-5' })
    await step($, 1, { turnId: 'a-t1', agentId: 'agent-1', model: 'claude-haiku-5-5' })
    await w.clock.advance(30_000)
    reply = { status: 200, body: { model: 'sonnet', effort: 'medium' } }
    await step($, 0, { turnId: 'a-t2', agentId: 'agent-1', model: 'claude-haiku-5-5' })
    expect(w.routes()).toHaveLength(2)
    expect(w.routes()[1]?.body).toMatchObject({
      kind: 'subagent', origin: 'resume', message: 'ajoute aussi les tests', last_assistant_message: 'fait',
      conversation_tokens: CACHED, model: 'claude-haiku-5-5', model_cache: { haiku: { idle_s: 30, tokens: CACHED } },
      keep_model: false,
    })
    expect(w.steps[2]).toMatchObject({ model: 'sonnet', effort: 'medium' })
  })

  test('service qui garde le modèle : le modèle de l’agent ne bouge pas, la réflexion suit la décision', async ($, on) => {
    let reply: Reply = ROUTED
    const w = world(on, { messages: [user('x')], route: () => reply, agentMessages: { 'agent-1': [user('suite')] } })
    await agent($, 'tâche')
    await step($, 0, { turnId: 'a-t1', agentId: 'agent-1', model: 'claude-haiku-5-5' })
    reply = { status: 200, body: { model: null, effort: 'high' } }
    await step($, 0, { turnId: 'a-t2', agentId: 'agent-1', model: 'claude-haiku-5-5' })
    expect(w.steps[1]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' })
  })

  test('service en panne à la reprise : la décision du lancement reste', async ($, on) => {
    let reply: Reply = ROUTED
    const w = world(on, { messages: [user('x')], route: () => reply, agentMessages: { 'agent-1': [user('suite')] } })
    await agent($, 'tâche')
    await step($, 0, { turnId: 'a-t1', agentId: 'agent-1', model: 'claude-opus-5-5' })
    reply = { status: 401, body: { error: 'x' } }
    await step($, 0, { turnId: 'a-t2', agentId: 'agent-1', model: 'claude-opus-5-5' })
    expect(w.steps[1]).toMatchObject({ model: 'haiku', effort: 'low' })
    expect(w.shown).toEqual([])
  })

  test('agent d’une session précédente (cache inconnu) : modèle gardé, seule la réflexion est demandée', async ($, on) => {
    const w = world(on, {
      messages: [user('x')], route: () => ({ status: 200, body: { model: null, effort: 'medium' } }),
      listed: ['agent-7'], agentMessages: { 'agent-7': [user('tâche'), assistant('fait'), user('reprends')] },
    })
    await step($, 0, { turnId: 'r-t2', agentId: 'agent-7', model: 'claude-opus-5-5' })
    expect(w.routes()[0]?.body).toMatchObject({ kind: 'subagent', origin: 'resume', message: 'reprends', keep_model: true, model: 'claude-opus-5-5' })
    expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
  })

  test('boucle interne du moteur (compaction, mémoire) : jamais routée', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: () => ROUTED })
    await step($, 0, { turnId: 'm-t1', agentId: 'moteur-compaction' })
    expect(w.routes()).toEqual([])
    expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  })

  test('reprise annoncée au lancement : rien n’est demandé à ce moment-là', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: () => ROUTED, listed: ['agent-1'] })
    await $.agent.spawn({
      tool_use_id: 'tu-2', prompt: 'reviens', description: 'x', subagentType: 'teammate', provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5', background: true, fork: false, isTeammate: true, resume: { agentId: 'agent-1' },
    })
    expect(w.routes()).toEqual([])
  })
})

describe('balises de l’utilisateur, propagées aux sous-agents de son message', () => {
  test('[opus] [low] : imposés au sous-agent, le service n’est interrogé sur rien', async ($, on) => {
    const w = world(on, { messages: [user('[opus] [low] audit complet')], route: () => ROUTED })
    await step($, 0, { turnId: 't1' })
    expect(await agent($, 'audite le module', { model: 'haiku' })).toBe('opus')
    expect(w.routes()[1]?.body).toMatchObject({ kind: 'subagent', keep_model: true, keep_effort: true, model: 'opus', effort: 'low' })
    await step($, 0, { turnId: 'a-t1', agentId: 'agent-1', model: 'claude-opus-5-5' })
    expect(w.steps[1]).toMatchObject({ effort: 'low' })
  })

  test('ultrathink : la réflexion du sous-agent est laissée au moteur, le modèle reste au service', async ($, on) => {
    const w = world(on, { messages: [user('ultrathink sur ce bug')], route: () => ({ status: 200, body: { model: 'sonnet', effort: null } }) })
    await step($, 0, { turnId: 't1' })
    expect(await agent($, 'x')).toBe('sonnet')
    expect(w.routes()[1]?.body).toMatchObject({ keep_model: false, keep_effort: true })
    await step($, 0, { turnId: 'a-t1', agentId: 'agent-1', model: 'claude-sonnet-5-5', effort: 'max' })
    expect(w.steps[1]).toMatchObject({ effort: 'max' })
  })

  test('balise et service en panne : la balise s’applique quand même', async ($, on) => {
    const w = world(on, { messages: [user('[sonnet] fais-le')], route: () => 'down' })
    await step($, 0, { turnId: 't1' })
    expect(await agent($, 'x', { type: 'Explore' })).toBe('sonnet')
    expect(w.shown).toEqual([])
  })

  test('message suivant sans balise : le sous-agent est de nouveau routé librement', async ($, on) => {
    const messages = [user('[opus] gros chantier')]
    const w = world(on, { messages, route: () => ROUTED })
    await step($, 0, { turnId: 't1' })
    messages.push(assistant('ok'), user('petite question'))
    await step($, 0, { turnId: 't2' })
    expect(await agent($, 'x')).toBe('haiku')
    expect(w.routes().at(-1)?.body).toMatchObject({ keep_model: false, keep_effort: false })
  })
})

describe('repli silencieux', () => {
  const failures: [string, Reply][] = [
    ['réseau coupé', 'down'], ['clé refusée (401)', { status: 401, body: { error: 'x' } }],
    ['service en erreur (502)', { status: 502, body: { error: 'x' } }], ['réponse illisible', { status: 200, text: '<html>' }],
  ]
  for (const [name, reply] of failures) {
    test(`${name} : le sous-agent garde le réglage d’origine, sans message`, async ($, on) => {
      const w = world(on, { messages: [user('x')], route: () => reply })
      expect(await agent($, 'x', { model: 'sonnet' })).toBe('sonnet')
      await step($, 0, { turnId: 'a-t1', agentId: 'agent-1', model: 'claude-sonnet-5-5' })
      expect(w.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
      expect(w.shown).toEqual([])
    })
  }

  test('service muet : lancement retardé de 6 s au plus, réglage d’origine', async ($, on) => {
    const w = world(on, { messages: [user('x')], route: () => 'silent' })
    const pending = spawn($, 'x', { type: 'Explore' })
    await w.clock.advance(6_000)
    expect((await pending).model).toBe('claude-opus-5-5')
  })

  test('sans clé : aucun appel, rien ne change', async ($, on) => {
    const w = world(on, { config: null, messages: [user('x')] })
    expect(await agent($, 'x', { fork: true })).toBe('claude-opus-5-5')
    await step($, 0, { turnId: 'f-t1', agentId: 'agent-1' })
    expect(w.sent).toEqual([])
    expect(w.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  })
})

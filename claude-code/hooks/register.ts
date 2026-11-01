// Connecteur Claude Code du service (tokfit). À chaque
// message, il envoie au service les faits utiles et applique le modèle et la
// réflexion rendus ; il remonte les compteurs de tokens de chaque étape pour
// le tableau de bord. Aucune règle de décision ici : le service décide. Sur
// toute erreur, lenteur ou clé refusée, rien ne change ni ne s'affiche, et le
// message part avec le réglage en cours.
//
// Tous les sous-agents sont routés (lancés, forks, repris), quoi qu'aient fixé
// l'agent principal, une définition, un plugin, un workflow ou le réglage du
// compte ; seules les balises de l'utilisateur ([opus], [low]…, ultrathink)
// passent avant, pour son message et les sous-agents lancés pendant celui-ci.
//
// Repris du mod `oc-route` d'Open Codex (crates/oc-core/mods/oc-route) ; écarts :
// clé et adresse lues dans la configuration du plugin ou un fichier hors dépôt
// (service.ts), aucun message d'échec ni raison de la décision, pas de pont
// Open Codex, compteurs remontés par lots (usage.ts), sous-agents tous routés. Le texte des messages ne part que vers /v1/route : ni
// stocké, ni journalisé, ni affiché (tests/witness.test.ts).
import type { AgentSpawnInput, EngineInterface, PluginOptions, Register, SessionMessage, TurnStepInput, TurnStepResult } from 'claude-code'
import { EFFORTS, NAME, TIMEOUT_MS, link, post } from './service'
import type { Link } from './service'
import { add, flush, queue, stepOf } from './usage'
import type { Queue } from './usage'

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type Choice = { model?: string; effort?: Effort }
type Facts = Record<string, unknown>

const MODELS: readonly string[] = ['sonnet', 'opus', 'haiku']
// Le service ne lit que le début et la fin des textes : la requête est bornée
// au-dessus de ce qu'il garde, et reste loin de son plafond (64 Ko).
const HEAD = 3000
const TAIL = 1000
const SHORT_HEAD = 1000
const SHORT_TAIL = 500
const IMAGES = /\[Image #|Capture d|screencaptureui/

function bounded(text: string, head: number, tail: number): string {
  return text.length <= head + tail ? text : text.slice(0, head) + ' […] ' + text.slice(-tail)
}

// Choix explicite de l'utilisateur dans son message : [opus], [sonnet],
// [haiku], [low]… [max] ; `ultrathink` laisse la réflexion au moteur. Il passe
// avant le service, qui n'est interrogé que sur ce qui reste libre.
type Tags = Choice & { ultrathink: boolean }

function forced(text: string): Tags {
  const out: Tags = { ultrathink: /\bultrathink\b/i.test(text) }
  for (const tag of text.matchAll(/\[(\w+)\]/g)) {
    const word = (tag[1] ?? '').toLowerCase()
    if (EFFORTS.includes(word)) out.effort = word as Effort
    if (MODELS.includes(word)) out.model = word
  }
  return out
}

function family(model: string): string {
  return MODELS.find(name => model.toLowerCase().includes(name)) ?? model
}

// Modèle que le service peut rendre : un alias ou un identifiant complet
// (`claude-sonnet-5-5`, `claude-opus-5-5[1m]`) ; un nouveau modèle ne demande
// pas de nouvelle version du connecteur.
const MODEL_ID = /^(sonnet|opus|haiku|claude-[a-z0-9.-]{1,60}(\[1m\])?)$/

// Réponse du service lue telle quelle ; null si elle n'est pas une décision valide.
function decision(text: string): Choice | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { model, effort } = parsed as Record<string, unknown>
  if (model != null && !(typeof model === 'string' && MODEL_ID.test(model))) return null
  if (effort != null && !(typeof effort === 'string' && EFFORTS.includes(effort))) return null
  return { ...(model ? { model: model as string } : {}), ...(effort ? { effort: effort as Effort } : {}) }
}

// Réglage posé sur chaque étape d'un sous-agent ; le modèle y est toujours
// concret (celui du service, sinon celui qu'il a décidé de garder).
type Plan = Choice

// Dernier appel d'un sous-agent : son tour, quand, ce qu'il a laissé dans le
// cache et sur quel modèle. Un nouveau tour de cet agent est une reprise.
type Loop = { turnId: string; at: number; tokens: number; model: string }

const NO_TAGS: Tags = { ultrathink: false }

// État d'une session, créé au chargement du module. Le moteur n'accepte `$`
// qu'en argument de fonctions du module : pas de méthodes qui le reçoivent.
type State = {
  options: PluginOptions
  queue: Queue
  to: Link | null
  // Modèle choisi pour la conversation, gardé d'un tour à l'autre : chaque étape
  // le reprend (sinon les étapes d'outils reviendraient au modèle de la session
  // et réécriraient le cache). L'effort est reposé à chaque message.
  routedModel: string | undefined
  turn: Choice
  // Balises du dernier message de l'utilisateur : elles valent aussi pour les
  // sous-agents lancés pendant ce message.
  tags: Tags
  // Sous-agents : réglage de chaque agent lancé ou repris, et décisions prises au
  // lancement en attente de l'identifiant (l'agent peut faire sa première étape
  // avant que `agent.spawn` ne le rende), retrouvées par la consigne.
  plans: Map<string, Plan>
  pending: Map<string, Plan>
  spawning: number
  loops: Map<string, Loop>
  // Ce que l'appel Agent a fixé (tool_use_id → modèle, effort) et d'où vient
  // chaque type d'agent offert au modèle : seulement dits au service.
  requested: Map<string, { model?: string; effort?: string }>
  sources: Map<string, string>
  // Dernier appel du fil principal par famille de modèle : quand, et combien de
  // tokens il a laissés dans le cache. Le service en déduit ce que coûte un changement.
  lastCall: Map<string, { at: number; tokens: number }>
  // Vrai après une compaction du fil principal, jusqu'à sa prochaine réponse.
  compacted: boolean
}

// D'où vient un sous-agent (mêmes mots que le mod oc-route d'Open Codex, pour
// le journal du service) : il est routé quelle que soit son origine.
type Origin = 'resume' | 'fork' | 'teammate' | 'workflow' | 'plugin' | 'call' | 'builtin' | 'custom'

// Faits d'une demande pour un sous-agent (`kind: subagent`). `model` est celui
// sur lequel il tournerait sans changement ; `keep_model` quand son cache est
// inconnu. `requested_*` : ce qu'avait fixé l'appel Agent (journal seulement).
type AgentFacts = {
  origin: Origin; message: string; last_assistant_message?: string; model: string
  conversation_tokens: number; model_cache?: Record<string, { idle_s: number; tokens: number }>; cache_cold?: boolean
  keep_model?: boolean; subagent_type?: string; requested_model?: string; requested_effort?: string
}

function origin(e: AgentSpawnInput, sources: Map<string, string>): Origin {
  if (e.fork) return 'fork'
  if (e.isTeammate) return 'teammate'
  if (e.workflow) return 'workflow'
  if (e.provider.plugin !== 'engine') return 'plugin'
  if (e.subagentType === 'general-purpose') return 'call'
  return sources.get(e.subagentType) === 'built-in' ? 'builtin' : 'custom'
}

// Même modèle : identifiant identique, ou alias de la famille en cours (l'alias
// pourrait viser un autre identifiant et réécrire le cache pour rien).
function same(wanted: string, actual: string): boolean {
  return wanted === actual || (MODELS.includes(wanted) && family(actual) === wanted)
}

function withPlan(e: TurnStepInput, plan: Plan | undefined): TurnStepInput {
  if (!plan) return e
  return { ...e, ...(plan.model && !same(plan.model, e.model) ? { model: plan.model } : {}), ...(plan.effort ? { effort: plan.effort } : {}) }
}

// Réglage de l'étape : décision au premier pas d'un message, reprise ensuite.
// Fin d'un sous-agent en arrière-plan : le moteur la remet comme un message
// « user ». Ce n'est pas une demande : le tour garde le réglage du précédent.
const NOTIFICATION = /^\s*<task-notification>/

function spoken(m: SessionMessage): boolean {
  return m.role === 'user' && m.text !== '' && !m.toolResults?.length && !NOTIFICATION.test(m.text)
}

async function notified($: EngineInterface): Promise<boolean> {
  try {
    const last = (await $.session.messages()).filter(m => m.role === 'user' && m.text !== '' && !m.toolResults?.length).at(-1)
    return last !== undefined && NOTIFICATION.test(last.text)
  } catch {
    return false
  }
}

async function applied($: EngineInterface, s: State, e: TurnStepInput): Promise<TurnStepInput> {
  if (e.agentId !== undefined) return withPlan(e, await agentPlan($, s, e, e.agentId))
  if (e.index === 0 && !(await notified($))) {
    s.turn = {}
    s.tags = NO_TAGS
    try {
      s.turn = await decide($, s, e)
    } catch {
      // Session illisible : le modèle déjà choisi reste (pas de cache réécrit).
    }
    if (s.turn.model) s.routedModel = s.turn.model
  }
  return withPlan(e, { ...(s.routedModel ? { model: s.routedModel } : {}), ...(s.turn.effort ? { effort: s.turn.effort } : {}) })
}

// Réglage d'une étape de sous-agent. Au premier pas d'un tour : la décision du
// lancement, ou une nouvelle demande si l'agent reprend. Une boucle que la
// session ne liste pas (compaction, mémoire du moteur) n'est pas touchée.
async function agentPlan($: EngineInterface, s: State, e: TurnStepInput, id: string): Promise<Plan | undefined> {
  if (e.index !== 0) return s.plans.get(id)
  const loop = s.loops.get(id)
  if (!s.plans.has(id) && s.pending.size > 0) await claimed($, s, id)
  if (loop && loop.turnId !== e.turnId) return resumed($, s, e, id, loop)
  if (!loop && !s.plans.has(id) && s.spawning === 0 && (await $.agent.list()).some(agent => agent.id === id)) {
    return resumed($, s, e, id, undefined)
  }
  return s.plans.get(id)
}

// Première étape d'un agent dont le lancement n'a pas encore rendu l'identifiant.
async function claimed($: EngineInterface, s: State, id: string): Promise<void> {
  const found = await $.session.messages({ agentId: id })
  if ('deny' in found) return
  const last = found.filter(m => m.role === 'user' && m.text !== '').at(-1)?.text ?? ''
  const prompt = [...s.pending.keys()].find(text => text !== '' && last.includes(text))
  if (prompt !== undefined) started(s, prompt, id, s.pending.get(prompt) ?? {})
}

function started(s: State, prompt: string, agentId: string, plan: Plan): void {
  s.plans.set(agentId, plan)
  s.pending.delete(prompt)
}

// Après la réponse : mémoire du cache (fil principal et sous-agents) et compteurs de l'étape.
async function counted($: EngineInterface, s: State, step: TurnStepInput, result: TurnStepResult): Promise<void> {
  const usage = result.usage
  if (!usage) return
  const name = family(usage.model)
  const tokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
  const at = await $.clock.now()
  if (step.agentId !== undefined) {
    s.loops.set(step.agentId, { turnId: result.turnId, at, tokens, model: usage.model })
  } else if (MODELS.includes(name)) {
    s.lastCall.set(name, { at, tokens })
    s.compacted = false
  }
  if (!s.to) return
  const limits = (await $.session.usage()).rateLimits
  const counters = await stepOf(await $.session.id(), step.agentId, result.turnId, result.index, step.effort, usage, limits)
  if (add(s.queue, counters)) void flush($, s.queue)
}

function idle(now: number, at: number): number {
  return Math.max(0, Math.round((now - at) / 1000))
}

// { opus: { idle_s, tokens }, … } pour chaque modèle déjà appelé dans ce fil.
async function modelCache($: EngineInterface, s: State): Promise<Record<string, { idle_s: number; tokens: number }>> {
  const now = await $.clock.now()
  return Object.fromEntries([...s.lastCall].map(([name, call]) => [name, { idle_s: idle(now, call.at), tokens: call.tokens }]))
}

async function loopCache($: EngineInterface, loop: Loop): Promise<Record<string, { idle_s: number; tokens: number }>> {
  return { [family(loop.model)]: { idle_s: idle(await $.clock.now(), loop.at), tokens: loop.tokens } }
}

async function ask($: EngineInterface, to: Link, facts: Facts): Promise<Choice | null> {
  const reply = await post($, to, '/v1/route', facts, TIMEOUT_MS)
  return reply?.status === 200 ? decision(reply.text) : null
}

// Lancement d'un sous-agent, quel qu'il soit (appel du modèle, définition,
// plugin, workflow, coéquipier, fork) : le service décide.
async function spawned($: EngineInterface, s: State, e: AgentSpawnInput): Promise<Plan> {
  s.to = await link($, s.options)
  if (!s.to) return {}
  const parent = e.parentAgentId
  const parentLoop = parent === undefined ? undefined : s.loops.get(parent)
  // Modèle sur lequel tourne le parent : celui que le connecteur lui a posé.
  const current = (parent === undefined ? s.routedModel : s.plans.get(parent)?.model ?? parentLoop?.model) ?? e.parentModel
  const asked = s.requested.get(e.tool_use_id) ?? {}
  const facts: AgentFacts = {
    origin: origin(e, s.sources), message: e.prompt, model: current, conversation_tokens: 0, subagent_type: e.subagentType,
    requested_model: asked.model ?? e.model ?? '', requested_effort: asked.effort ?? '',
  }
  if (!e.fork) return routed($, s, s.to, facts, {})
  // Fork : il hérite du contexte et du cache du parent ; repli sur le modèle du parent.
  if (parent === undefined) {
    const usage = await $.session.usage()
    Object.assign(facts, { conversation_tokens: usage.context.tokens ?? 0, model_cache: await modelCache($, s), cache_cold: s.compacted })
  } else if (parentLoop) {
    Object.assign(facts, { conversation_tokens: parentLoop.tokens, model_cache: await loopCache($, parentLoop) })
  } else {
    facts.keep_model = true
  }
  return routed($, s, s.to, facts, { model: current })
}

// Nouveau tour d'un sous-agent (SendMessage, coéquipier réveillé) : son
// message, et son cache s'il est connu ; sinon le modèle reste.
async function resumed($: EngineInterface, s: State, e: TurnStepInput, id: string, loop: Loop | undefined): Promise<Plan | undefined> {
  const before = s.plans.get(id)
  s.to = await link($, s.options)
  if (!s.to) return before
  const found = await $.session.messages({ agentId: id })
  const rows = 'deny' in found ? [] : found
  const current = rows.filter(spoken).at(-1)
  const earlier = rows.slice(0, current ? rows.lastIndexOf(current) : rows.length)
  const facts: AgentFacts = {
    origin: 'resume', message: current?.text ?? '',
    last_assistant_message: earlier.filter(m => m.role === 'assistant' && m.text !== '').at(-1)?.text ?? '',
    model: loop?.model ?? before?.model ?? e.model, conversation_tokens: loop?.tokens ?? 0,
    ...(loop ? { model_cache: await loopCache($, loop) } : { keep_model: true }),
  }
  const plan = await routed($, s, s.to, facts, before ?? {})
  s.plans.set(id, plan)
  return plan
}

// Demande pour un sous-agent. Les balises du message de l'utilisateur passent
// avant le service, même en panne ; sur toute autre panne, `fallback`.
async function routed($: EngineInterface, s: State, to: Link, facts: AgentFacts, fallback: Plan): Promise<Plan> {
  const tags = s.tags
  const own: Plan = { ...(tags.model ? { model: tags.model } : {}), ...(tags.effort ? { effort: tags.effort } : {}) }
  const usage = await $.session.usage()
  const answer = await ask($, to, {
    kind: 'subagent',
    ...facts,
    session_id: await $.session.id(),
    message: bounded(facts.message, HEAD, TAIL),
    last_assistant_message: bounded(facts.last_assistant_message ?? '', SHORT_HEAD, SHORT_TAIL),
    images_attached: false,
    previous_exchanges: [],
    rate_limits: usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed })),
    model: tags.model ?? facts.model,
    ...(tags.effort ? { effort: tags.effort } : {}),
    keep_model: tags.model !== undefined || facts.keep_model === true,
    keep_effort: tags.effort !== undefined || tags.ultrathink,
  })
  return answer === null ? { ...fallback, ...own } : { model: facts.model, ...answer, ...own }
}

async function decide($: EngineInterface, s: State, e: TurnStepInput): Promise<Choice> {
  s.to = await link($, s.options)
  if (!s.to) return {}
  const messages = await $.session.messages()
  const people = messages.filter(spoken)
  const current = people.at(-1)
  const text = current?.text ?? ''
  const before = messages.slice(0, current ? messages.lastIndexOf(current) : messages.length)
  const assistant = before.filter((m: SessionMessage) => m.role === 'assistant' && m.text !== '').at(-1)
  const tags = forced(text)
  s.tags = tags
  const model = s.routedModel ?? e.model
  const keepModel = tags.model !== undefined
  const keepEffort = tags.effort !== undefined || tags.ultrathink
  const own: Choice = { ...(tags.model ? { model: tags.model } : {}), ...(tags.effort ? { effort: tags.effort } : {}) }
  const effort = typeof e.effort === 'string' ? e.effort : undefined
  const usage = await $.session.usage()
  const answer = await ask($, s.to, {
    kind: 'main',
    session_id: await $.session.id(),
    message: bounded(text, HEAD, TAIL),
    images_attached: IMAGES.test(text),
    previous_exchanges: people.slice(-3, -1).map(m => bounded(m.text, SHORT_HEAD, SHORT_TAIL)),
    last_assistant_message: bounded(assistant?.text ?? '', SHORT_HEAD, SHORT_TAIL),
    conversation_tokens: usage.context.tokens ?? 0,
    model_cache: await modelCache($, s),
    cache_cold: s.compacted,
    rate_limits: usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed })),
    model: keepModel ? tags.model : model,
    effort,
    keep_model: keepModel,
    keep_effort: keepEffort,
  })
  if (answer === null) {
    // Échec : rien à dire à l'utilisateur ; la ligne d'une décision précédente s'efface.
    $.ui.status(undefined)
    return own
  }
  const choice: Choice = { ...answer, ...own }
  const shownEffort = choice.effort ?? effort
  $.ui.status(`${NAME} : ${family(choice.model ?? model)}${shownEffort ? ` · ${shownEffort}` : ''}`)
  return choice
}

export const register: Register = (on, options) => {
  const s: State = {
    options, queue: queue(options), to: null, routedModel: undefined, turn: {}, tags: NO_TAGS, plans: new Map(),
    pending: new Map(), spawning: 0, loops: new Map(), requested: new Map(), sources: new Map(), lastCall: new Map(),
    compacted: false,
  }

  on('turn.step', async function* ($, e, next) {
    let step: TurnStepInput = e
    try {
      step = await applied($, s, e)
    } catch {
      // Lecture de la session ou appel en échec : réglage gardé.
    }
    const result = yield* next(step)
    try {
      await counted($, s, step, result)
    } catch {
      // Compteur de cette étape perdu ; le tour continue.
    }
    return result
  })

  // Ce que l'agent principal a fixé, et la source de chaque type d'agent : faits
  // pour le journal du service, jamais une raison de ne pas router.
  on('tool.call', { tool: 'Agent' }, ($, e, next) => {
    s.requested.set(e.tool_use_id, { ...(e.model ? { model: e.model } : {}), ...(e.effort ? { effort: e.effort } : {}) })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.offer', ($, e, next) => {
    s.sources.set(e.agent, e.source)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && !result.skip) {
      s.lastCall.clear()
      s.compacted = true
    }
    return result
  }).catch(($, e, next) => next(e))

  // Tout sous-agent passe par le service. Le modèle se pose ici (le moteur le
  // fait passer devant l'appel, la définition et CLAUDE_CODE_SUBAGENT_MODEL ; il
  // l'ignore pour un fork), puis sur chaque étape avec la réflexion. Une reprise
  // ne laisse rien changer ici : elle est décidée à sa première étape.
  on('agent.spawn', async ($, e, next) => {
    if (e.resume) return next(e)
    let plan: Plan = {}
    s.spawning++
    try {
      try {
        plan = await spawned($, s, e)
      } catch {
        // Réglage d'origine gardé.
      }
      s.pending.set(e.prompt, plan)
      const result = await next(!e.fork && plan.model ? { ...e, model: plan.model } : e)
      if (result.deny === undefined && result.agentId !== undefined) started(s, e.prompt, result.agentId, plan)
      return result
    } finally {
      s.spawning--
      s.pending.delete(e.prompt)
      s.requested.delete(e.tool_use_id)
    }
  }).catch(($, e, next) => next(e))

  // Fin d'un tour du fil principal : le lot part, sans retenir la main.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) void flush($, s.queue)
    return result
  }).catch(($, e, next) => next(e))

  // Fin de session : ce qui reste part avant que le processus ne s'arrête.
  on('session.end', async ($, e, next) => {
    await flush($, s.queue)
    return next(e)
  }).catch(($, e, next) => next(e))
}

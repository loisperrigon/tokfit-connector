// Monde simulé sous le connecteur : fichier de configuration, service
// (réponses programmées), conversation, horloge, et tout ce qui se voit à
// l'écran ou s'écrit sur la machine. Aucun réseau, aucun disque.
import type { On, SessionMessage, TurnStepInput, TurnStepResult, TurnUsage } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

export const HOME = '/Users/ana'
export const CONFIG_PATH = `${HOME}/.config/tokfit/config.json`
export const URL = 'https://service.test'
export const KEY = 'ek_' + 'a'.repeat(43)
export const SESSION = '0f8e2a4c-6b1d-4e3f-9a7b-2c5d8e1f4a6b'

// Réponse du service : statut et corps, coupure réseau, ou silence.
export type Reply = { status: number; body?: unknown; text?: string } | 'down' | 'silent'
export type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

export type Options = {
  config?: string | null
  configPath?: string
  env?: Record<string, string>
  route?: (body: Record<string, unknown>) => Reply
  usage?: (body: Record<string, unknown>) => Reply
  messages?: SessionMessage[]
  files?: Record<string, string>
  rateLimits?: { kind: string; percentUsed: number }[]
  // Conversation de chaque sous-agent (par identifiant).
  agentMessages?: Record<string, SessionMessage[]>
  // Sous-agents que la session connaît déjà (repris d'une session précédente).
  listed?: string[]
  // Ce que le moteur fait pendant un lancement, avant d'en rendre l'identifiant.
  whileSpawning?: () => Promise<void>
  // Faux : l'API n'a rien répondu (étape sans compteurs).
  counted?: boolean
}

export type World = {
  clock: MockClock
  sent: Sent[]
  routes: () => Sent[]
  usages: () => Sent[]
  // Étapes telles que le moteur les a reçues (après le connecteur).
  steps: TurnStepInput[]
  // Tout texte non vide montré à l'écran (ligne d'état, journal, bulles, notifications).
  shown: string[]
  // Tout ce que le connecteur écrit sur la machine ou envoie ailleurs qu'au service.
  written: string[]
}

export function config(url: string = URL, key: string = KEY): string {
  return JSON.stringify({ url, key })
}

export function usageOf(model: string, input = 10, read = 50_000, write = 2_000, output = 800): TurnUsage {
  return { model, input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output }
}

export function world(on: On, options: Options = {}): World {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME, ...options.env })
  const files: Record<string, string> = { ...options.files }
  const text = options.config === undefined ? config() : options.config
  if (text !== null) files[options.configPath ?? CONFIG_PATH] = text
  const w: World = {
    clock, sent: [], steps: [], shown: [], written: [],
    routes: () => w.sent.filter(s => s.url.endsWith('/v1/route')),
    usages: () => w.sent.filter(s => s.url.endsWith('/v1/usage')),
  }
  on('fs.read', async ($, e) => {
    const found = files[e.path]
    if (found === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: found }
  })
  on('fs.exists', async ($, e) => ({ value: files[e.path] !== undefined }))
  on('fs.write', async ($, e) => { w.written.push(`fs.write ${JSON.stringify(e)}`); return { value: undefined } })
  on('store.set', async ($, e) => { w.written.push(`store.set ${JSON.stringify(e)}`); return { value: undefined } })
  on('http.fetch', async ($, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    w.sent.push({ url: e.url, headers: e.init?.headers ?? {}, body })
    const answer: (body: Record<string, unknown>) => Reply = e.url.endsWith('/v1/route') ? options.route ?? (() => ({ status: 200, body: { model: null, effort: null } }))
      : e.url.endsWith('/v1/usage') ? options.usage ?? (() => ({ status: 200, body: { recorded: 1 } }))
      : () => ({ status: 404 })
    const reply = answer(body)
    if (reply === 'down') throw new Error('connexion refusée')
    if (reply === 'silent') return new Promise(() => { /* jamais de réponse */ })
    const out = reply.text ?? JSON.stringify(reply.body ?? {})
    return { value: { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: {}, text: out } }
  })
  on('session.id', async () => ({ value: SESSION }))
  on('session.root', async () => ({ value: '/projet' }))
  on('session.messages', async ($, e) => ({ value: e.agentId ? options.agentMessages?.[e.agentId] ?? [] : options.messages ?? [] }))
  const listed = [...options.listed ?? []]
  on('agent.list', async () => ({
    value: listed.map(id => ({ id, description: 'sous-tâche', type: 'general-purpose', status: 'running' as const })),
  }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { tokens: 42_000, window: 200_000 }, rateLimits: options.rateLimits ?? [] },
  }))
  const show = (event: string, text: string | undefined): { value: undefined } => {
    if (text) w.shown.push(`${event} ${text}`)
    return { value: undefined }
  }
  on('ui.status', async ($, e) => show('ui.status', e.text))
  on('ui.log', async ($, e) => show('ui.log', e.text))
  on('ui.toast', async ($, e) => show('ui.toast', e.text))
  on('ui.notify', async ($, e) => { show('ui.notify', e.text); return { deny: 'monde simulé' } })
  on('ui.notice', async ($, e) => show('ui.notice', e.text))
  const refuse = (event: string, e: unknown): { deny: string } => {
    w.written.push(`${event} ${JSON.stringify(e)}`)
    return { deny: 'monde simulé' }
  }
  on('telemetry.log', async ($, e) => refuse('telemetry.log', e))
  on('telemetry.mark', async ($, e) => refuse('telemetry.mark', e))
  on('process.run', async ($, e) => refuse('process.run', e))
  on('turn.step', async function* ($, e) {
    w.steps.push(e)
    const model = e.model.includes('claude-') ? e.model : `claude-${e.model}-5-5`
    const usage = options.counted === false ? null : usageOf(model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: usage ? 'end_turn' : null, usage }
  })
  on('tool.call', async () => ({ deny: 'monde simulé : aucun outil ne tourne' }))
  // Un sous-agent neuf reçoit agent-1, agent-2… ; une reprise garde son identifiant.
  on('agent.spawn', async ($, e) => {
    const agentId = e.resume?.agentId ?? `agent-${listed.length + 1}`
    if (!listed.includes(agentId)) listed.push(agentId)
    await options.whileSpawning?.()
    return { model: e.fork ? e.parentModel : e.model ?? e.parentModel, agentId }
  })
  on('agent.offer', async () => ({ isOffered: true }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))
  on('session.compact', async ($, e) => ({ messages: e.messages }))
  on('prompt.section', async ($, e) => ({ name: e.name, text: e.text }))
  return w
}

// Ce qui s'est affiché d'autre que la ligne d'état d'une décision aboutie.
export function messages(w: World): string[] {
  return w.shown.filter(line => !line.startsWith('ui.status '))
}

export function user(text: string): SessionMessage {
  return { role: 'user', text, toolUses: [] }
}

export function assistant(text: string): SessionMessage {
  return { role: 'assistant', text, toolUses: [] }
}

// Une étape du fil principal (ou d'un sous-agent), lue jusqu'au bout.
export async function step($: Engine, index: number, options: { turnId?: string; model?: string; effort?: TurnStepInput['effort']; agentId?: string } = {}): Promise<TurnStepResult> {
  const stream = $.turn.step({
    turnId: options.turnId ?? 'turn-1', index, model: options.model ?? 'claude-opus-5-5', messageCount: 1 + index,
    ...(options.effort === undefined ? { effort: 'high' as const } : { effort: options.effort }),
    ...(options.agentId ? { agentId: options.agentId } : {}),
  })
  let read = await stream.next()
  while (!read.done) read = await stream.next()
  return read.value
}

// Un tour complet du fil principal : ses étapes puis sa fin.
export async function turn($: Engine, turnId: string, steps: number, model = 'claude-opus-5-5'): Promise<void> {
  for (let index = 0; index < steps; index++) await step($, index, { turnId, model })
  await complete($, turnId)
}

export async function complete($: Engine, turnId: string, agentId?: string): Promise<void> {
  await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer', ...(agentId ? { agentId } : {}) })
}

export type AgentCall = {
  type?: string
  model?: 'sonnet' | 'opus' | 'haiku'
  effort?: 'low' | 'high'
  provider?: string
  fork?: true
  isTeammate?: true
  workflow?: true
  parentAgentId?: string
  parentModel?: string
}

// Appel de l'outil Agent par un modèle (le principal, ou `parentAgentId`), puis
// lancement du sous-agent : rend le modèle sur lequel il démarre.
export async function agent($: Engine, prompt: string, options: AgentCall = {}): Promise<string | undefined> {
  const started = await spawn($, prompt, options)
  return started.model
}

export async function spawn($: Engine, prompt: string, options: AgentCall = {}): Promise<{ model?: string; agentId?: string }> {
  const type = options.type ?? (options.fork ? 'fork' : 'general-purpose')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu-1', description: 'sous-tâche', prompt, subagent_type: type,
    ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}),
    ...(options.parentAgentId ? { agentId: options.parentAgentId } : {}) })
  const provider = options.provider ? { plugin: options.provider, tier: 'user' as const } : { plugin: 'engine', tier: 'core' as const }
  return $.agent.spawn({
    tool_use_id: 'tu-1', prompt, description: 'sous-tâche', subagentType: type, provider,
    parentModel: options.parentModel ?? 'claude-opus-5-5', background: false, fork: options.fork ?? false,
    ...(options.model ? { model: options.model } : {}),
    ...(options.isTeammate ? { isTeammate: true as const } : {}),
    ...(options.workflow ? { workflow: { runId: 'wf_1', agentIndex: 1 } } : {}),
    ...(options.parentAgentId ? { parentAgentId: options.parentAgentId } : {}),
  })
}

export async function end($: Engine): Promise<void> {
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION, resume: { id: SESSION } })
}

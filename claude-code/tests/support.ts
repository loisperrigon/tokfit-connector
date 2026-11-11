// Monde simulé sous le connecteur : fichier de configuration, service
// (réponses programmées), conversation, horloge, et tout ce qui se voit à
// l'écran ou s'écrit sur la machine. Aucun réseau, aucun disque.
import type { AgentSpawnInput, ModelForkResult, PromptComposeSection, SessionContextBreakdown, On, SessionMessage, TurnStepInput, TurnStepResult, TurnUsage } from 'claude-code'
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
  // Outil Bash : sortie de la commande (par défaut, aucun outil ne tourne) ; `error` : l'outil échoue.
  bash?: (command: string) => { stdout: string; stderr?: string } | 'error'
  // Outils Read et Edit : contenu de chaque fichier lu (par défaut, aucun outil ne tourne).
  read?: (path: string) => string
  // Répartition du contexte rendue à `$.session.usage({ breakdown })`.
  breakdown?: SessionContextBreakdown
  // Étape de sous-agent retenue jusqu'à ce que la promesse rendue se résolve ; par défaut, immédiate.
  holdAgent?: (agentId: string) => Promise<void>
  // Compaction au coût : par défaut, ne jamais compacter.
  compact?: (body: Record<string, unknown>) => Reply
  // Refus de `$.session.compact` par le moteur, avec ce message (session sans terminal, tour en cours).
  compactRefused?: string
  // Relance du cache : par défaut, ne jamais relancer.
  warm?: (body: Record<string, unknown>) => Reply
  // Leviers coupés pour la session : par défaut, aucun.
  levers?: (body: Record<string, unknown>) => Reply
  // Réponse de `$.model.fork` (relance du cache) ; par défaut, « ok » sur le cache du fil.
  fork?: () => ModelForkResult
  // Contexte rendu par `$.session.usage()` (tokens) ; par défaut 42 000.
  contextTokens?: () => number
  messages?: SessionMessage[]
  files?: Record<string, string>
  rateLimits?: { kind: string; percentUsed: number }[]
  // Conversation de chaque sous-agent (par identifiant).
  agentMessages?: Record<string, SessionMessage[]>
  // Sous-agents que la session connaît déjà (repris d'une session précédente).
  listed?: string[]
  // Sous-agents rendus par `$.agent.list()` avec leur état ; remplace `listed` pour la liste.
  roster?: { id: string; status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed'; parentId?: string }[]
  // Ce que le moteur fait pendant un lancement, avant d'en rendre l'identifiant.
  whileSpawning?: () => Promise<void>
  // Faux : l'API n'a rien répondu (étape sans compteurs).
  counted?: boolean
  // Version du moteur (`$.session.version()`) ; par défaut une version sans compaction à l'inactivité.
  version?: string
  // Réglages fusionnés (`$.settings.read()`) ; par défaut aucun.
  settings?: Record<string, unknown>
}

export type World = {
  // Fichiers du monde simulé, modifiables en cours de test (l'application hôte les réécrit).
  files: Record<string, string>
  clock: MockClock
  sent: Sent[]
  routes: () => Sent[]
  usages: () => Sent[]
  warms: () => Sent[]
  compacts: () => Sent[]
  leverCalls: () => Sent[]
  // Compactions reçues par le moteur (déclencheur et consignes).
  compactions: { trigger?: string; instructions?: string }[]
  // Lancements de sous-agents tels que le moteur les a reçus.
  spawned: AgentSpawnInput[]
  // Relances `$.model.fork` reçues par le moteur (leur consigne), et leur réflexion demandée.
  forks: string[]
  forkEfforts: (string | undefined)[]
  // Étapes telles que le moteur les a reçues (après le connecteur).
  steps: TurnStepInput[]
  // Tout texte non vide montré à l'écran (ligne d'état, journal, bulles, notifications).
  shown: string[]
  // Tout ce que le connecteur écrit sur la machine ou envoie ailleurs qu'au service.
  written: string[]
}

// Prompt système du moteur dans le monde simulé.
export const CORE_PROMPT: PromptComposeSection[] = [{ id: 'intro', text: 'Tu es Claude Code.', scope: 'shared' }]

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
    files, clock, sent: [], steps: [], shown: [], written: [], spawned: [], forks: [], forkEfforts: [], compactions: [],
    routes: () => w.sent.filter(s => s.url.endsWith('/v1/route')),
    usages: () => w.sent.filter(s => s.url.endsWith('/v1/usage')),
    warms: () => w.sent.filter(s => s.url.endsWith('/v1/warm')),
    compacts: () => w.sent.filter(s => s.url.endsWith('/v1/compact')),
    leverCalls: () => w.sent.filter(s => s.url.endsWith('/v1/levers')),
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
      : e.url.endsWith('/v1/compact') ? options.compact ?? (() => ({ status: 200, body: { compact: false } }))
      : e.url.endsWith('/v1/warm') ? options.warm ?? (() => ({ status: 200, body: { after_s: null } }))
      : e.url.endsWith('/v1/levers') ? options.levers ?? (() => ({ status: 200, body: { off: [] } }))
      : () => ({ status: 404 })
    const reply = answer(body)
    if (reply === 'down') throw new Error('connexion refusée')
    if (reply === 'silent') return new Promise(() => { /* jamais de réponse */ })
    const out = reply.text ?? JSON.stringify(reply.body ?? {})
    return { value: { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: {}, text: out } }
  })
  on('session.id', async () => ({ value: SESSION }))
  on('session.version', async () => {
    const version = options.version ?? '2.1.280'
    return { value: { version, base: version, builtAt: '2026-10-01T00:00:00Z' } }
  })
  on('settings.read', async () => ({ value: options.settings ?? {} }))
  on('session.root', async () => ({ value: '/projet' }))
  on('session.messages', async ($, e) => ({ value: e.agentId ? options.agentMessages?.[e.agentId] ?? [] : options.messages ?? [] }))
  const listed = [...options.listed ?? []]
  on('agent.list', async () => ({
    value: options.roster?.map(agent => ({ description: 'sous-tâche', type: 'general-purpose', ...agent }))
      ?? listed.map(id => ({ id, description: 'sous-tâche', type: 'general-purpose', status: 'running' as const })),
  }))
  on('session.usage', async ($, e) => ({
    value: {
      startedAt: 0, rateLimits: options.rateLimits ?? [],
      context: { tokens: options.contextTokens?.() ?? 42_000, window: 200_000, ...(e?.breakdown && options.breakdown ? { breakdown: options.breakdown } : {}) },
    },
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
    if (e.agentId !== undefined && options.holdAgent) await options.holdAgent(e.agentId)
    const model = e.model.includes('claude-') ? e.model : `claude-${e.model}-5-5`
    const usage = options.counted === false ? null : usageOf(model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: usage ? 'end_turn' : null, usage }
  })
  on('tool.call', async ($, e) => {
    const read = options.read
    if (read && e.tool === 'Read') {
      const text = read(e.file_path)
      return { ref: 1, result: { type: 'text' as const, file: { filePath: e.file_path, content: text, numLines: 1, startLine: 1, totalLines: 1 } }, text }
    }
    if (read && e.tool === 'Edit') return { ref: 1, result: { filePath: e.file_path }, text: 'modifié' }
    const run = options.bash
    if (e.tool !== 'Bash' || !run) return { deny: 'monde simulé : aucun outil ne tourne' }
    const out = run(e.command)
    if (out === 'error') return { isError: true as const, result: 'exit 1', text: 'exit 1' }
    const result = { stdout: out.stdout, stderr: out.stderr ?? '', interrupted: false }
    return { ref: 1, result, text: [result.stdout, result.stderr].filter(Boolean).join('\n') }
  })
  // Un sous-agent neuf reçoit agent-1, agent-2… ; une reprise garde son identifiant.
  on('agent.spawn', async ($, e) => {
    w.spawned.push(e)
    const agentId = e.resume?.agentId ?? `agent-${listed.length + 1}`
    if (!listed.includes(agentId)) listed.push(agentId)
    await options.whileSpawning?.()
    // Lancement par un plugin : le monde simulé ne remplit pas le modèle du parent.
    return { model: (e.fork ? e.parentModel : e.model ?? e.parentModel) ?? 'claude-opus-5-5', agentId }
  })
  on('agent.offer', async () => ({ isOffered: true }))
  on('model.fork', async ($, e) => {
    w.forks.push(e.prompt)
    w.forkEfforts.push(e.effort)
    const usage = { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 300 }
    return { value: options.fork?.() ?? { isAnswered: true as const, text: 'ok', usage } }
  })
  on('prompt.compose', async () => ({ sections: CORE_PROMPT }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))
  on('session.compact', async ($, e) => {
    // Appel d'un plugin : le banc ne passe que ses arguments (ni déclencheur ni messages). C'est lui
    // que le moteur refuse ; la commande /compact, elle, arrive ici avec son déclencheur.
    if (options.compactRefused !== undefined && e.trigger === undefined) throw new Error(options.compactRefused)
    w.compactions.push({ ...(e.trigger ? { trigger: e.trigger } : {}), ...(e.instructions ? { instructions: e.instructions } : {}) })
    return { messages: e.messages ?? [{ role: 'user' as const, text: 'résumé', toolUses: [] }] }
  })
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

// Tour du fil principal interrompu (Échap, ou message tapé pendant le tour).
export async function aborted($: Engine, turnId: string): Promise<void> {
  await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
}

// Message de l'utilisateur ; `during` : identifiant du tour en cours quand il est tapé.
export async function submit($: Engine, text: string, during?: string): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'user' }, ...(during ? { turnId: during } : {}) })
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

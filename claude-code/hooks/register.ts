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
// (service.ts), aucun message d'échec ni raison de la décision hors de
// l'application Open Codex (host.ts : pont, voyant, relais, leviers coupés
// par ses réglages), compteurs remontés par lots (usage.ts), sous-agents tous routés,
// cache gardé au chaud pendant une pause (warm.ts), sorties de commandes
// bruyantes raccourcies (output.ts), réflexion en anglais (section du plan), faits
// des leviers joints aux compteurs (usage.ts), outils intégrés remplacés par le
// noyau Python du plugin quand il est connecté (kernel.ts). Le texte des messages ne part que vers /v1/route : ni
// stocké, ni journalisé, ni affiché (tests/witness.test.ts).
import type { AgentSpawnInput, EngineInterface, PluginOptions, Register, SessionMessage, TurnStepInput, TurnStepResult } from 'claude-code'
import { answered, degradedNote, failed, holding, outage } from './outage'
import type { Outage } from './outage'
import { EFFORTS, TIMEOUT_MS, field, link, post } from './service'
import type { Link } from './service'
import { showNotice } from './trial'
import { add, flush, queue, stepOf } from './usage'
import type { Queue, StepFacts } from './usage'
import { began, ended, modelTime, queued as timed, ran, timing, toolTime } from './timing'
import type { Timing } from './timing'
import { audit } from './audit'
import { compactNow, wanted } from './compact'
import type { Try } from './compact'
import { fanout, launched, queued } from './fanout'
import type { Fanout } from './fanout'
import { shorten } from './output'
import { chosen, holdout, levers } from './experiments'
import type { Holdout } from './experiments'
import { compacted, observed, rereads, stepped } from './rereads'
import type { Rereads } from './rereads'
import { host, report, status } from './host'
import type { Line, RouteReport, Seen } from './host'
import { animate, badge, refresh } from './badge'
import { band } from './band'
import { health, notice as healthNotice, refreshed } from './python'
import type { Health } from './python'
import type { Badge } from './badge'
import { awake, back, cancel, rest, waited, warm } from './warm'
import { REFUSED, twin } from './single'
import { plans, section, sessionPlan } from './plan'
import { carried, prefix, taken } from './prefix'
import type { Prefix } from './prefix'
import type { KernelPlan, Plans, PrefixPlan, SessionPlan } from './plan'
import type { Warm } from './warm'
import { called, composed, contradicts, finalAnswer, isAccountTool, isBehind, isDenied, isKernelTool, kernel, kernelFacts, kernelReady, passed, placed, refused, refusedFinish, searchable, shortened, summaryOf, unlisted, withAgent } from './kernel'
import { languageRefusal } from './language'
import type { Kernel } from './kernel'
import { access } from './access'
import { notice, planNotice } from './state'
import type { Notice } from './state'

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type Choice = { model?: string; effort?: Effort }
type Facts = Record<string, unknown>

const MODELS: readonly string[] = ['sonnet', 'opus', 'haiku', 'fable']
// Outils qui modifient un fichier : leur nombre au tour précédent dit au service ce que ce tour a demandé.
const EDITS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
// Début de la demande qui a ouvert la conversation (FIRST_MESSAGE_HEAD du service).
const FIRST_HEAD = 600
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

// `CLAUDE_CODE_DISABLE_ULTRATHINK` (Claude Code 2.1.316) ôte son effet au mot.
const ON = /^(1|true|yes|on)$/i

async function ultrathinkOff($: EngineInterface): Promise<boolean> {
  return ON.test((await $.env.get('CLAUDE_CODE_DISABLE_ULTRATHINK'))?.trim() ?? '')
}

// Couches des réglages, de la plus forte à la plus faible (`$.settings.read({ source })`).
const LAYERS = ['policy', 'flag', 'local', 'project', 'user'] as const
type Layer = { source: (typeof LAYERS)[number]; settings: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function effortOf(level: unknown): Effort | undefined {
  const name = typeof level === 'string' ? level.trim().toLowerCase() : ''
  return EFFORTS.includes(name) ? (name as Effort) : undefined
}

// Nom de modèle comparé aux clés de `modelSettings` : sans casse ni suffixe de fenêtre (`[1m]`).
function modelKey(model: string): string {
  return model.trim().toLowerCase().replace(/\[\d+m\]$/, '')
}

// Effort de l'entrée de `model` dans les `modelSettings` d'une couche ; une clé écrite exactement
// passe devant une clé qui n'en diffère que par la casse ou le suffixe de fenêtre.
function modelEffort(settings: Record<string, unknown>, model: string): Effort | undefined {
  const table = settings.modelSettings
  if (!isRecord(table)) return undefined
  const wanted = modelKey(model)
  let found: Effort | undefined
  for (const [key, entry] of Object.entries(table)) {
    if (modelKey(key) !== wanted || !isRecord(entry)) continue
    const level = effortOf(entry.effortLevel)
    if (level === undefined) continue
    if (key === wanted) return level
    found ??= level
  }
  return found
}

// Réglages couche par couche ; un moteur qui refuse la lecture par couche rend sa fusion, lue
// comme la couche de l'utilisateur.
async function layers($: EngineInterface): Promise<Layer[]> {
  let read: unknown[]
  try {
    read = await Promise.all(LAYERS.map(source => $.settings.read({ source })))
  } catch {
    const merged: unknown = await $.settings.read()
    return isRecord(merged) ? [{ source: 'user', settings: merged }] : []
  }
  return LAYERS.flatMap((source, i) => {
    const settings = read[i]
    return isRecord(settings) ? [{ source, settings }] : []
  })
}

// Effort que l'utilisateur a réglé lui-même pour `model`, le modèle de la session, résolu comme le
// moteur : `CLAUDE_CODE_EFFORT_LEVEL` (qui passe devant les réglages ; `auto` ou `unset` : aucun),
// sinon, de la couche la plus forte à la plus faible, l'entrée de ce modèle dans `modelSettings`
// (où `/effort` range son choix) puis l'`effortLevel` d'une couche autre que celle de
// l'utilisateur ; enfin l'`effortLevel` de l'utilisateur. Le défaut du modèle n'en est pas un.
// `--effort` n'est lisible nulle part dans l'API des hooks : il n'est pas un plancher, le moteur
// le garde seul tant que rien ne l'a réécrit.
async function effortFloor($: EngineInterface, model: string | undefined): Promise<Effort | undefined> {
  const named = (await $.env.get('CLAUDE_CODE_EFFORT_LEVEL'))?.trim().toLowerCase() ?? ''
  if (named !== '') return effortOf(named)
  let found: Layer[]
  try {
    found = await layers($)
  } catch {
    // Réglages illisibles : pas de plancher.
    return undefined
  }
  for (const { source, settings } of found) {
    const level = (model === undefined ? undefined : modelEffort(settings, model))
      ?? (source === 'user' ? undefined : effortOf(settings.effortLevel))
    if (level !== undefined) return level
  }
  return effortOf(found.find(layer => layer.source === 'user')?.settings.effortLevel)
}

function forced(text: string, ultrathinkWorks: boolean): Tags {
  const out: Tags = { ultrathink: ultrathinkWorks && /\bultrathink\b/i.test(text) }
  for (const tag of text.matchAll(/\[(\w+)\]/g)) {
    const word = (tag[1] ?? '').toLowerCase()
    if (EFFORTS.includes(word)) out.effort = word as Effort
    if (MODELS.includes(word)) out.model = word
  }
  return out
}

// Décision du service sous les choix de l'utilisateur : ses balises passent
// devant, et une réflexion qu'il garde (balise, ultrathink) n'est jamais remplacée.
// Sauf réglage imposé par une limite du compte (`enforced` : la réponse porte
// `notice`) : ce que le service pose passe alors devant les balises.
// `floor` : effort réglé par l'utilisateur, plancher de ce que le service propose et de l'effort
// en cours (`current`) ; une balise ou ultrathink du message, plus précis, passent devant, et une
// limite du compte (`enforced`) devant tout : le service a déjà tenu compte du plancher.
function underUser(answer: Choice, own: Choice, keepEffort: boolean, enforced = false, floor?: Effort, current?: string): Choice {
  const { effort, ...rest } = answer
  const chosen = { ...rest, ...(effort && !keepEffort ? { effort } : {}), ...own }
  if (enforced) return { ...chosen, ...answer }
  const level = chosen.effort ?? current
  const under = !keepEffort && floor !== undefined && level !== undefined && EFFORTS.includes(level)
    && EFFORTS.indexOf(level) < EFFORTS.indexOf(floor)
  return under ? { ...chosen, effort: floor } : chosen
}

function family(model: string): string {
  return MODELS.find(name => model.toLowerCase().includes(name)) ?? model
}

// Modèle que le service peut rendre : un alias ou un identifiant complet
// (`claude-sonnet-5-5`, `claude-opus-5-5[1m]`) ; un nouveau modèle ne demande
// pas de nouvelle version du connecteur.
const MODEL_ID = /^(sonnet|opus|haiku|fable|claude-[a-z0-9.-]{1,60}(\[1m\])?)$/

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
  // Messages tapés pendant un tour du fil principal (`prompt.submit` avec le
  // `turnId` du tour en cours), oubliés à la fin d'un tour qui n'est pas interrompu.
  steered: Set<string>
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
  // tokens il a laissés dans le cache (fait transmis au service).
  lastCall: Map<string, { at: number; tokens: number }>
  // Vrai après une compaction du fil principal, jusqu'à sa prochaine réponse.
  compacted: boolean
  // Relances du cache du fil principal pendant une pause (warm.ts).
  warm: Warm
  // Contexte de départ déjà remonté pour cette session (audit.ts).
  audited: boolean
  // Premières étapes des sous-agents lancés ensemble (fanout.ts).
  fanout: Fanout
  // Faits des leviers en attente de l'étape qu'ils touchent : caractères retirés
  // des sorties d'outils par boucle (`main` ou identifiant d'agent), contexte
  // avant la dernière compaction du connecteur.
  trimmed: Map<string, number>
  compactedFrom: number | undefined
  // Issue de la dernière compaction voulue par le service, en attente de l'étape suivante du fil.
  compactTry: Try | undefined
  // La consigne de réflexion joue sur la conversation, selon le service (`lean_thinking` de /v1/route).
  lean: boolean
  // Sections du prompt système passées dans le contexte du premier message (prefix.ts).
  prefix: Prefix
  // Fichiers relus après une compaction du connecteur (rereads.ts).
  rereads: Rereads
  // Message du plan de session absent, déjà montré ou non (state.ts).
  noticed: Notice
  // Leviers coupés pour cette session (experiments.ts), et leur dernière liste lue.
  holdout: Holdout
  off: ReadonlySet<string>
  // Application hôte (Open Codex) : lue une fois (host.ts).
  seen: Seen
  // Ligne d'état (host.ts) ; bilan relu pour le bandeau du gain (badge.ts).
  line: Line
  badge: Badge
  // Santé de l'outil `agir` (python.ts) : raison de son absence, montrée au-dessus de la saisie.
  health: Health
  // Panne du service vue par le routage (outage.ts) : demandes suspendues, bandeau « tokfit dégradé ».
  outage: Outage
  // Étapes du fil principal depuis le dernier message de la personne (tours de
  // notification compris) : dit au service qu'un long travail est en cours.
  workSteps: number
  // Fichiers modifiés par le fil principal depuis ce même message.
  workEdits: number
  // Modèle que l'utilisateur a choisi pour la session (celui du moteur, hors routage),
  // transmis au service (`session_model`, `reference_model`).
  sessionModel: string | undefined
  // Routage coupé par l'utilisateur ou son application (experiments.ts, `chosen`) : avec une
  // balise de modèle, c'est un modèle fixé, dont les étapes sont hors mesure (`pinned`).
  cut: boolean
  // Levier kernel : outil `python` vu connecté, compteurs, invalidation du cache (kernel.ts).
  kernel: Kernel
  // Durées des étapes, des outils et des tours, jointes aux compteurs (timing.ts).
  timing: Timing
  // Plan de session reçu du service (plan.ts) : sans lui, les leviers qui en dépendent restent inactifs.
  content: Plans
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

// Refus de langue d'un résumé de `finish` (language.ts) : comparé au dernier message de la personne, langue admise
// si elle figure dans un de ses messages précédents. Rien après une commande slash : le texte développé est celui de
// la commande ou de la skill, pas celui de la personne (dont le CLAUDE.md peut demander une autre langue).
const SLASH_COMMAND = /<command-name>/

async function otherLanguage($: EngineInterface, summary: string): Promise<string | undefined> {
  const said = (await $.session.messages()).filter(spoken)
  const request = said.at(-1)
  if (request === undefined || said.slice(-2).some(m => SLASH_COMMAND.test(m.text))) return undefined
  return languageRefusal(request.text, summary, said.slice(0, -1).map(m => m.text))
}

async function notified($: EngineInterface): Promise<boolean> {
  try {
    const last = (await $.session.messages()).filter(m => m.role === 'user' && m.text !== '' && !m.toolResults?.length).at(-1)
    return last !== undefined && NOTIFICATION.test(last.text)
  } catch {
    return false
  }
}

// Message tapé pendant un tour en cours : Claude Code interrompt l'étape
// (`turn.complete` « aborted ») et relance le travail par un nouveau tour qui
// porte ce seul message. C'est la suite du même tour : modèle et réflexion
// restent, sans nouvelle demande au service.
async function continued($: EngineInterface, s: State): Promise<boolean> {
  if (s.steered.size === 0) return false
  const typed = [...s.steered]
  s.steered.clear()
  try {
    const last = (await $.session.messages()).filter(spoken).at(-1)
    return last !== undefined && typed.some(text => last.text.includes(text))
  } catch {
    // Session illisible : le message est traité comme une nouvelle demande.
    return false
  }
}

async function applied($: EngineInterface, s: State, e: TurnStepInput): Promise<TurnStepInput> {
  if (e.agentId === undefined && e.index === 0) s.sessionModel = e.model
  // Routage coupé par l'application hôte : ni décision ni balise, réglage du moteur.
  s.cut = (await chosen($, s.holdout)).has('routing')
  if (s.cut) return e
  if (e.agentId !== undefined) return withPlan(e, await agentPlan($, s, e, e.agentId))
  if (e.index === 0 && !(await notified($)) && !(await continued($, s))) {
    s.turn = {}
    s.tags = NO_TAGS
    try {
      s.turn = await decide($, s, e)
    } catch {
      // Session illisible : le modèle déjà choisi reste (pas de cache réécrit).
    }
    if (s.turn.model) s.routedModel = s.turn.model
    s.workSteps = 0
    s.workEdits = 0
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

// Fin de l'appel précédent de la même boucle sur la famille de `model` : de là
// au début de l'étape, le cache a vieilli (undefined au premier appel).
function previousCall(s: State, step: TurnStepInput): number | undefined {
  const name = family(step.model)
  if (step.agentId === undefined) return s.lastCall.get(name)?.at
  const loop = s.loops.get(step.agentId)
  return loop && family(loop.model) === name ? loop.at : undefined
}

// Une relance a relu le cache du fil (warm.ts) : son âge repart de là, sa taille reste celle du fil.
function pinged(s: State): void {
  const at = s.warm.pingedAt
  const main = s.warm.main
  s.warm.pingedAt = undefined
  if (at === undefined || !main) return
  const call = s.lastCall.get(family(main.model))
  if (call) s.lastCall.set(family(main.model), { ...call, at })
}

// Faits des leviers pour l'étape : ceux pris avant elle, plus ceux qui l'attendaient.
function leverFacts(s: State, step: TurnStepInput, before: StepFacts): StepFacts {
  const loop = step.agentId ?? 'main'
  const trimmed = s.trimmed.get(loop)
  s.trimmed.delete(loop)
  const main = step.agentId === undefined
  const compactedFrom = main ? s.compactedFrom : undefined
  if (main) s.compactedFrom = undefined
  const reread = main ? stepped(s.rereads) : undefined
  const tried = main ? s.compactTry : undefined
  if (main) s.compactTry = undefined
  return {
    ...before, ...(trimmed ? { trimmed_chars: trimmed } : {}), ...(compactedFrom !== undefined ? { compacted_from: compactedFrom } : {}),
    ...(tried !== undefined ? { compact_try: tried } : {}),
    ...(reread !== undefined ? { reread_chars: reread } : {}),
    ...(s.lean && !s.off.has('thinking') ? { lean_thinking: true as const } : {}),
    // Modèle fixé par l'utilisateur, pour ce message et les sous-agents qu'il lance : hors mesure.
    // Une session témoin (routage coupé par le tirage du service) ne l'est pas.
    ...(s.cut || s.tags.model !== undefined ? { pinned: true as const } : {}),
    ...kernelFacts(s.kernel, step.agentId),
  }
}

// Après la réponse : mémoire du cache (fil principal et sous-agents) et compteurs de l'étape.
async function counted($: EngineInterface, s: State, step: TurnStepInput, result: TurnStepResult,
                       idleS: number | undefined, before: StepFacts): Promise<void> {
  const usage = result.usage
  if (!usage) return
  const name = family(usage.model)
  const tokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
  const at = await $.clock.now()
  const levers = leverFacts(s, step, before)
  if (step.agentId !== undefined) {
    s.loops.set(step.agentId, { turnId: result.turnId, at, tokens, model: usage.model })
  } else {
    s.warm.main = { model: usage.model, effort: step.effort }
    if (MODELS.includes(name)) {
      s.lastCall.set(name, { at, tokens })
      s.compacted = false
    }
  }
  if (!s.to) return
  const limits = (await $.session.usage()).rateLimits
  const cache = { subagent: step.agentId !== undefined, idleS }
  // Les étapes se comparent au modèle que l'utilisateur a choisi pour sa session.
  const reference = s.sessionModel !== undefined ? { reference_model: s.sessionModel } : {}
  const counters = await stepOf(await $.session.id(), step.agentId, result.turnId, result.index, step.effort, usage, limits,
    cache, { ...levers, ...reference })
  if (step.agentId === undefined) timed(s.timing, result.turnId, counters)
  if (add(s.queue, counters)) void flush($, s.queue)
}

function chars(record: { stdout: string; stderr: string }): number {
  return record.stdout.length + record.stderr.length
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

async function ask($: EngineInterface, to: Link, facts: Facts, o: Outage): Promise<{ choice: Choice; enforced: boolean } | null> {
  const answer = await asked($, to, facts, o)
  return answer.state === 'ok' ? { choice: answer.choice, enforced: answer.enforced === true } : null
}

// Issue d'une demande, pour le voyant d'une application hôte (host.ts) : la
// décision et sa raison (rendue aux seuls clients qui la reçoivent), ou la
// cause d'un échec. Hors application hôte, seule la décision sert.
// `lean` : le service dit si la consigne de réflexion joue sur ce message (absent : il ne sait pas).
// `enforced` : une limite du compte a changé le réglage ; sa phrase (`notice`) est montrée une fois (trial.ts).
type Asked = { state: 'ok'; choice: Choice; reason: string; lean?: boolean; enforced?: true }
  | { state: 'failing' | 'not_configured'; reason: string }

async function asked($: EngineInterface, to: Link, facts: Facts, o: Outage): Promise<Asked> {
  const started = await $.clock.now()
  // Service muet tout à l'heure : le message part sans attendre (outage.ts).
  if (holding(o, started)) return { state: 'failing', reason: 'service injoignable (demande suspendue)' }
  const reply = await post($, to, '/v1/route', facts, TIMEOUT_MS)
  if (reply === null) {
    const late = (await $.clock.now()) - started >= TIMEOUT_MS
    failed(o, await $.clock.now(), late)
    return { state: 'failing', reason: late ? `délai dépassé (${TIMEOUT_MS / 1000} s)` : 'service injoignable' }
  }
  // 502 à 504 sans corps du service (relais frontal, service arrêté derrière) : panne ; sinon le service a répondu.
  if (reply.status >= 502 && reply.status <= 504 && field(reply.text, 'error') === undefined) failed(o, await $.clock.now(), false)
  else answered(o)
  const error = field(reply.text, 'error')
  const detail = typeof error === 'string' && error !== '' ? ` : ${error.slice(0, 160)}` : ''
  if (reply.status === 503) return { state: 'not_configured', reason: `service ${reply.status}${detail}` }
  if (reply.status !== 200) return { state: 'failing', reason: `service ${reply.status}${detail}` }
  const choice = decision(reply.text)
  if (choice === null) return { state: 'failing', reason: 'réponse illisible' }
  const reason = field(reply.text, 'reason')
  const lean = field(reply.text, 'lean_thinking')
  const enforced = typeof field(reply.text, 'notice') === 'string'
  if (enforced) showNotice($, reply.text)
  return {
    state: 'ok', choice, reason: typeof reason === 'string' ? reason.slice(0, 300) : '',
    ...(typeof lean === 'boolean' ? { lean } : {}), ...(enforced ? { enforced: true as const } : {}),
  }
}

// Lancement d'un sous-agent, quel qu'il soit (appel du modèle, définition,
// plugin, workflow, coéquipier, fork) : le service décide.
async function spawned($: EngineInterface, s: State, e: AgentSpawnInput): Promise<Plan> {
  if ((await chosen($, s.holdout)).has('routing')) return {}
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
  const floor = await effortFloor($, s.sessionModel)
  const answer = await ask($, to, {
    kind: 'subagent',
    ...facts,
    session_id: await $.session.id(),
    message: bounded(facts.message, HEAD, TAIL),
    last_assistant_message: bounded(facts.last_assistant_message ?? '', SHORT_HEAD, SHORT_TAIL),
    images_attached: false,
    previous_exchanges: [],
    rate_limits: usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed })),
    ...(s.sessionModel ? { session_model: s.sessionModel } : {}),
    model: tags.model ?? facts.model,
    ...(tags.effort ? { effort: tags.effort } : {}),
    ...(floor ? { min_effort: floor } : {}),
    keep_model: tags.model !== undefined || facts.keep_model === true,
    keep_effort: tags.effort !== undefined || tags.ultrathink,
  }, s.outage)
  return answer === null ? { ...fallback, ...own }
    : { model: facts.model, ...underUser(answer.choice, own, tags.effort !== undefined || tags.ultrathink, answer.enforced, floor) }
}

// Un coéquipier `idle` attend un message : il ne travaille pas.
const ACTIVE: ReadonlySet<string> = new Set(['pending', 'running', 'waiting'])

// Sous-agents lancés par le fil principal qui travaillent encore : leurs
// résultats reviendront à ce fil, qui devra les vérifier et les intégrer.
async function running($: EngineInterface): Promise<number> {
  try {
    return (await $.agent.list()).filter(agent => ACTIVE.has(agent.status) && agent.parentId === undefined).length
  } catch {
    // Liste illisible : le fait manque au service, rien d'autre.
    return 0
  }
}

async function decide($: EngineInterface, s: State, e: TurnStepInput): Promise<Choice> {
  s.to = await link($, s.options)
  if (!s.to) {
    s.lean = false
    return {}
  }
  const messages = await $.session.messages()
  const people = messages.filter(spoken)
  const current = people.at(-1)
  const text = current?.text ?? ''
  const before = messages.slice(0, current ? messages.lastIndexOf(current) : messages.length)
  const assistant = before.filter((m: SessionMessage) => m.role === 'assistant' && m.text !== '').at(-1)
  const tags = forced(text, !(await ultrathinkOff($)))
  s.tags = tags
  const model = s.routedModel ?? e.model
  const keepModel = tags.model !== undefined
  const keepEffort = tags.effort !== undefined || tags.ultrathink
  const own: Choice = { ...(tags.model ? { model: tags.model } : {}), ...(tags.effort ? { effort: tags.effort } : {}) }
  const effort = typeof e.effort === 'string' ? e.effort : undefined
  const floor = await effortFloor($, e.model)
  const usage = await $.session.usage()
  // Choix entier de l'utilisateur : le voyant de l'application hôte ne bouge pas.
  const shown = !(keepModel && keepEffort)
  const told = (route: RouteReport): void => { if (shown) void report($, s.seen, route) }
  told({ state: 'pending' })
  const answer = await asked($, s.to, {
    kind: 'main',
    session_id: await $.session.id(),
    message: bounded(text, HEAD, TAIL),
    images_attached: IMAGES.test(text),
    previous_exchanges: people.slice(-3, -1).map(m => bounded(m.text, SHORT_HEAD, SHORT_TAIL)),
    last_assistant_message: bounded(assistant?.text ?? '', SHORT_HEAD, SHORT_TAIL),
    conversation_tokens: usage.context.tokens ?? 0,
    agents_running: await running($),
    steps_since_last_message: s.workSteps,
    last_turn_edits: s.workEdits,
    session_model: e.model,
    first_message: people.length > 1 ? (people[0]?.text ?? '').slice(0, FIRST_HEAD) : '',
    model_cache: await modelCache($, s),
    cache_cold: s.compacted,
    rate_limits: usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed })),
    model: keepModel ? tags.model : model,
    effort,
    ...(floor ? { min_effort: floor } : {}),
    keep_model: keepModel,
    keep_effort: keepEffort,
  }, s.outage)
  if (answer.state !== 'ok') {
    // Échec : rien à dire à l'utilisateur ; la ligne d'une décision précédente s'efface.
    // Une application hôte, elle, montre la cause dans son voyant.
    s.line.route = undefined
    await status($, s.seen, s.line)
    told(answer)
    return own
  }
  if (answer.lean !== undefined) s.lean = answer.lean
  const choice = underUser(answer.choice, own, keepEffort, answer.enforced, floor, effort)
  const shownEffort = choice.effort ?? effort
  // Claude Code préfixe déjà la ligne du nom du plugin.
  s.line.route = `${family(choice.model ?? model)}${shownEffort ? ` · ${shownEffort}` : ''}`
  await status($, s.seen, s.line)
  told({ state: 'ok', model: family(choice.model ?? model), effort: shownEffort ?? '', reason: answer.reason })
  return choice
}

// Le cache de la conversation est neuf : plus rien de connu par modèle.
function cooled(s: State): void {
  s.lastCall.clear()
  s.compacted = true
}

// Plan de session du client relié au service ; null sans lien ni plan.
async function planned($: EngineInterface, s: State): Promise<SessionPlan | null> {
  const to = await link($, s.options)
  return to ? sessionPlan($, s.content, to) : null
}

// Plan du levier kernel s'il est actif : client relié au service, levier non coupé (témoin
// du service, application hôte, TOKFIT_OFF), présent dans le plan, et outil `python`
// connecté ; sinon null et rien ne change.
async function kernelOn($: EngineInterface, s: State): Promise<KernelPlan | null> {
  const to = await link($, s.options)
  if (!to || (await levers($, s.holdout, to)).has('kernel')) return null
  const plan = (await sessionPlan($, s.content, to))?.kernel
  return plan && (await kernelReady($, s.kernel)) ? plan : null
}

// Plan du levier prefix s'il est actif : client relié au service, levier non coupé, présent dans le plan.
async function prefixOn($: EngineInterface, s: State): Promise<PrefixPlan | null> {
  const to = await link($, s.options)
  if (!to || (await levers($, s.holdout, to)).has('prefix')) return null
  return (await sessionPlan($, s.content, to))?.prefix ?? null
}

// Pause après un tour du fil principal : compaction si le service la veut, après l'absence
// qu'il rend, puis relances du cache. Les consignes viennent du plan de session ; l'issue
// de la compaction part avec l'étape suivante du fil (`compact_try`). Ne lève jamais.
// Bandeau du gain (badge.ts) relu après un tour du fil principal ; jamais levé.
async function shown($: EngineInterface, s: State): Promise<void> {
  try {
    const to = await link($, s.options)
    if (!to) return
    const gain = await refresh($, s.badge, to, await $.clock.now())
    if (gain === null || (gain?.saved === s.badge.gain?.saved && gain?.seconds === s.badge.gain?.seconds)) return
    animate($, s.badge, gain, await $.clock.now())
  } catch {
    // Service ou horloge illisible : la marque garde sa valeur.
  }
}

async function paused($: EngineInterface, s: State): Promise<void> {
  const generation = s.warm.generation
  const idle = (): boolean => s.warm.generation === generation
  let ping: string | undefined
  try {
    const to = await link($, s.options)
    if (to && !s.audited) {
      s.audited = true
      await audit($, to)
    }
    const plan = to ? await sessionPlan($, s.content, to) : null
    ping = plan?.warm
    const instructions = plan?.compaction
    const off = to ? await levers($, s.holdout, to) : new Set<string>()
    const model = s.warm.main?.model
    const after = to && model && instructions !== undefined && !off.has('compaction')
      ? await wanted($, to, model, (await host($, s.seen)) !== null) : null
    if (after !== null && instructions !== undefined) {
      s.compactTry = 'back'
      if ((await waited($, s.warm, after)) && idle()) {
        const before = (await $.session.usage()).context.tokens
        s.compactTry = await compactNow($, idle, instructions)
        if (s.compactTry === 'done') {
          cooled(s)
          compacted(s.rereads)
          if (before !== null && before !== undefined) s.compactedFrom = before
        }
      }
    }
  } catch {
    // Service en panne ou session illisible : conversation entière.
  }
  // L'utilisateur est revenu pendant l'attente : son tour relancera la pause.
  if (idle() && ping !== undefined && !s.off.has('warm')) await rest($, s.warm, s.options, s.queue, ping)
  // Sans relance après la compaction : plus rien de prévu (warm.ts, `awake`).
  else if (idle()) await awake($, s.warm, null)
}

export const register: Register = (on, options) => {
  const s: State = {
    options, queue: queue(options), to: null, routedModel: undefined, turn: {}, steered: new Set(), tags: NO_TAGS, plans: new Map(),
    pending: new Map(), spawning: 0, loops: new Map(), requested: new Map(), sources: new Map(), lastCall: new Map(),
    compacted: false, warm: warm(), audited: false, fanout: fanout(), trimmed: new Map(), compactedFrom: undefined,
    compactTry: undefined, lean: false, prefix: prefix(),
    rereads: rereads(), holdout: holdout(), off: new Set(), seen: {}, line: {}, badge: badge(), workSteps: 0, workEdits: 0, sessionModel: undefined,
    cut: false, kernel: kernel(), content: plans(), timing: timing(), noticed: notice(), health: health(), outage: outage(),
  }

  // Essai sans inscription : clé anonyme dès le démarrage, commande du tableau de bord et de
  // l'état des leviers (access.ts, state.ts).
  access(on, options, { holdout: s.holdout, content: s.content, kernel: s.kernel, health: s.health })

  // Une autre copie du connecteur sur le point de se charger : refusée (single.ts).
  // En cas d'échec du jugement, elle se charge : jamais de blocage par le connecteur.
  on('plugin.register', ($, e, next) => (twin({ name: $.plugin.name, root: $.plugin.root }, e) ? { refuse: REFUSED } : next(e)))
    .catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    // Levier kernel : la cellule précédente du fil principal a appelé `fini(resume)`.
    // L'étape suivante du même tour rend ce résumé sans requête au modèle : le tour
    // s'arrête, le résumé est son dernier message (kernel.ts). Une première étape
    // (nouveau tour, l'utilisateur a interrompu le précédent) n'hérite de rien.
    if (e.agentId === undefined) {
      const summary = s.kernel.summary
      s.kernel.summary = undefined
      if (e.index === 0) s.kernel.languageAsked = false
      s.kernel.stopped = summary !== undefined && e.index > 0
      if (summary !== undefined && e.index > 0) {
        const answer = finalAnswer(e.turnId, e.index, summary)
        for (const chunk of answer.chunks) yield chunk
        return answer.result
      }
    }
    const before: StepFacts = {}
    try {
      const now = await $.clock.now()
      if (e.agentId === undefined && e.index === 0) began(s.timing, now)
      Object.assign(before, toolTime(s.timing, e.agentId ?? 'main'))
    } catch {
      // Horloge illisible : les durées manquent, rien d'autre.
    }
    if (e.agentId === undefined) {
      cancel(s.warm)
      pinged(s)
      try {
        if (e.index === 0) Object.assign(before, await back($, s.warm))
      } catch {
        // Horloge illisible : le fait manque au levier, rien d'autre.
      }
    }
    let plan: SessionPlan | null = null
    try {
      // Le lien se pose ici, à chaque étape : les compteurs remontent même quand aucune
      // décision n'est demandée (routage coupé), sinon l'étape manquerait au service.
      s.to = await link($, s.options)
      const to = s.to
      ;[s.off, plan] = to ? await Promise.all([levers($, s.holdout, to), sessionPlan($, s.content, to)]) : [new Set<string>(), null]
    } catch {
      // Liste ou plan illisible : leviers coupés gardés, leviers du plan inactifs.
    }
    passed(s.kernel)
    try {
      // Client relié sans plan de session : leviers du plan inactifs, dit au service et à la personne.
      const missing = s.content.missing
      if (s.to && plan === null && missing !== undefined) {
        before.plan_missing = missing
        planNotice($, s.noticed, missing)
      }
    } catch {
      // Ligne de la conversation refusée : le fait part quand même.
    }
    try {
      // Levier voulu mais noyau absent : rien n'a été retiré, le service le sait par l'étape, avec la raison
      // (python.ts : Python en cours d'installation, absent, serveur arrêté…).
      if (s.to && plan?.kernel && !s.off.has('kernel') && !(await kernelReady($, s.kernel))) {
        before.kernel_unavailable = true
        // Dernier diagnostic (relu au démarrage, puis à intervalles) : rien n'est attendu sur le chemin de l'étape.
        const why = s.health.diagnosis
        void refreshed($, s.health, true)
        if (why) {
          before.kernel_reason = why.reason
          if (why.detail) before.kernel_detail = why.detail
        }
      }
    } catch {
      // Liste des outils illisible : le fait manque au levier, rien d'autre.
    }
    let step: TurnStepInput = e
    try {
      step = await applied($, s, e)
    } catch {
      // Lecture de la session ou appel en échec : réglage gardé.
    }
    if (e.agentId === undefined) s.workSteps++
    // Premier pas d'un sous-agent lancé avec d'autres du même type : après le premier.
    let lead = (): void => undefined
    try {
      const wait = plan?.fanout
      if (step.agentId !== undefined && step.index === 0 && s.to && wait !== undefined && !s.off.has('fanout')) {
        const turn = await queued($, s.fanout, step.agentId, wait)
        lead = turn.release
        if (turn.waited) before.fanout = true
      }
    } catch {
      // Horloge en échec : l'étape part sans attendre.
    }
    // Âge du cache au départ de la requête (secondes), pris avant qu'elle ne parte.
    let idleS: number | undefined
    try {
      const at = previousCall(s, step)
      idleS = at === undefined ? undefined : idle(await $.clock.now(), at)
    } catch {
      // Horloge illisible : l'écart manque au compteur, rien d'autre.
    }
    let result: TurnStepResult
    let sent: number | undefined
    try {
      sent = await $.clock.now()
    } catch {
      // Horloge illisible : l'attente du modèle manque, rien d'autre.
    }
    try {
      result = yield* next(step)
    } finally {
      lead()
    }
    try {
      if (sent !== undefined) Object.assign(before, modelTime(sent, await $.clock.now()))
    } catch {
      // Horloge illisible : l'attente du modèle manque, rien d'autre.
    }
    try {
      await counted($, s, step, result, idleS, before)
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

  // Sortie d'une commande bruyante raccourcie (output.ts), pour un client relié
  // au service seulement ; une erreur de l'outil passe telle quelle. Pas de
  // `.catch` qui rappellerait `next` : la commande tournerait deux fois.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.deny !== undefined || result.isError || s.off.has('output')) return result
      const rules = (await planned($, s))?.output
      if (!rules) return result
      const short = shorten(e.command, result.result, rules)
      if (!short) return result
      const removed = chars(result.result) - chars(short.record)
      const loop = e.agentId ?? 'main'
      if (removed > 0) s.trimmed.set(loop, (s.trimmed.get(loop) ?? 0) + removed)
      return { result: short.record, ...(short.note ? { context: [...result.context ?? [], short.note] } : {}) }
    } catch {
      // Sortie illisible : rendue telle quelle.
      return result
    }
  })

  // Sections du plan de session en fin de prompt système (réflexion, persistance, et pour un client admin
  // la consigne de retour, sans témoin), et consigne du noyau à la place de la section que le plan désigne ;
  // client relié au service seulement.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    try {
      const to = await link($, s.options)
      if (!to) return result
      const [off, plan] = await Promise.all([levers($, s.holdout, to), sessionPlan($, s.content, to)])
      if (!plan) return result
      const kernelPlan = !off.has('kernel') && plan.kernel && (await kernelReady($, s.kernel)) ? plan.kernel : undefined
      const sections = kernelPlan ? composed(result.sections, kernelPlan) : result.sections
      return { sections: [...sections,
        ...(plan.thinking !== undefined && !off.has('thinking') ? [section('thinking', plan.thinking)] : []),
        ...(plan.persistence !== undefined && !off.has('persistence') ? [section('execution', plan.persistence)] : []),
        ...(plan.feedback !== undefined ? [section('feedback', plan.feedback)] : [])] }
    } catch {
      // Configuration illisible : prompt inchangé.
      return result
    }
  })

  // Fichiers lus et modifiés par le fil principal (rereads.ts) : chemins en mémoire seulement.
  // Appels de `python` comptés (kernel.ts), jamais lus : leur code ne quitte pas la machine.
  // Seul le bloc du résumé de `fini()` est lu, dans le fil principal, pour arrêter le tour ;
  // un résumé clairement dans une autre langue que la demande est refusé une fois par tour
  // (language.ts), comparé sur place au dernier message de la personne, qui ne part nulle part.
  // Pas de `.catch` qui rappellerait `next` : l'outil tournerait deux fois.
  // Un noyau par agent (kernel.ts, `withAgent`) : l'agent qui appelle `python` part avec
  // l'appel, levier coupé ou non (l'outil reste le même, son noyau ne se partage jamais).
  // Test dans le corps plutôt qu'un filtre `{ tool: KERNEL_TOOL }` : typé `mcp__${string}__${string}`, ce
  // filtre fait calculer au compilateur le résultat de chaque outil possible (tsc au-delà de 8 Go).
  on('tool.call', async ($, e, next) => {
    if (isKernelTool(e.tool)) {
      let cwd: string | undefined
      try {
        cwd = await $.session.cwd()
      } catch {
        // Dossier illisible : le noyau de l'agent démarre dans celui du serveur.
      }
      e = withAgent(e, cwd)
    }
    let start: number | undefined
    try {
      start = await $.clock.now()
    } catch {
      // Horloge illisible : la durée de l'outil manque, rien d'autre.
    }
    const result = await next(e)
    let answer: typeof result = result
    try {
      if (start !== undefined) ran(s.timing, e.agentId ?? 'main', start, await $.clock.now())
    } catch {
      // Horloge illisible : la durée de l'outil manque, rien d'autre.
    }
    try {
      const plan = isKernelTool(e.tool) && result.deny === undefined ? await kernelOn($, s) : null
      if (plan) {
        called(s.kernel, e.agentId)
        const summary = e.agentId === undefined && !result.isError ? summaryOf(result.result, plan.finished) : undefined
        const refusal = summary !== undefined && !s.kernel.languageAsked ? await otherLanguage($, summary) : undefined
        if (refusal !== undefined) {
          s.kernel.languageAsked = true
          // Seul `context` (rappels d'un crochet PostToolUse) passe avec la réponse refaite : `ref` ferait reprendre
          // tel quel le message d'origine (refus perdu), `text` et `isReadOnly` sont ceux du moteur.
          answer = {
            result: refusedFinish(result.result, plan.finished, refusal) as typeof result.result,
            ...(result.context === undefined ? {} : { context: result.context }),
          }
        } else if (summary !== undefined) {
          s.kernel.summary = summary
        }
      }
    } catch {
      // Configuration ou liste des outils illisible : l'appel n'est pas compté, rien d'autre.
    }
    try {
      const path = 'file_path' in e ? e.file_path : undefined
      if (e.agentId === undefined && typeof path === 'string' && result.deny === undefined && !result.isError) {
        observed(s.rereads, e.tool, path, typeof result.text === 'string' ? result.text.length : 0)
        if (EDITS.includes(e.tool)) s.workEdits++
      }
    } catch {
      // Appel illisible : rien à suivre.
    }
    return answer
  })

  // Levier kernel (kernel.ts) : `python` et `compte` devant, outils intégrés d'action et outils
  // qui n'agissent pas derrière ToolSearch. Sur toute erreur, la place du moteur reste.
  on('tool.describe', async ($, e, next) => {
    const result = await next(e)
    try {
      const plan = await kernelOn($, s)
      return plan && (isKernelTool(e.tool) || isAccountTool(e.tool) || isBehind(plan, e.tool))
        ? placed(s.kernel, plan, e, result) : result
    } catch {
      // Configuration ou liste des outils illisible : description inchangée.
      return result
    }
  })

  // Levier kernel : ToolSearch ne trouve ni ne charge plus les outils refusés (leurs noms retirés de sa
  // réponse, que le moteur traduit ensuite en schémas) ; la raison du refus jointe pour le modèle.
  // Sur toute erreur, la réponse du moteur. Pas de `.catch` qui rappellerait `next`.
  on('tool.call', { tool: 'ToolSearch' }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.deny !== undefined || result.isError) return result
      const found: unknown = result.result
      const matches = typeof found === 'object' && found !== null ? (found as { matches?: unknown }).matches : undefined
      const plan = Array.isArray(matches) ? await kernelOn($, s) : null
      if (!plan || !Array.isArray(matches)) return result
      const kept = searchable(plan, matches)
      if (kept.length === matches.length) return result
      return { result: { ...(found as object), matches: kept } as typeof result.result,
        context: [...(result.context ?? []), plan.refusal] }
    } catch {
      return result
    }
  })

  // Outil retiré que le modèle appelle quand même (chargé par ToolSearch) : refusé
  // avec la consigne de passer par `python`. Seul un vrai appel compte (pas une
  // question `$.tool.check` d'un plugin). Sur toute erreur, la décision du moteur.
  on('tool.check', async ($, e, next) => {
    try {
      const plan = await kernelOn($, s)
      if (plan && isDenied(plan, e.tool)) {
        if (e.tool_use_id !== undefined) refused(s.kernel, e.agentId)
        return { decision: 'deny' as const, reason: plan.refusal }
      }
    } catch {
      // Configuration ou liste des outils illisible : le moteur décide.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Levier prefix (prefix.ts) : la section que le plan nomme quitte le prompt système et rejoint le
  // contexte du premier message, que le moteur refait après une compaction. Sur toute erreur, rien ne bouge.
  on('prompt.section', async ($, e, next) => {
    const result = await next(e)
    try {
      const plan = await prefixOn($, s)
      return plan?.context.has(e.name) && taken(s.prefix, e.name, result.text) ? { ...result, text: null } : result
    } catch {
      return result
    }
  }).catch(($, e, next) => next(e))

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    try {
      const plan = await prefixOn($, s)
      if (!plan) return result
      const own = await carried($, s.prefix, plan.context)
      if (own.length === 0) return result
      return { ...result, blocks: [...result.blocks.filter(block => !own.some(found => found.name === block.name)), ...own] }
    } catch {
      return result
    }
  }).catch(($, e, next) => next(e))

  // Levier kernel : la pièce jointe que le plan désigne est retirée de la requête, les
  // listes qu'il nomme sont raccourcies, et la liste des outils différés perd les outils refusés
  // (kernel.ts). Sur toute erreur, celle du moteur.
  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e)
    try {
      const plan = result.text !== null ? await kernelOn($, s) : null
      if (plan && result.text !== null) {
        if (contradicts(plan, e.type, result.text)) return { text: null }
        const short = unlisted(plan, e.type, shortened(plan, e.type, result.text))
        if (short !== result.text) return { ...result, text: short }
      }
    } catch {
      // Configuration ou liste des outils illisible : pièce jointe gardée.
    }
    return result
  }).catch(($, e, next) => next(e))

  // Tour du fil principal arrêté par `fini()` : fin voulue par le modèle, tâche
  // vérifiée. Les hooks Stop des réglages (dont completion.py, levier persistence,
  // qui relance sur un plan natif ouvert) tournent, mais leur relance (`block`) est
  // retirée. Pas de `.catch` qui rappellerait `next` : ils tourneraient deux fois.
  on('classic.Stop', async ($, e, next) => {
    const stopped = s.kernel.stopped
    s.kernel.stopped = false
    const result = await next(e)
    if (!stopped || result.block === undefined) return result
    const { block: _relaunch, ...kept } = result
    return kept
  })

  on('agent.offer', ($, e, next) => {
    s.sources.set(e.agent, e.source)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && !result.skip) {
      cooled(s)
      // Compaction du moteur ou de l'utilisateur (dont celle à l'inactivité) :
      // `$.model.fork` rejouerait la requête d'avant, relances arrêtées. La
      // nôtre (`plugin`) précède la chaîne, qui part ensuite sur le résumé.
      if (e.trigger === 'auto' || e.trigger === 'manual') cancel(s.warm)
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
      if (result.deny === undefined && result.agentId !== undefined) {
        started(s, e.prompt, result.agentId, plan)
        launched(s.fanout, result.agentId, e.subagentType)
      }
      return result
    } finally {
      s.spawning--
      s.pending.delete(e.prompt)
      s.requested.delete(e.tool_use_id)
    }
  }).catch(($, e, next) => next(e))

  // Message tapé pendant un tour du fil principal : retenu pour que le tour qui
  // le reprend garde le réglage du travail en cours (`continued`).
  on('prompt.submit', ($, e, next) => {
    if (e.turnId !== undefined && e.text.trim() !== '') s.steered.add(e.text.trim())
    return next(e)
  })

  // Fin d'un tour du fil principal : le lot part et la pause commence (relances
  // du cache), sans retenir la main.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason !== 'aborted') s.steered.clear()
    if (e.agentId === undefined) {
      try {
        // Durée du tour jusqu'à sa réponse finale, avant que le lot ne parte (timing.ts).
        if (e.reason === 'answer') ended(s.timing, e.turnId, await $.clock.now(), s.queue.steps)
      } catch {
        // Horloge illisible : la durée du tour manque, rien d'autre.
      }
      void flush($, s.queue)
      void paused($, s)
      void shown($, s)
    }
    return result
  }).catch(($, e, next) => next(e))

  // Bandeau du gain au-dessus de la saisie (band.ts), et la santé de l'outil principal quand il manque.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    void refreshed($, s.health, s.to !== null)
    // Santé de l'outil principal d'abord ; sinon, connecteur sous la version minimale du service (versions.ts).
    const tree = band($, e, s.badge, await $.clock.now(),
      degradedNote(s.outage) ?? healthNotice(s.health.diagnosis) ?? s.holdout.answer?.outdated ?? null)
    return tree === null ? next(e) : tree
  }).catch(($, e, next) => next(e))

  // Fin de session : ce qui reste part avant que le processus ne s'arrête.
  on('session.end', async ($, e, next) => {
    cancel(s.warm)
    s.badge.stop?.()
    s.health.stop?.()
    await flush($, s.queue)
    return next(e)
  }).catch(($, e, next) => next(e))
}

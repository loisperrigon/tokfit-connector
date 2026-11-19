// Levier `kernel` (zéro outil) : Claude Code n'agit plus que par l'outil `python`
// du serveur MCP `noyau` que ce plugin embarque (kernel/server.py), un noyau
// Python persistant où lire, écrire, chercher et lancer des commandes se font en
// code. Ses outils intégrés d'action passent derrière ToolSearch et sont refusés
// s'il les charge quand même (raison lue par le modèle, qui repart vers `python`) ;
// `python` passe devant, et une section du prompt est remplacée par la consigne.
// Outils à déplacer, outils refusés, texte du refus, consigne, section remplacée,
// pièce jointe retirée, listes du moteur raccourcies et marqueur de fin : ceux du
// plan de session (plan.ts), appliqués tels quels. Quand la cellule appelle
// `fini(resume)`, le tour s'arrête sur ce résumé sans nouvelle requête.
//
// Le levier ne touche à rien tant que `python` n'est pas connecté (python3 absent,
// serveur arrêté, paquet du noyau non reçu, clé refusée) ; il le signale alors au service
// (`kernel_unavailable`). Seuls des nombres partent : jamais le code envoyé au noyau.
import type { EngineInterface, McpToolName, PromptComposeSection, ToolDescribeInput, ToolDescribeResult, TurnStepChunk, TurnStepResult } from 'claude-code'
import { section } from './plan'
import type { KernelPlan } from './plan'
import { NAME } from './service'
import type { LeverFacts } from './usage'

export type KernelFacts = Pick<LeverFacts, 'kernel_calls' | 'kernel_denied' | 'kernel_unavailable' | 'prompt_cut_chars' | 'prompt_trim_chars'>

// Serveur déclaré dans .claude-plugin/plugin.json (`mcpServers`) et son unique outil.
export const SERVER = 'outils'
// Nom neutre (affiché dans l'interface) : rien sur la méthode. Garder égal à OUTIL de kernel/server.py.
export const TOOL = 'agir'

// Claude Code nomme le serveur d'un plugin `plugin:<plugin>:<serveur>` et en épelle
// les outils `mcp__<serveur>__<outil>`, chaque caractère hors [A-Za-z0-9_-] devenu
// `_` : `mcp__plugin_tokfit_outils__agir`. Le nom porte celui du plugin : un
// serveur `outils` configuré ailleurs ne s'y confond pas.
function spelled(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

export const KERNEL_TOOL: McpToolName = `mcp__${spelled(`plugin:${NAME}:${SERVER}`)}__${TOOL}`
// Outil `compte` du même serveur (bilan d'économie, limites du compte) : devant lui aussi en mode noyau,
// pour que le modèle le voie sans passer par ToolSearch.
export const ACCOUNT_TOOL: McpToolName = `mcp__${spelled(`plugin:${NAME}:${SERVER}`)}__compte`

export function isKernelTool(name: string): boolean {
  return name === KERNEL_TOOL
}

// Filtre d'un hook `tool.call` sur `python` seul. Une expression plutôt que `{ tool: KERNEL_TOOL }` :
// typé `mcp__${string}__${string}`, ce filtre fait calculer au compilateur le résultat de chaque outil
// possible (tsc au-delà de 8 Go), alors qu'une expression ne restreint pas le type de l'appel. Le nom
// ne porte que [A-Za-z0-9_-] (`spelled`) : aucun caractère à échapper.
export const KERNEL_MATCH = new RegExp(`^${KERNEL_TOOL}$`)

// Un noyau par agent (kernel/server.py) : chaque appel de `python` porte en argument
// `agent` la boucle qui l'a lancé, `main` pour le fil principal. Sans lui, le fil
// principal et les sous-agents partageraient répertoire courant et variables : un
// `os.chdir` d'un sous-agent déplaçait les autres. La valeur que le modèle aurait mise
// est remplacée : seul le moteur sait quelle boucle appelle. `cwd` : le dossier de
// cette boucle (`$.session.cwd()` lu dans le hook : celui du sous-agent, son worktree
// s'il est isolé), où son noyau démarre ; absent si le moteur ne le rend pas.
export const AGENT_ARGUMENT = 'agent'
export const CWD_ARGUMENT = 'cwd'
export const MAIN_LOOP = 'main'

export function withAgent<E extends { agentId?: string }>(e: E, cwd: string | undefined): E & { [AGENT_ARGUMENT]: string } {
  const { [CWD_ARGUMENT]: _ignored, ...rest } = e as E & { [CWD_ARGUMENT]?: unknown }
  return { ...(rest as E), [AGENT_ARGUMENT]: e.agentId ?? MAIN_LOOP, ...(cwd ? { [CWD_ARGUMENT]: cwd } : {}) }
}

export function isAccountTool(name: string): boolean {
  return name === ACCOUNT_TOOL
}

// Fournisseur d'un outil de ce plugin dans `tool.describe` : `tokfit@inline`
// chargé par --plugin-dir, `<nom>@<marketplace>` installé.
function ours(provider: { plugin: string }): boolean {
  return provider.plugin === NAME || provider.plugin.startsWith(`${NAME}@`)
}

export function isDenied(plan: KernelPlan, name: string): boolean {
  return plan.denied.has(name)
}

export function isBehind(plan: KernelPlan, name: string): boolean {
  return plan.behind.has(name)
}

// État du levier pour une session : `python` vu connecté (gardé une fois vu ; une
// absence est revérifiée, le serveur pouvant se connecter après le premier
// rendu), compteurs par boucle (`main` ou identifiant d'agent) en attente de
// l'étape suivante de cette boucle, et passage des descriptions (`pass`) :
// le premier passage actif de la session invalide le cache du prompt, une seule fois.
// `summary` : résumé passé à `fini()` dans le fil principal, en attente de l'étape
// suivante du tour (qui le rend sans interroger le modèle) ; `stopped` : le tour du
// fil principal vient de s'arrêter ainsi, son hook Stop ne doit pas le relancer ;
// `languageAsked` : un `finish` du tour a déjà été refusé pour sa langue (language.ts).
// Caractères que le levier retire des requêtes : `moved`, par outil déplacé (description et nom dans la liste
// des outils différés ; négatif pour un outil passé devant) ; `sectionCut`, section remplacée moins la consigne ;
// `trimmed`, par boucle, pièces jointes retirées ou raccourcies, en attente de l'étape suivante de cette boucle.
// `offered` : sous-agents (et forks, teammates) dont le modèle se voit offrir `agir` (`tool.offer`) ; un sous-agent
// que le moteur n'y a pas mis (définition aux `tools` fermés : `tools: Read, Bash`) garde ses outils intégrés.
export type Kernel = {
  session: string | undefined
  ready: boolean
  // Dernière lecture de la liste des outils (horloge du moteur, ms) : `ready` relu au plus toutes les READY_MS.
  checkedAt: number
  calls: Map<string, number>
  denied: Map<string, number>
  pass: 'never' | 'now' | 'done'
  summary: string | undefined
  stopped: boolean
  languageAsked: boolean
  moved: Map<string, number>
  sectionCut: number
  trimmed: Map<string, number>
  offered: Set<string>
}

export function kernel(): Kernel {
  return { session: undefined, ready: false, checkedAt: Number.NEGATIVE_INFINITY, calls: new Map(), denied: new Map(), pass: 'never', summary: undefined, stopped: false,
    languageAsked: false, moved: new Map(), sectionCut: 0, trimmed: new Map(), offered: new Set() }
}

// État remis à neuf quand la session change (`/clear`, reprise d'une autre).
export async function sessionOf($: EngineInterface, k: Kernel): Promise<void> {
  const session = await $.session.id()
  if (k.session !== session) Object.assign(k, kernel(), { session })
}

// `agir` offert au modèle d'une boucle (`tool.offer` : avant sa première requête, puis à chaque appel).
export function offeredTo(k: Kernel, agentId: string | undefined): void {
  k.offered.add(agentId ?? MAIN_LOOP)
}

// Fork : il garde la liste d'outils de la boucle qui le lance.
export function forked(k: Kernel, parentAgentId: string | undefined, agentId: string): void {
  if (parentAgentId === undefined ? k.offered.has(MAIN_LOOP) : k.offered.has(parentAgentId)) k.offered.add(agentId)
}

// Boucle où le levier agit : le fil principal (et une question `$.tool.check`, hors de toute boucle), régi par
// `kernelReady` ; un sous-agent seulement si `agir` lui est offert.
export function kernelLoop(k: Kernel, agentId: string | undefined): boolean {
  return agentId === undefined || k.offered.has(agentId)
}

// Vrai quand l'outil `agir` de ce plugin est parmi ceux que le modèle peut appeler, hors Code Mode et hors règles de
// permission ou bac à sable des réglages (`permissionRules`), relu au plus toutes
// les READY_MS : si `agir` disparaît (serveur d'outils relancé pendant une panne du service, sans paquet du
// noyau), les outils retirés reviennent aussitôt au lieu de rester refusés sans remplaçant.
export const READY_MS = 2000

// Outil du moteur qui exécute le JavaScript du modèle en Code Mode (CLAUDE_CODE_EXPERIMENTAL_CODE_MODE) ; ses
// scripts appellent Bash, Read, Edit… sous leur nom, au travers de `tool.check` : présent, le levier ne retire rien.
export const CODE_MODE_TOOL = 'REPL'

export function inCodeMode(tools: readonly { name: string; mcp?: boolean }[]): boolean {
  return tools.some(tool => !tool.mcp && tool.name === CODE_MODE_TOOL)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Réglages de Claude Code (fusion de toutes les couches) qui bornent ses outils intégrés : une règle
// `permissions.deny`, ou le bac à sable de Bash (`sandbox.enabled`). Vrai : le levier ne retire rien. Réglages
// illisibles : traités comme bornés.
export async function permissionRules($: EngineInterface): Promise<boolean> {
  try {
    const [permissions, sandbox]: unknown[] = await Promise.all([
      $.settings.read({ key: 'permissions' }), $.settings.read({ key: 'sandbox' })])
    const deny = isRecord(permissions) ? permissions.deny : undefined
    return (Array.isArray(deny) && deny.length > 0) || (isRecord(sandbox) && sandbox.enabled === true)
  } catch {
    // Lecture refusée par le moteur : comme des règles présentes, rien n'est retiré.
    return true
  }
}

export async function kernelReady($: EngineInterface, k: Kernel): Promise<boolean> {
  await sessionOf($, k)
  // Absent : relu à chaque fois (il prend dès qu'il apparaît) ; présent : relu au plus toutes les READY_MS.
  const now = await $.clock.now()
  if (!k.ready || now - k.checkedAt >= READY_MS) {
    const tools = await $.tool.list()
    k.ready = tools.some(tool => tool.mcp && isKernelTool(tool.name)) && !inCodeMode(tools) && !(await permissionRules($))
    k.checkedAt = now
  }
  return k.ready
}

// Place d'un outil, levier actif : `python` et `compte` devant, les outils retirés ou différés
// derrière ToolSearch, les autres tels quels. Un changement de place en cours de fil attend
// sinon un nouveau fil : le premier passage actif de la session invalide le cache
// (toutes les descriptions de ce passage, jusqu'à l'étape suivante : `passed`).
export function placed(k: Kernel, plan: KernelPlan, e: ToolDescribeInput, result: ToolDescribeResult): ToolDescribeResult {
  const front = (isKernelTool(e.tool) || isAccountTool(e.tool)) && ours(e.provider)
  if (!front && !isBehind(plan, e.tool)) return result
  const deferred = !front
  if ((result.isDeferred ?? e.isDeferred ?? false) === deferred) return result
  const breaking = k.pass !== 'done'
  if (breaking) k.pass = 'now'
  // Derrière ToolSearch, la description quitte la requête et le nom rejoint la liste des outils différés.
  const listed = e.tool.length + 1
  k.moved.set(e.tool, deferred ? result.description.length - listed : listed - result.description.length)
  return { ...result, isDeferred: deferred, ...(breaking ? { breakPromptCache: true } : {}) }
}

// Début d'une étape : le passage qui a invalidé le cache est terminé.
export function passed(k: Kernel): void {
  if (k.pass === 'now') k.pass = 'done'
}

// Prompt système, levier actif : la section que le plan désigne laisse place à la
// consigne du noyau, ajoutée en fin de liste côté `session` (après toutes les
// sections `shared` du moteur, ordre exigé par le moteur), qu'elle ait été trouvée ou non.
export function composed(sections: readonly PromptComposeSection[], plan: KernelPlan): PromptComposeSection[] {
  return [...sections.filter(found => found.id !== plan.replaces), section('kernel', plan.section)]
}

// Caractères retirés du prompt système par `composed` (section remplacée moins la consigne), retenus quand la
// section remplacée est là : une composition sans elle (celle d'un sous-agent) ne change pas le chiffre.
export function composedCut(k: Kernel, sections: readonly PromptComposeSection[], plan: KernelPlan): void {
  const replaced = sections.find(found => found.id === plan.replaces)
  if (replaced) k.sectionCut = replaced.text.length - plan.section.length
}

// Pièce jointe retirée ou raccourcie par le levier : caractères retirés, comptés pour la boucle qui la porte.
export function attachmentCut(k: Kernel, agentId: string | undefined, before: string, after: string | null): void {
  const removed = before.length - (after?.length ?? 0)
  if (removed <= 0) return
  const loop = agentId ?? 'main'
  k.trimmed.set(loop, (k.trimmed.get(loop) ?? 0) + removed)
}

// Liste des outils derrière ToolSearch que le moteur joint aux messages (un nom par ligne).
export const DEFERRED_LISTING = 'deferred_tools_delta'

// Liste des outils différés sans les outils refusés : le modèle ne les cherche plus pour se faire refuser.
export function unlisted(plan: KernelPlan, type: string, text: string): string {
  if (type !== DEFERRED_LISTING) return text
  return text.split('\n').filter(line => !plan.denied.has(line.trim())).join('\n')
}

// Noms que ToolSearch a trouvés, sans les outils refusés : il n'en charge plus le schéma.
export function searchable(plan: KernelPlan, matches: readonly unknown[]): unknown[] {
  return matches.filter(name => typeof name !== 'string' || !plan.denied.has(name))
}

// Pièce jointe du moteur que le plan fait retirer.
export function contradicts(plan: KernelPlan, type: string, text: string): boolean {
  return type === plan.attachment.type && text.includes(plan.attachment.contains)
}

// Entrée d'une liste du moteur (skills, agents) : « - nom: description », le nom sans espace
// (celui d'un plugin porte des deux-points), suivie des lignes non vides qui la continuent ;
// une ligne « - nom » sans description est une entrée gardée telle quelle.
const ENTRY = /^- \S+: /

// Entrée coupée à `entry` caractères de description, points de suspension compris, sans
// couper un caractère en deux.
function cut(item: string, entry: number): string {
  const head = ENTRY.exec(item)?.[0] ?? ''
  const description = item.slice(head.length)
  if (description.length <= entry) return item
  let end = entry - 1
  const last = description.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${head}${description.slice(0, end)}…`
}

// Liste du moteur que le plan fait raccourcir : chaque entrée coupée, en-tête et texte hors
// des entrées gardés tels quels. Le texte d'origine si le plan ne nomme pas cette liste.
export function shortened(plan: KernelPlan, type: string, text: string): string {
  const listing = plan.listings.find(found => found.type === type)
  if (!listing) return text
  const lines: string[] = []
  let item: string | undefined
  for (const line of text.split('\n')) {
    if (ENTRY.test(line)) {
      if (item !== undefined) lines.push(cut(item, listing.entry))
      item = line
    } else if (item !== undefined && line.trim() !== '' && !line.startsWith('- ')) {
      item += `\n${line}`
    } else {
      if (item !== undefined) lines.push(cut(item, listing.entry))
      item = undefined
      lines.push(line)
    }
  }
  if (item !== undefined) lines.push(cut(item, listing.entry))
  return lines.join('\n')
}

// Marqueur de fin d'avant le 17/11/2026 (français, relu par le modèle dans l'historique) : encore lu le temps
// d'une version, pour un noyau dont le paquet a été reçu avant le changement et un plan reçu après.
export const LEGACY_FINISHED = '[noyau:fini]\n'

function blocksOf(result: unknown): readonly unknown[] {
  return Array.isArray(result) ? result
    : typeof result === 'object' && result !== null && Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: unknown[] }).content : []
}

// Bloc du résumé passé à `finish()` dans les blocs du résultat de `python` (le résultat
// MCP `{ content, isError }`, ou ses blocs seuls) : un bloc texte autre que le premier
// (la sortie de la cellule, où le code peut imprimer n'importe quoi) qui commence par
// le marqueur du plan ou l'ancien. Absent sinon.
function finishedBlock(blocks: readonly unknown[], marker: string): { index: number; summary: string } | undefined {
  for (let index = 1; index < blocks.length; index++) {
    const block = blocks[index]
    if (typeof block !== 'object' || block === null) continue
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type !== 'text' || typeof text !== 'string') continue
    const found = [marker, LEGACY_FINISHED].find(known => text.startsWith(known))
    if (found !== undefined) return { index, summary: text.slice(found.length) }
  }
  return undefined
}

export function summaryOf(result: unknown, marker: string): string | undefined {
  return finishedBlock(blocksOf(result), marker)?.summary
}

// Le résultat de `python` dont le bloc du résumé laisse place au refus : le modèle lit
// pourquoi `finish` n'a pas fini le tour et le rappelle. Inchangé sans ce bloc.
export function refusedFinish(result: unknown, marker: string, refusal: string): unknown {
  const blocks = blocksOf(result)
  const found = finishedBlock(blocks, marker)
  if (found === undefined) return result
  const content = blocks.map((block, index) => (index === found.index ? { type: 'text', text: refusal } : block))
  return Array.isArray(result) ? content : { ...(result as object), content }
}

// Réponse d'une étape rendue sans requête au modèle : le résumé, montré et
// enregistré comme le dernier message de l'assistant (le `result` d'une session -p).
export function finalAnswer(turnId: string, index: number, summary: string): { chunks: TurnStepChunk[]; result: TurnStepResult } {
  return {
    chunks: [{ kind: 'text', index: 0, text: summary }, { kind: 'stop', stopReason: 'end_turn', usage: null }],
    result: { turnId, index, answer: summary, toolUses: [], stopReason: 'end_turn', usage: null },
  }
}

function bump(counts: Map<string, number>, loop: string): void {
  counts.set(loop, (counts.get(loop) ?? 0) + 1)
}

export function called(k: Kernel, agentId: string | undefined): void {
  bump(k.calls, agentId ?? 'main')
}

export function refused(k: Kernel, agentId: string | undefined): void {
  bump(k.denied, agentId ?? 'main')
}

// Compteurs pris depuis l'étape précédente de la boucle, remis à zéro. Fil principal, `agir` connecté :
// caractères que le levier retire de chaque requête (outils déplacés, section remplacée).
export function kernelFacts(k: Kernel, agentId: string | undefined): KernelFacts {
  const loop = agentId ?? 'main'
  const calls = k.calls.get(loop)
  const denied = k.denied.get(loop)
  const trimmed = k.trimmed.get(loop)
  k.calls.delete(loop)
  k.denied.delete(loop)
  k.trimmed.delete(loop)
  let cut = 0
  if (agentId === undefined && k.ready) {
    for (const chars of k.moved.values()) cut += chars
    cut += k.sectionCut
  }
  return { ...(calls ? { kernel_calls: calls } : {}), ...(denied ? { kernel_denied: denied } : {}),
    ...(cut ? { prompt_cut_chars: cut } : {}), ...(trimmed ? { prompt_trim_chars: trimmed } : {}) }
}

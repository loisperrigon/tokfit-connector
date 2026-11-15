// Levier kernel (zéro outil) : outils intégrés d'action derrière ToolSearch et
// refusés, `python` du noyau devant, section `tools` du prompt remplacée ; rien
// de tout cela sans l'outil réellement connecté, ni pour une session où le levier
// est coupé. Seuls des nombres partent au service, jamais le code.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptComposeSection, ToolDescribeResult } from 'claude-code'
import { KERNEL_TOOL } from '../hooks/kernel'
import { DEFERRED, DENIED, EXECUTION_SECTION, KERNEL_SECTION, LISTING, REFUSAL, TEST_PLAN, THINKING_SECTION } from './plan'
import { DEFAULT_URL, end, step, streamed, unconfigured, user, world } from './support'
import type { Options, Reply, World } from './support'
import { PLAN_RETRY_MS, PLAN_TIMEOUT_MS } from '../hooks/plan'

type Sent = Record<string, unknown>

// Outils du modèle quand le plugin tourne : intégrés, et l'outil du noyau (nom vu en vrai, 2.1.323).
const PYTHON = 'mcp__plugin_tokfit_outils__agir'
// Outil des limites du compte, servi par le même serveur (kernel/compte.py).
const COMPTE = 'mcp__plugin_tokfit_outils__compte'
const TOOLS = ['Agent', 'Bash', 'Read', 'Edit', 'Grep', 'ToolSearch', 'WebSearch', PYTHON]
const ENGINE = { plugin: 'engine', tier: 'core' as const }
// Fournisseur de nos outils, plugin chargé par --plugin-dir (vu en vrai, 2.1.323).
const OURS = { plugin: 'tokfit@inline', tier: 'user' as const }
const NEVER_DENIED = ['Agent', 'Skill', 'ToolSearch', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode']

const PROMPT: PromptComposeSection[] = [
  { id: 'intro', text: 'Tu es Claude Code.', scope: 'shared' },
  { id: 'tools', text: '# Using your tools\nUse Read, Edit, Bash…', scope: 'shared' },
  { id: 'tone', text: 'Sois bref.', scope: 'shared' },
]
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] }

function connected(options: Options = {}): Options {
  return { messages: [user('corrige le test')], tools: TOOLS, prompt: PROMPT, python: () => 'ok', ...options }
}

async function placement($: Engine, tool: string, provider: { plugin: string; tier: 'core' | 'user' } = ENGINE,
                         isDeferred?: true): Promise<ToolDescribeResult> {
  return $.tool.describe({ tool, description: `outil ${tool}`, provider, ...(isDeferred ? { isDeferred } : {}) })
}

async function check($: Engine, tool: string, id = 'tu-9'): Promise<{ decision: string; reason?: string }> {
  return $.tool.check({ tool, input: {}, tool_use_id: id })
}

// Pièce jointe `auto_mode` du moteur, telle que Claude Code 2.1.323 la rend en bypassPermissions
// (vue en vrai dans les sessions du banc, 15/11/2026).
const AUTO_MODE = 'While bypass permissions mode is active:\n\nYou can do much of your work through the Bash tool when it is the simpler route: read files with cat, head, or sed -n…'

async function attachment($: Engine, type: string, text: string, agentId?: string): Promise<string | null> {
  return (await $.prompt.attachment({ type, text, origin: { kind: 'engine' }, ...(agentId ? { agentId } : {}) })).text
}

// Liste des skills du moteur, à la forme de Claude Code 2.1.323 : en-tête, une entrée par
// skill (« - nom: description »), description parfois sur plusieurs lignes, nom seul.
const SKILLS = [
  'The following skills are available for use with the Skill tool:',
  '',
  '- court: Une description brève.',
  '- long: Une description bien plus longue que ce que le plan garde pour chaque entrée.',
  '- plugin:skill: Nom avec deux-points, description encore trop longue pour le plan.',
  '- multi: Première ligne.',
  'TRIGGER — seconde ligne de la même description, qui dépasse.',
  '- nom-seul',
].join('\n')
const SKILLS_SHORT = [
  'The following skills are available for use with the Skill tool:',
  '',
  '- court: Une description brève.',
  '- long: Une description bien plus longue que ce…',
  '- plugin:skill: Nom avec deux-points, description encor…',
  '- multi: Première ligne.\nTRIGGER — seconde ligne…',
  '- nom-seul',
].join('\n')

// Résultat de `python` quand la cellule a appelé `fini(resume)` : le serveur ajoute ce second bloc.
function finished(summary: string, output = 'ok'): readonly string[] {
  return [output, `[noyau:fini]\n${summary}`]
}

async function sentSteps($: Engine, w: World): Promise<Sent[]> {
  await end($)
  await w.clock.settle()
  return w.usages().flatMap(sent => sent.body.steps as Sent[])
}

describe('levier actif, noyau connecté', () => {
  test('le nom de l’outil du noyau est celui que Claude Code donne au serveur du plugin', () => {
    expect(KERNEL_TOOL).toBe(PYTHON)
  })

  test('Read et Bash passent derrière ToolSearch, python devant, les autres restent', async ($, on) => {
    world(on, connected())
    expect((await placement($, 'Read')).isDeferred).toBe(true)
    expect((await placement($, 'Bash')).isDeferred).toBe(true)
    expect((await placement($, PYTHON, OURS, true)).isDeferred).toBe(false)
    expect(await placement($, 'Agent')).toEqual({ description: 'outil Agent' })
    expect(await placement($, 'WebSearch', ENGINE, true)).toEqual({ description: 'outil WebSearch', isDeferred: true })
  })

  test('un serveur `noyau` qui n’est pas celui du plugin n’est pas déplacé', async ($, on) => {
    world(on, connected({ tools: [...TOOLS, 'mcp__noyau__python'] }))
    const other = { plugin: 'mcp:noyau', tier: 'user' as const }
    expect(await placement($, 'mcp__noyau__python', other, true)).toEqual({ description: 'outil mcp__noyau__python', isDeferred: true })
  })

  test('l’outil `compte` du serveur outils passe devant, jamais refusé', async ($, on) => {
    world(on, connected({ tools: [...TOOLS, COMPTE] }))
    expect(DENIED).not.toContain(COMPTE)
    expect(DEFERRED).not.toContain(COMPTE)
    expect((await check($, COMPTE)).decision).toBe('allow')
    // Différé par le moteur, il passe devant comme `python` : le modèle le voit sans ToolSearch.
    expect((await placement($, COMPTE, OURS, true)).isDeferred).toBe(false)
    expect(await placement($, COMPTE, OURS)).toEqual({ description: `outil ${COMPTE}` })
    // Le même nom servi par un autre fournisseur ne bouge pas.
    const other = { plugin: 'mcp:outils', tier: 'user' as const }
    expect(await placement($, COMPTE, other, true)).toEqual({ description: `outil ${COMPTE}`, isDeferred: true })
  })

  test('les outils refusés disparaissent de la liste des outils différés', async ($, on) => {
    world(on, connected())
    const listing = ['The following deferred tools are now available via ToolSearch:', 'Bash', 'Edit', 'Glob', 'Grep',
      'Read', 'WebFetch', 'Workflow', 'Write', 'mcp__plugin_tokfit_outils__compte'].join('\n')
    expect(await attachment($, 'deferred_tools_delta', listing)).toBe(
      ['The following deferred tools are now available via ToolSearch:', 'WebFetch', 'Workflow',
        'mcp__plugin_tokfit_outils__compte'].join('\n'))
    expect(await attachment($, 'deferred_tools_delta', 'WebFetch')).toBe('WebFetch')
  })

  test('ToolSearch ne trouve ni ne charge plus les outils refusés, et dit pourquoi', async ($, on) => {
    world(on, connected({ search: query => query === 'select:Read,WebFetch' ? ['Read', 'WebFetch'] : ['WebFetch'] }))
    const found = await $.tool.call({ tool: 'ToolSearch', tool_use_id: 'tu-1', query: 'select:Read,WebFetch', max_results: 5 })
    expect(found.deny).toBeUndefined()
    expect((found.result as { matches: string[] }).matches).toEqual(['WebFetch'])
    expect(found.context).toEqual([REFUSAL])
    // Rien de refusé dans la réponse : celle du moteur, telle quelle.
    const plain = await $.tool.call({ tool: 'ToolSearch', tool_use_id: 'tu-2', query: 'web', max_results: 5 })
    expect((plain.result as { matches: string[] }).matches).toEqual(['WebFetch'])
    expect(plain.context).toBeUndefined()
  })

  test('le cache du prompt n’est invalidé qu’au premier passage actif de la session', async ($, on) => {
    world(on, connected())
    expect((await placement($, 'Read')).breakPromptCache).toBe(true)
    expect((await placement($, PYTHON, OURS, true)).breakPromptCache).toBe(true)
    await step($, 0, { turnId: 't1' })
    expect((await placement($, 'Read')).breakPromptCache).toBeUndefined()
    expect((await placement($, 'Bash')).isDeferred).toBe(true)
  })

  test('Bash chargé par ToolSearch puis appelé : refus avec la raison exacte', async ($, on) => {
    world(on, connected())
    expect(await check($, 'Bash')).toEqual({ decision: 'deny', reason: REFUSAL })
    expect(await check($, 'Read')).toEqual({ decision: 'deny', reason: REFUSAL })
  })

  test('Agent, WebSearch, ToolSearch et les autres outils non retirés ne sont jamais refusés', async ($, on) => {
    world(on, connected())
    for (const tool of NEVER_DENIED) {
      expect(DENIED).not.toContain(tool)
      expect((await check($, tool)).decision).toBe('allow')
    }
    expect((await check($, PYTHON)).decision).toBe('allow')
  })

  test('le prompt perd la section tools du moteur et porte la consigne du noyau', async ($, on) => {
    world(on, connected())
    const sections = (await $.prompt.compose(COMPOSE)).sections
    expect(sections.map(section => section.id)).toEqual(['intro', 'tone', 'tokfit:kernel', THINKING_SECTION.id, EXECUTION_SECTION.id])
    expect(sections).toContainEqual(KERNEL_SECTION)
  })

  test('les outils qui n’agissent pas passent derrière ToolSearch sans être refusés', async ($, on) => {
    world(on, connected())
    expect(DEFERRED).toEqual(DEFERRED)
    for (const tool of DEFERRED) {
      expect(DENIED).not.toContain(tool)
      expect((await placement($, tool)).isDeferred).toBe(true)
      expect((await check($, tool)).decision).toBe('allow')
    }
    for (const tool of ['Agent', 'Skill', 'ToolSearch', 'AskUserQuestion', 'TodoWrite', 'WebSearch', 'WebFetch']) {
      expect(DEFERRED).not.toContain(tool)
      expect(await placement($, tool)).toEqual({ description: `outil ${tool}` })
    }
  })

  test('outils différés et outils refusés : une seule invalidation du cache par session', async ($, on) => {
    world(on, connected())
    expect((await placement($, 'Workflow')).breakPromptCache).toBe(true)
    expect((await placement($, 'Read')).breakPromptCache).toBe(true)
    await step($, 0, { turnId: 't1' })
    expect(await placement($, 'ListAgents')).toEqual({ description: 'outil ListAgents', isDeferred: true })
    expect(await placement($, 'ScheduleWakeup', ENGINE, true)).toEqual({ description: 'outil ScheduleWakeup', isDeferred: true })
  })

  test('la pièce jointe auto_mode qui pousse vers Bash est retirée, les autres restent', async ($, on) => {
    world(on, connected())
    expect(await attachment($, 'auto_mode', AUTO_MODE)).toBeNull()
    expect(await attachment($, 'auto_mode', AUTO_MODE, 'agent-1')).toBeNull()
    // Une pièce jointe auto_mode qui ne parle pas de Bash (mode auto et son classeur) reste.
    expect(await attachment($, 'auto_mode', 'Auto mode is active.')).toBe('Auto mode is active.')
    expect(await attachment($, 'skill_listing', 'Bash tool')).toBe('Bash tool')
    expect(await attachment($, 'agent_listing_delta', 'agents')).toBe('agents')
  })

  test('liste que le plan raccourcit : chaque entrée coupée à sa longueur, le reste intact', async ($, on) => {
    world(on, connected())
    expect(LISTING.entry).toBe(40)
    expect(await attachment($, 'skill_listing', SKILLS)).toBe(SKILLS_SHORT)
    expect(await attachment($, 'skill_listing', SKILLS, 'agent-1')).toBe(SKILLS_SHORT)
    // Déjà courte : inchangée ; une autre liste que le plan ne nomme pas : inchangée.
    expect(await attachment($, 'skill_listing', SKILLS_SHORT)).toBe(SKILLS_SHORT)
    expect(await attachment($, 'agent_listing_delta', SKILLS)).toBe(SKILLS)
  })

  test('liste raccourcie : un caractère hors du plan multilingue de base (émoji) n’est jamais coupé en deux', async ($, on) => {
    world(on, connected())
    const text = `- e: ${'a'.repeat(38)}😀😀`
    expect(await attachment($, 'skill_listing', text)).toBe(`- e: ${'a'.repeat(38)}…`)
  })

  for (const [name, listings] of [['absentes', undefined], ['pas une liste', 'liste'], ['sans longueur', [{ type: 'skill_listing' }]],
    ['longueur nulle', [{ type: 'skill_listing', entry: 0 }]]] as const) {
    test(`plan aux listes ${name} : le reste du levier agit, aucune liste ne change`, async ($, on) => {
      const kernel: Record<string, unknown> = { ...TEST_PLAN.kernel, listings }
      if (listings === undefined) delete kernel.listings
      world(on, connected({ content: () => ({ status: 200, body: { version: 'v-autre', claude: { ...TEST_PLAN, kernel } } }) }))
      expect(await attachment($, 'skill_listing', SKILLS)).toBe(SKILLS)
      expect(await attachment($, 'auto_mode', AUTO_MODE)).toBeNull()
    })
  }

  test('3 appels python et 1 refus : compteurs sur l’étape suivante, une fois', async ($, on) => {
    const w = world(on, connected())
    await step($, 0, { turnId: 't1' })
    for (const n of [1, 2, 3]) await $.tool.call({ tool: PYTHON, tool_use_id: `tu-${n}`, code: `print(${n})` })
    await check($, 'Bash', 'tu-4')
    // Une question d'un plugin (`$.tool.check` sans appel) n'est pas un refus compté.
    await $.tool.check({ tool: 'Read', input: {} })
    await step($, 1, { turnId: 't1' })
    await step($, 2, { turnId: 't1' })
    const steps = await sentSteps($, w)
    expect(steps.map(s => [s.kernel_calls, s.kernel_denied])).toEqual([[undefined, undefined], [3, 1], [undefined, undefined]])
    expect(steps.map(s => s.kernel_unavailable)).toEqual([undefined, undefined, undefined])
  })

  test('appels d’un sous-agent : comptés sur sa propre étape suivante', async ($, on) => {
    const w = world(on, connected())
    await step($, 0, { turnId: 't1' })
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: 'x = 1', agentId: 'agent-1' })
    await check($, 'Grep', 'tu-2')
    await step($, 1, { turnId: 't1' })
    await step($, 0, { turnId: 'a1', agentId: 'agent-1' })
    const steps = await sentSteps($, w)
    expect(steps.map(s => [s.subagent, s.kernel_calls, s.kernel_denied]))
      .toEqual([[undefined, undefined, undefined], [undefined, undefined, 1], [true, 1, undefined]])
  })
})

describe('un noyau par agent', () => {
  function recorded(env?: Record<string, string>): { agents: unknown[]; options: Options } {
    const agents: unknown[] = []
    return { agents, options: connected({ python: (code, args) => (agents.push(args.agent), 'ok'), ...(env ? { env } : {}) }) }
  }

  test('chaque appel de python porte la boucle qui l’a lancé : main, puis l’identifiant du sous-agent', async ($, on) => {
    const { agents, options } = recorded()
    world(on, options)
    await step($, 0, { turnId: 't1' })
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: 'x = 1' })
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-2', code: 'x = 2', agentId: 'agent-1' })
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-3', code: 'x = 3', agentId: 'agent-2' })
    expect(agents).toEqual(['main', 'agent-1', 'agent-2'])
  })

  test('un agent écrit par le modèle est remplacé par la vraie boucle', async ($, on) => {
    const { agents, options } = recorded()
    world(on, options)
    await step($, 0, { turnId: 't1' })
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: 'x = 1', agent: 'agent-9' })
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-2', code: 'x = 2', agent: 'main', agentId: 'agent-1' })
    expect(agents).toEqual(['main', 'agent-1'])
  })

  test('levier coupé : l’agent part quand même, le noyau ne se partage jamais', async ($, on) => {
    const { agents, options } = recorded({ TOKFIT_OFF: 'kernel' })
    world(on, options)
    await step($, 0, { turnId: 't1' })
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: 'x = 1', agentId: 'agent-1' })
    expect(agents).toEqual(['agent-1'])
  })
})

describe('arrêt par fini', () => {
  test('résultat de python avec le marqueur : le tour s’arrête sur le résumé, sans requête au modèle', async ($, on) => {
    const w = world(on, connected({ python: () => finished('Corrigé, 3 tests verts.') }))
    await step($, 0, { turnId: 't1' })
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: "fini('Corrigé, 3 tests verts.')" })
    const { chunks, result } = await streamed($, 1, { turnId: 't1' })
    expect(w.steps.map(s => s.index)).toEqual([0])
    expect(result).toEqual({ turnId: 't1', index: 1, answer: 'Corrigé, 3 tests verts.', toolUses: [], stopReason: 'end_turn', usage: null })
    expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'Corrigé, 3 tests verts.' }, { kind: 'stop', stopReason: 'end_turn', usage: null }])
    // Le tour suivant interroge le modèle comme d'habitude.
    await step($, 0, { turnId: 't2' })
    expect(w.steps.map(s => [s.turnId, s.index])).toEqual([['t1', 0], ['t2', 0]])
  })

  test('l’appel python qui finit reste compté, sur l’étape suivante qui part au modèle', async ($, on) => {
    const w = world(on, connected({ python: () => finished('fait') }))
    await step($, 0, { turnId: 't1' })
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: "fini('fait')" })
    await step($, 1, { turnId: 't1' })
    await step($, 0, { turnId: 't2' })
    const steps = await sentSteps($, w)
    expect(steps.map(s => s.kernel_calls)).toEqual([undefined, 1])
  })

  test('résumé multiligne gardé tel quel', async ($, on) => {
    world(on, connected({ python: () => finished('Ligne 1\nLigne 2\n[noyau:fini]\ndans le texte') }))
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: 'fini(r)' })
    expect((await step($, 1)).answer).toBe('Ligne 1\nLigne 2\n[noyau:fini]\ndans le texte')
  })

  test('le marqueur imprimé par le code dans la sortie (premier bloc) n’arrête rien', async ($, on) => {
    const w = world(on, connected({ python: () => ['avant\n[noyau:fini]\nfaux'] }))
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: 'print(x)' })
    await step($, 1)
    expect(w.steps.map(s => s.index)).toEqual([1])
  })

  test('cellule en erreur : jamais d’arrêt', async ($, on) => {
    const w = world(on, connected({ python: () => ({ error: finished('fait', 'Traceback') }) }))
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: "fini('fait')" })
    await step($, 1)
    expect(w.steps.map(s => s.index)).toEqual([1])
  })

  test('fini dans un sous-agent : sa boucle et le fil principal continuent', async ($, on) => {
    const w = world(on, connected({ python: () => finished('fait') }))
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: "fini('fait')", agentId: 'agent-1' })
    await step($, 1, { agentId: 'agent-1', turnId: 'a1' })
    await step($, 1, { turnId: 't1' })
    expect(w.steps.map(s => [s.agentId, s.index])).toEqual([['agent-1', 1], [undefined, 1]])
  })

  test('tour interrompu après fini : le tour suivant n’hérite pas du résumé', async ($, on) => {
    const w = world(on, connected({ python: () => finished('fait') }))
    await step($, 0, { turnId: 't1' })
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: "fini('fait')" })
    expect((await step($, 0, { turnId: 't2' })).answer).toBe('')
    await step($, 1, { turnId: 't2' })
    expect(w.steps.map(s => [s.turnId, s.index])).toEqual([['t1', 0], ['t2', 0], ['t2', 1]])
  })

  test('levier coupé ou noyau absent : le marqueur ne fait rien', async ($, on) => {
    const w = world(on, connected({ env: { TOKFIT_OFF: 'kernel' }, python: () => finished('fait') }))
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: "fini('fait')" })
    await step($, 1)
    expect(w.steps.map(s => s.index)).toEqual([1])
  })

  test('arrêt par fini : un hook Stop qui relance (completion.py) est neutralisé, une fois', async ($, on) => {
    world(on, connected({ python: () => finished('fait'), stop: () => ({ block: 'Termine les étapes du plan.' }) }))
    await step($, 0, { turnId: 't1' })
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: "fini('fait')" })
    await step($, 1, { turnId: 't1' })
    expect(await $.classic.Stop({ stop_hook_active: false })).toEqual({})
    // Fin ordinaire du tour suivant : la relance du plan ouvert garde son effet.
    await step($, 0, { turnId: 't2' })
    expect(await $.classic.Stop({ stop_hook_active: false })).toEqual({ block: 'Termine les étapes du plan.' })
  })
})

describe('levier sans effet', () => {
  async function untouched($: Engine): Promise<void> {
    expect(await placement($, 'Read')).toEqual({ description: 'outil Read' })
    expect(await placement($, 'Bash')).toEqual({ description: 'outil Bash' })
    expect(await placement($, PYTHON, OURS, true)).toEqual({ description: `outil ${PYTHON}`, isDeferred: true })
    expect((await check($, 'Bash')).decision).toBe('allow')
    expect(await placement($, 'Workflow')).toEqual({ description: 'outil Workflow' })
    expect(await attachment($, 'auto_mode', AUTO_MODE)).toBe(AUTO_MODE)
    expect(await attachment($, 'skill_listing', SKILLS)).toBe(SKILLS)
    const ids = (await $.prompt.compose(COMPOSE)).sections.map(section => section.id)
    expect(ids).toContain('tools')
    expect(ids).not.toContain('tokfit:kernel')
  }

  test('outil python absent de la liste : rien ne change, l’étape suivante porte kernel_unavailable', async ($, on) => {
    const w = world(on, connected({ tools: TOOLS.filter(tool => tool !== PYTHON) }))
    await untouched($)
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: 'print(1)' })
    await step($, 0, { turnId: 't1' })
    const steps = await sentSteps($, w)
    expect(steps.map(s => [s.kernel_unavailable, s.kernel_calls, s.kernel_denied])).toEqual([[true, undefined, undefined]])
  })

  test('python connecté après le premier rendu : le levier prend dès qu’il apparaît', async ($, on) => {
    const tools = TOOLS.filter(tool => tool !== PYTHON)
    world(on, connected({ tools }))
    expect((await placement($, 'Read')).isDeferred).toBeUndefined()
    tools.push(PYTHON)
    expect(await placement($, 'Read')).toEqual({ description: 'outil Read', isDeferred: true, breakPromptCache: true })
  })

  test('TOKFIT_OFF=kernel : aucun effet, aucun fait', async ($, on) => {
    const w = world(on, connected({ env: { TOKFIT_OFF: 'kernel' } }))
    await untouched($)
    await step($, 0, { turnId: 't1' })
    await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: 'print(1)' })
    await step($, 1, { turnId: 't1' })
    const steps = await sentSteps($, w)
    expect(steps.map(s => [s.kernel_unavailable, s.kernel_calls])).toEqual([[undefined, undefined], [undefined, undefined]])
  })

  test('levier mis en témoin par le service (/v1/levers) : aucun effet', async ($, on) => {
    const w = world(on, connected({ levers: () => ({ status: 200, body: { off: ['kernel'] } }) }))
    await untouched($)
    await step($, 0, { turnId: 't1' })
    const steps = await sentSteps($, w)
    expect(steps.map(s => s.kernel_unavailable)).toEqual([undefined])
  })

  test('client sans configuration : aucun effet (adresse officielle seule en copie publique)', async ($, on) => {
    const w = world(on, connected({ config: null }))
    if (!DEFAULT_URL) await untouched($)
    else await placement($, 'Read')
    await unconfigured(w.sent, () => {})
  })

  const failures: [string, Reply][] = [['en panne', 'down'], ['qui refuse (402)', { status: 402 }],
    ['sans partie claude', { status: 200, body: { version: 'v' } }]]
  for (const [name, reply] of failures) {
    test(`service ${name} : aucun effet, aucun fait`, async ($, on) => {
      const w = world(on, connected({ content: () => reply }))
      await untouched($)
      await step($, 0, { turnId: 't1' })
      const steps = await sentSteps($, w)
      expect(steps.map(s => s.kernel_unavailable)).toEqual([undefined])
    })
  }

  test('service muet : la première étape part après le délai du plan, sans levier', async ($, on) => {
    const w = world(on, connected({ content: () => 'silent' }))
    const pending = step($, 0, { turnId: 't1' })
    await w.clock.advance(PLAN_TIMEOUT_MS)
    await pending
    expect(w.steps).toHaveLength(1)
    await untouched($)
  })

  test('plan redemandé après un échec, au plus tôt après le délai de reprise', async ($, on) => {
    let up = false
    const w = world(on, connected({ content: () => (up ? { status: 200, body: { version: 'v', claude: TEST_PLAN } } : 'down') }))
    await untouched($)
    up = true
    await untouched($)
    expect(w.contentCalls()).toHaveLength(1)
    await w.clock.advance(PLAN_RETRY_MS)
    expect((await placement($, 'Read')).isDeferred).toBe(true)
    expect(w.contentCalls()).toHaveLength(2)
  })

  test('ToolSearch, levier coupé : sa réponse entière', async ($, on) => {
    world(on, connected({ env: { TOKFIT_OFF: 'kernel' }, search: () => ['Read'] }))
    const found = await $.tool.call({ tool: 'ToolSearch', tool_use_id: 'tu-1', query: 'select:Read', max_results: 5 })
    expect((found.result as { matches: string[] }).matches).toEqual(['Read'])
  })

  test('plan sans levier kernel lisible : aucun effet, les autres leviers restent', async ($, on) => {
    const kernel = { ...TEST_PLAN.kernel, denied: 'Read' }
    world(on, connected({ content: () => ({ status: 200, body: { version: 'v', claude: { ...TEST_PLAN, kernel } } }) }))
    await untouched($)
    const ids = (await $.prompt.compose(COMPOSE)).sections.map(section => section.id)
    expect(ids).toContain(THINKING_SECTION.id)
  })
})

test('le code passé à python n’apparaît dans aucune requête au service', async ($, on) => {
  const WITNESS = 'TEMOIN-noyau-91c2-code-libre'
  const w = world(on, connected({ python: () => `sortie ${WITNESS}` }))
  await step($, 0, { turnId: 't1' })
  await $.tool.call({ tool: PYTHON, tool_use_id: 'tu-1', code: `secret = "${WITNESS}"; print(secret)` })
  await step($, 1, { turnId: 't1' })
  const steps = await sentSteps($, w)
  expect(steps.map(s => s.kernel_calls)).toEqual([undefined, 1])
  expect(w.sent.length).toBeGreaterThan(0)
  expect(JSON.stringify(w.sent)).not.toContain(WITNESS)
  expect(w.written).toEqual([])
  expect(JSON.stringify(w.shown)).not.toContain(WITNESS)
})

describe('consigne de retour (client admin)', () => {
  const FEEDBACK = 'TEST-consigne-retour'

  test('plan d’un client admin : la consigne en fin de prompt système', async ($, on) => {
    world(on, connected({ content: () => ({ status: 200, body: { version: 'v', claude: { ...TEST_PLAN, feedback: { section: FEEDBACK } } } }) }))
    const sections = (await $.prompt.compose(COMPOSE)).sections
    expect(sections.map(section => section.id)).toEqual(['intro', 'tone', 'tokfit:kernel', THINKING_SECTION.id, EXECUTION_SECTION.id,
      'tokfit:feedback'])
    expect(sections.at(-1)).toEqual({ id: 'tokfit:feedback', text: FEEDBACK, scope: 'session' })
  })

  test('plan sans consigne de retour (client non admin) : aucune section de plus', async ($, on) => {
    world(on, connected())
    const ids = (await $.prompt.compose(COMPOSE)).sections.map(section => section.id)
    expect(ids).not.toContain('tokfit:feedback')
  })
})

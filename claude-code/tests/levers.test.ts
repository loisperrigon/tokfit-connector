// Faits des leviers joints aux compteurs (des nombres, jamais de texte), et
// réflexion en anglais par une section fixe du prompt système.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { FANOUT_WAIT_MS } from '../hooks/fanout'
import { THINKING_SECTION, EXECUTION_SECTION, language } from '../hooks/thinking'
import { CORE_PROMPT, URL, complete, config, end, spawn, step, user, world } from './support'
import type { Reply, World } from './support'

type Sent = Record<string, unknown>

async function sentSteps($: Engine, w: World): Promise<Sent[]> {
  await end($)
  await w.clock.settle()
  return w.usages().flatMap(sent => sent.body.steps as Sent[])
}

// Faits d'un rendu du prompt système, tels que le moteur les résout.
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] }

const LONG = Array.from({ length: 1_000 }, (_, n) => `ligne ${n}`).join('\n')

describe('réflexion en anglais', () => {
  test('avec une clé : la section part en fin de prompt système, après celles du moteur', async ($, on) => {
    world(on)
    const prompt = await $.prompt.compose(COMPOSE)
    expect(prompt.sections).toEqual([...CORE_PROMPT, THINKING_SECTION, EXECUTION_SECTION])
    expect(THINKING_SECTION.scope).toBe('session')
  })

  test('sans clé valide : prompt inchangé', async ($, on) => {
    world(on, { config: config(URL, 'mauvaise') })
    expect((await $.prompt.compose(COMPOSE)).sections).toEqual(CORE_PROMPT)
  })

  test('langue du message : anglais, autre, ou trop court pour le dire', () => {
    expect(language('Can you fix the failing test in this file?')).toBe('en')
    expect(language('Peux-tu corriger le test qui échoue dans ce fichier ?')).toBe('other')
    expect(language('ok go')).toBeUndefined()
  })

  test('conversation en français : les étapes portent lean_thinking, un message court ne change rien', async ($, on) => {
    const messages = [user('Peux-tu corriger le test qui échoue dans ce fichier ?')]
    const w = world(on, { messages })
    await step($, 0, { turnId: 't1' })
    messages.push(user('ok go'))
    await step($, 0, { turnId: 't2' })
    messages.push(user('Now please explain what the change does and why it works.'))
    await step($, 0, { turnId: 't3' })
    const steps = await sentSteps($, w)
    expect(steps.map(s => s.lean_thinking)).toEqual([true, true, undefined])
  })
})

describe('faits des leviers', () => {
  test('sortie raccourcie : les caractères retirés partent sur l’étape suivante du fil, une fois', async ($, on) => {
    const w = world(on, { messages: [user('x')], bash: () => ({ stdout: LONG }) })
    await step($, 0, { turnId: 't1' })
    const got = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    const shown = 'result' in got && typeof got.result === 'object' && got.result !== null ? (got.result as { stdout: string }).stdout : ''
    await step($, 1, { turnId: 't1' })
    await step($, 2, { turnId: 't1' })
    const steps = await sentSteps($, w)
    expect(steps.map(s => s.trimmed_chars)).toEqual([undefined, LONG.length - shown.length, undefined])
  })

  test('compaction du connecteur : la première étape après porte le contexte d’avant', async ($, on) => {
    const w = world(on, { messages: [user('x')], compact: (): Reply => ({ status: 200, body: { compact: true } }), contextTokens: () => 300_000 })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(240_000)
    expect(w.compactions).toHaveLength(1)
    await step($, 0, { turnId: 't2' })
    await step($, 1, { turnId: 't2' })
    const steps = await sentSteps($, w)
    expect(steps.map(s => s.compacted_from)).toEqual([undefined, 300_000, undefined])
  })

  test('après une compaction : seuls les fichiers déjà lus, inchangés, relus comptent, une fois', async ($, on) => {
    const files: Record<string, string> = { '/p/a.ts': 'a'.repeat(1_000), '/p/b.ts': 'b'.repeat(2_000), '/p/c.ts': 'c'.repeat(4_000) }
    const w = world(on, { messages: [user('x')], compact: (): Reply => ({ status: 200, body: { compact: true } }),
      read: path => files[path] ?? '' })
    await step($, 0, { turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/p/a.ts' })
    await $.tool.call({ tool: 'Read', file_path: '/p/b.ts' })
    // Relu avant toute compaction : rien.
    await $.tool.call({ tool: 'Read', file_path: '/p/a.ts' })
    await step($, 1, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(240_000)
    expect(w.compactions).toHaveLength(1)
    await step($, 0, { turnId: 't2' })
    await $.tool.call({ tool: 'Read', file_path: '/p/a.ts' })
    await $.tool.call({ tool: 'Read', file_path: '/p/a.ts' })
    await $.tool.call({ tool: 'Read', file_path: '/p/c.ts' })
    await $.tool.call({ tool: 'Edit', file_path: '/p/b.ts', old_string: 'b', new_string: 'B' })
    await $.tool.call({ tool: 'Read', file_path: '/p/b.ts' })
    await step($, 1, { turnId: 't2' })
    await step($, 2, { turnId: 't2' })
    const steps = await sentSteps($, w)
    expect(steps.map(s => s.reread_chars)).toEqual([undefined, undefined, undefined, 1_000, undefined])
  })

  test('sous-agents d’un même type : celui qui a attendu porte fanout', async ($, on) => {
    let open = (): void => undefined
    const opened = new Promise<void>(resolve => { open = resolve })
    const w = world(on, { messages: [user('x')], holdAgent: () => opened })
    for (const _ of [1, 2]) await spawn($, 'tâche', { type: 'Explore' })
    const runs = [step($, 0, { turnId: 'a1', agentId: 'agent-1' }), step($, 0, { turnId: 'a2', agentId: 'agent-2' })]
    await w.clock.settle()
    await w.clock.advance(FANOUT_WAIT_MS)
    open()
    await Promise.all(runs)
    const steps = await sentSteps($, w)
    expect(steps.map(s => s.fanout)).toEqual([undefined, true])
  })
})

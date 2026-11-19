// Langue des textes du connecteur (hooks/lang.ts) : celle que rend le service (`language` de /v1/levers),
// le français tant qu'il ne l'a pas dite ; la demande joint la locale du système, un fait neutre.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { FRAMES, FRAME_MS, badgeText, gainOf, statusText } from '../hooks/badge'
import type { Badge } from '../hooks/badge'
import { locale, resetLanguage, setLanguage } from '../hooks/lang'
import { DETAILS, REASONS, codeModeText, healthReport, notice } from '../hooks/python'
import type { Diagnosis } from '../hooks/python'
import { note, trim } from '../hooks/output'
import { degradedNote } from '../hooks/outage'
import { NAME } from '../hooks/service'
import { refusedText } from '../hooks/single'
import { refusedKeyText } from '../hooks/trial'
import { updateNotice } from '../hooks/versions'
import { HOME, complete, step, user, world } from './support'
import type { Reply } from './support'

const PROPS = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: {} }
const PRESENTATION = { isFullscreen: false, columns: 120 }
const BILAN = { saved_usd: 74.2, reference_cost: 161.3, saved_percent: 46, seconds_saved: 9540, saved_kind: 'estimated', text: 'x' }
const LAUNCH = `${HOME}/.cache/tokfit/python/launch.json`
const MANIFEST = `${decodeURIComponent(new URL('..', (import.meta as unknown as { url: string }).url).pathname).replace(/\/$/, '')}/.claude-plugin/plugin.json`
const FILES = { [MANIFEST]: JSON.stringify({ name: 'tokfit', version: '0.7.12' }),
  [LAUNCH]: JSON.stringify({ source: 'managed', version: '3.13.18', path: '/p', target: 'x', at: 1 }) }

function english(languageOf: string): () => Reply {
  return () => ({ status: 200, body: { off: ['warm'], disabled: ['routing'], min_version: '0.8.0', language: languageOf } })
}

// Accents et guillemets du français, et ses mots courants absents de l'anglais : aucun dans un texte anglais.
const ACCENTS = /[àâäçéèêëîïôöûùüÿœæÀÂÇÉÈÊËÎÏÔÛÙÜŒ«»]/
const FRENCH = new Set(['le', 'la', 'les', 'des', 'du', 'est', 'et', 'une', 'pour', 'avec', 'sur', 'sans', 'vous', 'votre',
  'dans', 'pas', 'par', 'actif', 'inactif', 'leviers', 'outil', 'principal', 'relance', 'joignable', 'injoignable',
  'aucun', 'prochaine', 'essai', 'cette', 'ses', 'jamais', 'lignes', 'masquées', 'gardées', 'fois', 'encore',
  'moins', 'attente', 'mise', 'jour', 'connecteur', 'ancien', 'tableau', 'bord'])

function frenchIn(text: string): string[] {
  const words = (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter(word => FRENCH.has(word))
  return ACCENTS.test(text) ? [...words, text.match(ACCENTS)?.[0] ?? ''] : words
}

// Le texte en anglais, ou la liste des traces de français trouvées.
function expectEnglish(texts: string[]): void {
  for (const text of texts) expect([text, frenchIn(text)]).toEqual([text, []])
}

async function band($: Engine, key: string): Promise<string | undefined> {
  const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const text = (await ui.find({ key }))?.text
  await ui.unmount()
  return text
}

// Les textes dans la langue anglaise, la langue remise au français ensuite (les autres essais lisent la même).
function inEnglish<T>(run: () => T): T {
  setLanguage('en')
  try {
    return run()
  } finally {
    resetLanguage()
  }
}

describe('langue des textes du connecteur', () => {
  test('le français tant que le service ne l’a pas dite ; la demande joint la locale du système', async ($, on) => {
    const w = world(on, { messages: [user('x')], files: FILES, bilan: () => ({ status: 200, body: BILAN }) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(FRAMES * FRAME_MS * 2)
    expect(await band($, 'tokfit-band')).toContain('74 $ économisés sur 161 $')
    const spoken = locale()
    expect(w.leverCalls()[0]?.body.locale).toBe(spoken)
    if (spoken !== undefined) expect(spoken).toMatch(/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8})*$/)
  })

  test('service anglais : bandeau, ligne de santé et /<NAME> en anglais', async ($, on) => {
    const link = 'https://site.test/en/dashboard?t=x'
    const w = world(on, { messages: [user('x')], files: FILES, levers: english('en'), bilan: () => ({ status: 200, body: BILAN }),
      dashboard: () => ({ status: 200, body: { url: link, text: `Your tokfit dashboard (savings, subscription), link valid for 24 hours: ${link}` } }) })
    await step($, 0, { turnId: 't1' })
    await complete($, 't1')
    await w.clock.settle()
    await w.clock.advance(FRAMES * FRAME_MS * 2)
    expect(await band($, 'tokfit-band')).toBe('✦ tokfit  ≈ $74 saved out of $161  ▰▰▰▰▰▱▱▱▱▱ −46%  ·  ⏱ 2 hr 39 min less waiting')
    expect(await band($, 'tokfit-health')).toBe('tokfit: connector 0.7.12 too old (0.8.0 at least): restart Claude Code to load the automatic update.')
    await $.command.run({ command: NAME, args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
    const logged = w.shown.filter(line => line.startsWith('ui.log '))
    const levers = logged.find(line => line.startsWith('ui.log Levers for this session:')) ?? ''
    expect(levers).toContain('- routing: beta option off (turn it on in the dashboard)')
    expect(levers).toContain('- warm: off (service holdout session)')
    expect(levers).toContain('- compaction: active')
    expect(levers).toContain('Update: connector 0.7.12 too old')
    const health = logged.find(line => line.startsWith('ui.log Main tool:')) ?? ''
    expect(health).toContain('- service: reachable, key accepted')
    expectEnglish(logged)
  })

  test('valeur inconnue du service : la langue ne change pas', async ($, on) => {
    const w = world(on, { messages: [user('x')], files: FILES, levers: english('de') })
    await step($, 0, { turnId: 't1' })
    await w.clock.settle()
    expect(await band($, 'tokfit-health')).toBe('tokfit : connecteur 0.7.12 trop ancien (0.8.0 au moins) : relance Claude Code pour charger la mise à jour automatique.')
  })

  test('la langue d’un chargement ne passe pas au suivant', async ($, on) => {
    const w = world(on, { messages: [user('x')], files: FILES, levers: english('fr') })
    await step($, 0, { turnId: 't1' })
    await w.clock.settle()
    expect(await band($, 'tokfit-health')).toContain('tokfit : connecteur 0.7.12 trop ancien')
  })

  test('chaque texte du connecteur existe en anglais', () => {
    const texts = inEnglish(() => {
      const diagnoses: Diagnosis[] = [...REASONS.map(reason => ({ reason })), ...DETAILS.map(detail => ({ reason: 'install_failed' as const, detail }))]
      const files = [{}, { launch: { source: 'none', reason: 'python_missing' } }, { launch: { source: 'system', version: '3.12', path: '/usr/bin/python3' } },
        { install: { state: 'failed', detail: 'download' }, launch: { source: 'none' } }, { install: { state: 'installing' } },
        { install: { state: 'ready', version: '3.13.18', target: 'x' }, launch: { source: 'managed', version: '3.13.18', path: '/p' } }]
      const reports = diagnoses.flatMap(d => files.map(f => healthReport(d, f, { kernel: false, account: d.reason === 'pack_unavailable' }, 'unreachable', undefined)))
      const gain = gainOf(JSON.stringify(BILAN))!
      const b: Badge = { busy: false, from: 0, gain, delta: 1.2, deltaUntil: 10 }
      const trimmed = trim(Array.from({ length: 400 }, (_, n) => n === 200 ? 'error: boom' : n > 300 ? 'same' : `line ${n}`).join('\n'),
        { long: 50, head: 10, tail: 10, kept: 5, repeat: 3, important: ['error'], noisy: [], modules: [], readers: [] })
      return [...diagnoses.map(d => notice(d) ?? ''), ...reports, codeModeText(), badgeText(gain), badgeText({ ...gain, reference: undefined }),
        statusText(b, 0) ?? '', updateNotice('0.7.1', '0.8.0') ?? '', refusedKeyText('tokfit'), degradedNote({ since: 1, until: 0, wait: 0 }) ?? '',
        refusedText(), note(12), trimmed.text]
    })
    expect(texts.join('\n')).toContain('2 hr 39 min less waiting')
    expect(texts.join('\n')).toContain('lines hidden')
    expectEnglish(texts)
    // Le contrôle repère bien le français.
    expect(frenchIn('Leviers de cette session : actif')).not.toEqual([])
    expect(frenchIn(badgeText(gainOf(JSON.stringify(BILAN))!))).not.toEqual([])
  })
})

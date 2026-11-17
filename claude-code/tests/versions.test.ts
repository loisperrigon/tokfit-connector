// Versions jointes une fois par session (`versions` de /v1/levers), version minimale annoncée par le
// service (bandeau : relancer Claude Code), routage bêta coupé sur le compte (`disabled`) dit par `/<NAME>`.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { HOME, step, user, world } from './support'
import type { Options, World } from './support'
import { NAME } from '../hooks/service'
import { older, updateNotice } from '../hooks/versions'

const PROPS = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: {} }
const PRESENTATION = { isFullscreen: false, columns: 120 }
const LAUNCH = `${HOME}/.cache/tokfit/python/launch.json`
// Racine du plugin dans le moteur d'essai : ce dossier même.
const MANIFEST = `${decodeURIComponent(new URL('..', (import.meta as unknown as { url: string }).url).pathname).replace(/\/$/, '')}/.claude-plugin/plugin.json`

function base(options: Options = {}): Options {
  return {
    messages: [user('corrige le test')], version: '2.1.300',
    files: { [MANIFEST]: JSON.stringify({ name: 'tokfit', version: '0.7.12' }),
      [LAUNCH]: JSON.stringify({ source: 'managed', version: '3.13.18', path: '/p', target: 'x', at: 1 }) },
    ...options,
  }
}

async function shown($: Engine): Promise<string | undefined> {
  const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const text = (await ui.find({ key: 'tokfit-health' }))?.text
  await ui.unmount()
  return text
}

async function command($: Engine, w: World): Promise<string> {
  await $.command.run({ command: NAME, args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
  return w.shown.find(line => line.startsWith('ui.log Leviers')) ?? ''
}

describe('versions du connecteur', () => {
  test('comparaison nombre par nombre ; version illisible jamais trop ancienne', () => {
    expect(older('0.7.9', '0.7.12')).toBe(true)
    expect(older('0.7.12', '0.7.12')).toBe(false)
    expect(older('0.10.0', '0.9.9')).toBe(false)
    expect(older('dev', '0.7.12')).toBe(false)
    expect(updateNotice('0.7.12', undefined)).toBeNull()
    expect(updateNotice('0.7.11', '0.7.12')).toContain('relance Claude Code')
  })

  test('une demande par session porte plugin, Python, Claude Code et application hôte', async ($, on) => {
    const w = world(on, base({ env: { ECONOMISEUR_HOST_VERSION: 'alfie-mac 0.1.0 abc1234' } })) // publish: keep
    await step($, 0)
    await step($, 1)
    expect(w.leverCalls()).toHaveLength(1)
    expect(w.leverCalls()[0]?.body.versions).toEqual({ plugin: '0.7.12', python: '3.13.18', claude_code: '2.1.300', host: 'alfie-mac 0.1.0 abc1234' })
  })

  test('hors application hôte et Python pas encore lancé : les champs lisibles seuls', async ($, on) => {
    const w = world(on, base({ files: { [MANIFEST]: JSON.stringify({ version: '0.7.12' }) } }))
    await step($, 0)
    expect(w.leverCalls()[0]?.body.versions).toEqual({ plugin: '0.7.12', claude_code: '2.1.300' })
  })

  test('sous la version minimale du service : le bandeau dit de relancer Claude Code', async ($, on) => {
    const w = world(on, base({ levers: () => ({ status: 200, body: { off: [], disabled: [], min_version: '0.8.0' } }) }))
    await step($, 0)
    await w.clock.settle()
    expect(await shown($)).toContain('connecteur 0.7.12 trop ancien (0.8.0 au moins) : relance Claude Code')
    expect(await command($, w)).toContain('Mise à jour : connecteur 0.7.12 trop ancien')
  })

  test('à jour, ou service sans minimum : rien dans le bandeau', async ($, on) => {
    world(on, base({ levers: () => ({ status: 200, body: { off: [], min_version: '0.7.12' } }) }))
    await step($, 0)
    expect(await shown($)).toBeUndefined()
  })
})

describe(`routage bêta coupé sur le compte (/${NAME})`, () => {
  test('la ligne du routage le dit au lieu de « actif »', async ($, on) => {
    const w = world(on, base({ levers: () => ({ status: 200, body: { off: [], disabled: ['routing'] } }) }))
    const report = await command($, w)
    expect(report).toContain('- routing : option bêta coupée')
    expect(report).not.toContain('- routing : actif')
    expect(report).toContain('- warm : actif')
  })

  test('service d’avant ce champ : routage actif comme avant', async ($, on) => {
    const w = world(on, base({ levers: () => ({ status: 200, body: { off: [] } }) }))
    expect(await command($, w)).toContain('- routing : actif')
  })
})

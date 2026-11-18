// Santé de l'outil principal (hooks/python.ts) : raison de l'absence de `agir` lue dans l'état du lanceur
// (kernel/launch.sh) et la liste des outils, montrée au-dessus de la saisie, jointe à l'étape, détaillée par
// `/<NAME>`. Rien n'est écrit sur la machine.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { CHECK_FAST_MS, CODE_MODE_TEXT, INSTALL_STALE_S, START_GRACE_MS, diagnose, notice } from '../hooks/python'
import type { PythonFiles } from '../hooks/python'
import { NAME } from '../hooks/service'
import { HOME, end, step, user, world } from './support'
import type { World } from './support'

const AGIR = 'mcp__plugin_tokfit_outils__agir'
const COMPTE = 'mcp__plugin_tokfit_outils__compte'
const CACHE = `${HOME}/.cache/tokfit/python`
const PROPS = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: {} }
const PRESENTATION = { isFullscreen: false, columns: 120 }
// Horloge du monde simulé : 1 000 000 ms.
const NOW_S = 1000
const MANAGED = `${CACHE}/cpython-3.13.18+20261110-aarch64-unknown-linux-gnu/bin/python3`

function launch(source: string, reason = '', detail = '', target = 'aarch64-unknown-linux-gnu'): string {
  return JSON.stringify({ source, reason, detail, path: source === 'none' ? '' : MANAGED, version: source === 'none' ? '' : '3.13.18', target, at: NOW_S })
}

function install(state: string, reason = '', detail = '', at = NOW_S): string {
  return JSON.stringify({ state, reason, detail, version: '3.13.18', target: 'aarch64-unknown-linux-gnu', at, pid: 42 })
}

function files(installed?: string, launched?: string): Record<string, string> {
  return { ...(installed ? { [`${CACHE}/install.json`]: installed } : {}), ...(launched ? { [`${CACHE}/launch.json`]: launched } : {}) }
}

function parsed(f: Record<string, string>): PythonFiles {
  const read = (name: string): Record<string, unknown> | undefined => {
    const text = f[`${CACHE}/${name}.json`]
    return text === undefined ? undefined : JSON.parse(text) as Record<string, unknown>
  }
  const [i, l] = [read('install'), read('launch')]
  return { ...(i ? { install: i } : {}), ...(l ? { launch: l } : {}) }
}

async function shown($: Engine): Promise<string | undefined> {
  const ui = await $.ui.mount({ plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const text = (await ui.find({ key: 'tokfit-health' }))?.text
  await ui.unmount()
  return text
}

async function started($: Engine, w: World): Promise<void> {
  await $.session.start({ cwd: '/projet', surface: null, isInteractive: true })
  await w.clock.settle()
}

describe('raison de l’absence de agir', () => {
  const at = NOW_S * 1000
  test('chaque raison, depuis l’état du lanceur et les outils proposés', () => {
    const cases: [PythonFiles, boolean, boolean, ReturnType<typeof diagnose>][] = [
      [parsed(files(install('installing'), launch('none', 'python_installing'))), false, false, { reason: 'python_installing' }],
      [parsed(files(install('failed', 'python_missing', 'no_downloader'), launch('none', 'python_missing', 'no_downloader'))), false, false,
        { reason: 'python_missing', detail: 'no_downloader' }],
      [parsed(files(install('failed', 'install_failed', 'checksum'), launch('none', 'install_failed', 'checksum'))), false, false,
        { reason: 'install_failed', detail: 'checksum' }],
      // L'installation a échoué pendant que le lanceur répondait seul.
      [parsed(files(install('failed', 'install_failed', 'download'), launch('none', 'python_installing'))), false, false,
        { reason: 'install_failed', detail: 'download' }],
      [parsed(files(install('installing', '', '', NOW_S - INSTALL_STALE_S - 1), launch('none', 'python_installing'))), false, false,
        { reason: 'install_failed', detail: 'interrupted' }],
      // Windows : le noyau y tourne (0.7.12) ; un outil absent avec `compte` proposé est un paquet pas reçu.
      [parsed(files(install('ready'), launch('managed', '', '', 'x86_64-pc-windows-msvc'))), false, true, { reason: 'pack_unavailable' }],
      [parsed(files(install('ready'), launch('managed'))), false, true, { reason: 'pack_unavailable' }],
      [parsed(files(install('ready'), launch('managed'))), false, false, { reason: 'server_down' }],
      [parsed(files()), false, false, { reason: 'server_down', detail: 'no_launch' }],
      [parsed(files(install('ready'), launch('managed'))), true, true, null],
      // Code inconnu de ce connecteur : la raison sans détail.
      [parsed(files(undefined, launch('none', 'python_missing', 'quelque_chose'))), false, false, { reason: 'python_missing' }],
    ]
    for (const [f, kernel, account, expected] of cases) expect(diagnose(kernel, account, f, true, at, at - START_GRACE_MS)).toEqual(expected)
  })

  test('clé refusée par le service : dit avant « paquet non reçu », seulement quand le connecteur est relié', () => {
    const f = parsed(files(install('ready'), launch('managed')))
    expect(diagnose(false, true, f, true, at, at - START_GRACE_MS, true)).toEqual({ reason: 'key_refused' })
    expect(diagnose(false, false, f, true, at, at - START_GRACE_MS, true)).toEqual({ reason: 'key_refused' })
    expect(diagnose(true, true, f, true, at, at - START_GRACE_MS, true)).toBeNull()
    expect(diagnose(false, false, f, false, at, at - START_GRACE_MS, true)).toBeNull()
  })

  test('Code Mode actif (outil REPL du moteur) : raison code_mode, agir proposé ou non, avant toute autre', () => {
    const f = parsed(files(install('ready'), launch('managed')))
    expect(diagnose(true, true, f, true, at, at - START_GRACE_MS, false, true)).toEqual({ reason: 'code_mode' })
    expect(diagnose(false, false, f, true, at, at - START_GRACE_MS, true, true)).toEqual({ reason: 'code_mode' })
    expect(diagnose(true, true, f, true, at, at - START_GRACE_MS, false, false)).toBeNull()
  })

  test('serveur lancé depuis moins que le délai de démarrage : pas une panne ; non relié : rien à juger', () => {
    const f = parsed(files(install('ready'), launch('managed')))
    expect(diagnose(false, false, f, true, at, at - 1000)).toEqual({ reason: 'server_starting' })
    expect(notice({ reason: 'server_starting' })).toBeNull()
    expect(diagnose(false, false, f, false, at, at - START_GRACE_MS)).toBeNull()
  })

  test('lignes du bandeau', () => {
    expect(notice({ reason: 'python_installing' })).toBe('aucun Python 3.9+ sur la machine : téléchargement de Python en cours, l\'outil principal arrive')
    expect(notice({ reason: 'python_missing', detail: 'no_downloader' }))
      .toBe('outil principal indisponible (aucun outil de téléchargement : installez curl ou wget)')
    expect(notice({ reason: 'install_failed', detail: 'checksum' })).toMatch(/^installation de Python échouée \(archive altérée/)
    expect(notice({ reason: 'pack_unavailable' })).toBe('outil principal en attente du service (pas encore de réponse) : /tokfit pour le détail')
    expect(notice({ reason: 'key_refused' })).toMatch(/^clé tokfit refusée par le service \(remplacée ou révoquée\), clé d'essai comprise : \/tokfit/)
    expect(notice({ reason: 'code_mode' })).toBe('bridé par Code Mode, outil principal coupé (Code Mode passe par Bash, Read et Edit, '
      + 'que cet outil remplace). Déconseillé : retirez CLAUDE_CODE_EXPERIMENTAL_CODE_MODE puis relancez Claude Code ; /tokfit pour le détail')
    expect(notice(null)).toBeNull()
  })
})

describe('bandeau, étape et commande', () => {
  test('installation en cours : la ligne s’affiche dès le démarrage et disparaît quand agir arrive', async ($, on) => {
    const tools: string[] = []
    const w = world(on, { messages: [user('x')], tools, files: files(install('installing'), launch('none', 'python_installing')) })
    await started($, w)
    expect(await shown($)).toBe('tokfit : aucun Python 3.9+ sur la machine : téléchargement de Python en cours, l\'outil principal arrive')
    tools.push(AGIR, COMPTE)
    await w.clock.advance(CHECK_FAST_MS)
    expect(await shown($)).toBeUndefined()
    // Rien n'est écrit sur la machine.
    expect(w.written.filter(line => line.startsWith('fs.write'))).toEqual([])
  })

  test('aucun outil de téléchargement : la ligne le dit, l’étape porte la raison codée', async ($, on) => {
    const w = world(on, { messages: [user('x')], tools: [],
      files: files(install('failed', 'python_missing', 'no_downloader'), launch('none', 'python_missing', 'no_downloader')) })
    await started($, w)
    expect(await shown($)).toBe('tokfit : outil principal indisponible (aucun outil de téléchargement : installez curl ou wget)')
    await step($, 0, { turnId: 't1' })
    await end($)
    await w.clock.settle()
    const steps = w.usages().flatMap(sent => sent.body.steps as Record<string, unknown>[])
    expect(steps.map(s => [s.kernel_unavailable, s.kernel_reason, s.kernel_detail])).toEqual([[true, 'python_missing', 'no_downloader']])
  })

  test('paquet du noyau pas reçu (compte seul) : raison jointe à l’étape', async ($, on) => {
    const w = world(on, { messages: [user('x')], tools: [COMPTE], files: files(install('ready'), launch('managed')) })
    await started($, w)
    expect(await shown($)).toBe('tokfit : outil principal en attente du service (pas encore de réponse) : /tokfit pour le détail')
    await step($, 0, { turnId: 't1' })
    await end($)
    await w.clock.settle()
    const steps = w.usages().flatMap(sent => sent.body.steps as Record<string, unknown>[])
    expect(steps.map(s => [s.kernel_reason, s.kernel_detail])).toEqual([['pack_unavailable', undefined]])
  })

  test('clé refusée par le service (401) : la ligne dit quoi faire, puis s’efface quand la clé est acceptée', async ($, on) => {
    let status = 401
    const refusal = { error: 'Clé absente, inconnue ou révoquée.' }
    const w = world(on, { messages: [user('x')], tools: [COMPTE], files: files(install('ready'), launch('managed')),
      content: () => (status === 200 ? { status, body: { version: 'v-test' } } : { status, body: refusal }),
      route: () => (status === 200 ? { status, body: { model: null, effort: null } } : { status, body: refusal }),
      levers: () => (status === 200 ? { status, body: { off: [] } } : { status, body: refusal }),
      usage: () => (status === 200 ? { status, body: { recorded: 1 } } : { status, body: refusal }),
      bilan: () => (status === 200 ? { status, body: {} } : { status, body: refusal }) })
    await started($, w)
    // Refus vu à la demande du plan de session ; la ligne suit au contrôle suivant.
    await w.clock.advance(CHECK_FAST_MS)
    expect(await shown($)).toMatch(/^tokfit : clé tokfit refusée par le service/)
    status = 200
    await step($, 0, { turnId: 't1' })
    await w.clock.advance(CHECK_FAST_MS)
    expect(await shown($)).toBe('tokfit : outil principal en attente du service (pas encore de réponse) : /tokfit pour le détail')
  })

  test('serveur arrêté : rien pendant le démarrage, la ligne ensuite', async ($, on) => {
    const w = world(on, { messages: [user('x')], tools: [], files: files(install('ready'), launch('managed')) })
    await started($, w)
    expect(await shown($)).toBeUndefined()
    await w.clock.advance(START_GRACE_MS)
    expect(await shown($)).toMatch(/^tokfit : outil principal arrêté : \/mcp/)
  })

  test('agir proposé : aucune ligne, aucune raison', async ($, on) => {
    const w = world(on, { messages: [user('x')], tools: [AGIR, COMPTE], files: files(install('ready'), launch('managed')) })
    await started($, w)
    expect(await shown($)).toBeUndefined()
    await step($, 0, { turnId: 't1' })
    await end($)
    await w.clock.settle()
    const steps = w.usages().flatMap(sent => sent.body.steps as Record<string, unknown>[])
    expect(steps.map(s => [s.kernel_unavailable, s.kernel_reason])).toEqual([[undefined, undefined]])
  })

  test('Code Mode actif : la ligne le dit et le déconseille, l’étape porte la raison, /<NAME> explique pourquoi', async ($, on) => {
    const w = world(on, { messages: [user('x')], tools: [AGIR, COMPTE, 'REPL'], files: files(install('ready'), launch('managed')) })
    await started($, w)
    expect(await shown($)).toBe(`tokfit : ${notice({ reason: 'code_mode' })}`)
    await step($, 0, { turnId: 't1' })
    await end($)
    await w.clock.settle()
    const steps = w.usages().flatMap(sent => sent.body.steps as Record<string, unknown>[])
    expect(steps.map(s => [s.kernel_unavailable, s.kernel_reason])).toEqual([[true, 'code_mode']])
    await $.command.run({ command: NAME, args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
    const report = w.shown.find(line => line.startsWith('ui.log Outil principal :'))
    expect(report).toContain('- outil agir : proposé, levier coupé (Code Mode actif)')
    expect(report).toContain(CODE_MODE_TEXT)
    expect(w.shown.join('\n')).toContain(`- kernel : coupé (${notice({ reason: 'code_mode' })})`)
  })

  test('un outil REPL d’un serveur MCP n’est pas Code Mode', async ($, on) => {
    const w = world(on, { messages: [user('x')], tools: [AGIR, COMPTE, 'mcp__labo__REPL'], files: files(install('ready'), launch('managed')) })
    await started($, w)
    expect(await shown($)).toBeUndefined()
  })

  test('/<NAME> : diagnostic complet (Python, installation, serveur, outils, service, version)', async ($, on) => {
    const w = world(on, { tools: [AGIR, COMPTE], files: files(install('ready'), launch('managed')), dashboard: () => ({ status: 401 }) })
    await $.command.run({ command: NAME, args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
    const report = w.shown.find(line => line.startsWith('ui.log Outil principal :'))
    expect(report).toContain(`- Python : 3.13.18 installé par tokfit (${MANAGED})`)
    expect(report).toContain('- installation de Python : prête (3.13.18, aarch64-unknown-linux-gnu)')
    expect(report).toContain('- serveur MCP « outils » : démarré')
    expect(report).toContain('- outil agir : proposé')
    expect(report).toContain('- outil compte : proposé')
    expect(report).toContain('- service : joignable, clé refusée (401)')
    expect(report).toMatch(/- connecteur : /)
  })

  test('cache imposé par TOKFIT_CACHE_DIR, puis XDG_CACHE_HOME', async ($, on) => {
    const own = '/tmp/cache-tokfit'
    const w = world(on, { messages: [user('x')], tools: [], env: { TOKFIT_CACHE_DIR: own },
      files: { [`${own}/python/install.json`]: install('installing'), [`${own}/python/launch.json`]: launch('none', 'python_installing') } })
    await started($, w)
    expect(await shown($)).toBe('tokfit : aucun Python 3.9+ sur la machine : téléchargement de Python en cours, l\'outil principal arrive')
  })
})

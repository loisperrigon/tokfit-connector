// Leviers éteints sans signal (15/11/2026 : `/v1/content` en 404 derrière un relais) : le plan
// absent part au service avec le code reçu, la personne le voit une fois, et `/<NAME>` montre
// l'état réel de chaque levier.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { TEST_PLAN } from './plan'
import { config, end, messages, step, unconfigured, user, world } from './support'
import type { Options, Reply, World } from './support'
import { PLAN_RETRY_MS } from '../hooks/plan'
import { NAME } from '../hooks/service'
import { LEVERS } from '../hooks/state'
import { KERNEL_TOOL } from '../hooks/kernel'

type Sent = Record<string, unknown>

// Nom que Claude Code donne à l'outil du noyau du plugin (kernel.ts).
const PYTHON = KERNEL_TOOL
const PRESENTATION = { isFullscreen: false, columns: 120 }

function base(options: Options = {}): Options {
  return { messages: [user('corrige le test')], tools: ['Read', PYTHON], ...options }
}

async function sentSteps($: Engine, w: World): Promise<Sent[]> {
  await end($)
  await w.clock.settle()
  return w.usages().flatMap(sent => sent.body.steps as Sent[])
}

function notices(w: World): string[] {
  return messages(w).filter(line => line.includes('Économies en pause'))
}

async function command($: Engine, w: World): Promise<string> {
  await $.command.run({ command: NAME, args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
  const report = w.shown.find(line => line.startsWith('ui.log Leviers'))
  return report ?? ''
}

describe('plan de session absent', () => {
  const failures: [string, Reply, number][] = [['route absente du relais (404)', { status: 404 }, 404],
    ['service injoignable', 'down', 0], ['service en erreur (503)', { status: 503 }, 503],
    ['réponse sans partie claude', { status: 200, body: { version: 'v' } }, 200]]
  for (const [name, reply, code] of failures) {
    test(`${name} : chaque étape porte plan_missing=${code}, un seul message à la personne`, async ($, on) => {
      const w = world(on, base({ content: () => reply }))
      await step($, 0, { turnId: 't1' })
      await step($, 1, { turnId: 't1' })
      const steps = await sentSteps($, w)
      expect(steps.map(s => s.plan_missing)).toEqual([code, code])
      const shown = notices(w)
      expect(shown).toHaveLength(1)
      expect(shown[0]).toContain(code === 0 ? 'service injoignable' : `code ${code}`)
      expect(shown[0]).toContain(`/${NAME}`)
    })
  }

  test('plan reçu : aucun fait, aucun message', async ($, on) => {
    const w = world(on, base())
    await step($, 0, { turnId: 't1' })
    expect((await sentSteps($, w)).map(s => s.plan_missing)).toEqual([undefined])
    expect(notices(w)).toEqual([])
  })

  test('essai fini (402) : le fait part, le message reste celui du service (trial.ts)', async ($, on) => {
    const w = world(on, base({ content: () => ({ status: 402, body: { error: 'Essai fini.' } }) }))
    await step($, 0, { turnId: 't1' })
    expect((await sentSteps($, w)).map(s => s.plan_missing)).toEqual([402])
    expect(notices(w)).toEqual([])
  })

  test('plan revenu au nouvel essai : plus de fait sur les étapes suivantes', async ($, on) => {
    let up = false
    const w = world(on, base({ content: () => (up ? { status: 200, body: { version: 'v', claude: TEST_PLAN } } : { status: 404 }) }))
    await step($, 0, { turnId: 't1' })
    up = true
    await w.clock.advance(PLAN_RETRY_MS)
    await step($, 1, { turnId: 't1' })
    expect((await sentSteps($, w)).map(s => s.plan_missing)).toEqual([404, undefined])
    expect(notices(w)).toHaveLength(1)
  })

  // Copie de travail : client non relié, rien ne part, rien n'est montré. Copie publique : relié à
  // l'adresse officielle, le plan absent s'y signale comme ailleurs, vers cette adresse seule.
  test('client sans configuration : aucun fait, aucun message (adresse officielle seule en copie publique)', async ($, on) => {
    const w = world(on, base({ config: null, content: () => ({ status: 404 }) }))
    await step($, 0, { turnId: 't1' })
    await w.clock.settle()
    await unconfigured(w.sent, () => expect(notices(w)).toEqual([]))
  })
})

describe(`état des leviers (/${NAME})`, () => {
  test('une ligne par levier, dans l’ordre du service ; tous actifs avec plan et noyau', async ($, on) => {
    const plan = { ...TEST_PLAN, prefix: { context: ['memory'] } }
    const w = world(on, base({ content: () => ({ status: 200, body: { version: 'v', claude: plan } }) }))
    const report = await command($, w)
    expect(report.split('\n').slice(1)).toEqual(LEVERS.map(([lever]) => `- ${lever} : actif`))
  })

  test('plan absent : leviers du plan inactifs avec le code, routage actif', async ($, on) => {
    const w = world(on, base({ content: () => ({ status: 404 }) }))
    const report = await command($, w)
    expect(report).toContain('- routing : actif')
    expect(report).toContain('- kernel : inactif (plan du service absent, code 404)')
    expect(report).toContain('- warm : inactif (plan du service absent, code 404)')
  })

  test('coupés par l’application, par le service (témoin), absents du plan, noyau non connecté', async ($, on) => {
    const plan = TEST_PLAN
    const w = world(on, base({
      env: { TOKFIT_OFF: 'warm' }, tools: ['Read'],
      levers: () => ({ status: 200, body: { off: ['output'] } }),
      content: () => ({ status: 200, body: { version: 'v', claude: plan } }),
    }))
    const report = await command($, w)
    expect(report).toContain('- warm : coupé (réglage de l\'application ou de l\'utilisateur)')
    expect(report).toContain('- output : coupé (session témoin du service)')
    expect(report).toContain('- prefix : inactif (absent du plan du service)')
    expect(report).toContain('- kernel : inactif (outil agir non connecté)')
    expect(report).toContain('- thinking : actif')
  })

  test('sans adresse ni clé : connecteur non relié', async ($, on) => {
    const w = world(on, base({ config: config('pas une adresse') }))
    expect(await command($, w)).toContain('non relié au service')
  })
})

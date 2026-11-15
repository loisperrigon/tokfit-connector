// Levier prefix : la section du prompt système qui change d'une session à l'autre (chemin de la
// mémoire) en sort et passe dans le contexte du premier message ; le prompt système, alors le même
// à chaque session, est relu en cache au lieu d'être réécrit.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { PREFIX_WAIT_MS } from '../hooks/prefix'
import { TEST_PLAN } from './plan'
import { world } from './support'
import type { Reply } from './support'

const MEMORY = 'TEST-mémoire /tmp/projet/memory/'
const DATE = { name: 'currentDate', text: 'Today is 2026-11-15.' }
const PLAN = { ...TEST_PLAN, prefix: { context: ['memory'] } }
const served = (): Reply => ({ status: 200, body: { version: 'v-test', claude: PLAN } })

async function prompt($: Engine): Promise<{ memory: string | null; other: string | null; blocks: unknown }> {
  const memory = (await $.prompt.section({ name: 'memory', text: MEMORY })).text
  const other = (await $.prompt.section({ name: 'pronouns', text: 'TEST-pronoms' })).text
  const { blocks } = await $.prompt.context({ blocks: [DATE] })
  return { memory, other, blocks }
}

describe('levier prefix', () => {
  test('la section nommée quitte le prompt système et rejoint le contexte du premier message', async ($, on) => {
    world(on, { content: served })
    expect(await prompt($)).toEqual({ memory: null, other: 'TEST-pronoms',
      blocks: [DATE, { name: 'tokfit:memory', text: MEMORY }] })
  })

  test('contexte recalculé (compaction) : la section revient une seule fois', async ($, on) => {
    world(on, { content: served })
    await prompt($)
    const { blocks } = await $.prompt.context({ blocks: [DATE, { name: 'tokfit:memory', text: MEMORY }] })
    expect(blocks).toEqual([DATE, { name: 'tokfit:memory', text: MEMORY }])
  })

  test('contexte calculé avant la section (le moteur fait les deux en même temps) : il l’attend', async ($, on) => {
    const w = world(on, { content: served })
    const context = $.prompt.context({ blocks: [DATE] })
    await w.clock.settle()
    expect((await $.prompt.section({ name: 'memory', text: MEMORY })).text).toBeNull()
    expect((await context).blocks).toEqual([DATE, { name: 'tokfit:memory', text: MEMORY }])
  })

  test('section arrivée après le délai : elle reste dans le prompt système, le contexte n’en dit rien', async ($, on) => {
    const w = world(on, { content: served })
    const context = $.prompt.context({ blocks: [DATE] })
    await w.clock.settle()
    await w.clock.advance(PREFIX_WAIT_MS)
    expect((await context).blocks).toEqual([DATE])
    expect((await $.prompt.section({ name: 'memory', text: MEMORY })).text).toBe(MEMORY)
  })

  test('mémoire coupée (section absente) : aucune attente au-delà de la section, aucun bloc', async ($, on) => {
    const w = world(on, { content: served })
    const context = $.prompt.context({ blocks: [DATE] })
    await w.clock.settle()
    expect((await $.prompt.section({ name: 'memory', text: null })).text).toBeNull()
    expect((await context).blocks).toEqual([DATE])
  })

  test('TOKFIT_OFF=prefix : rien ne bouge', async ($, on) => {
    world(on, { content: served, env: { TOKFIT_OFF: 'prefix' } })
    expect(await prompt($)).toEqual({ memory: MEMORY, other: 'TEST-pronoms', blocks: [DATE] })
  })

  test('plan sans prefix (service plus ancien) : rien ne bouge', async ($, on) => {
    world(on)
    expect(await prompt($)).toEqual({ memory: MEMORY, other: 'TEST-pronoms', blocks: [DATE] })
  })

  test('service en panne : rien ne bouge', async ($, on) => {
    world(on, { content: () => 'down' })
    expect(await prompt($)).toEqual({ memory: MEMORY, other: 'TEST-pronoms', blocks: [DATE] })
  })
})

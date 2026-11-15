// Plan de session de test, tel que le service le rendrait (`POST /v1/content`, partie `claude`) :
// textes factices et paramètres de test, jamais ceux du service.
import type { PromptComposeSection } from 'claude-code'

export const THINKING_TEXT = 'TEST-section-réflexion'
export const PERSISTENCE_TEXT = 'TEST-section-persistance'
export const KERNEL_TEXT = 'TEST-consigne-noyau'
export const REFUSAL = 'TEST-refus-noyau'
export const DENIED = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']
export const DEFERRED = ['Workflow', 'ScheduleWakeup', 'ReportFindings', 'ListAgents']
export const FANOUT_MS = 2_000
export const COMPACT_TEXT = 'TEST-consigne-compaction'
export const PING_TEXT = 'TEST-relance'
// Liste raccourcie en mode noyau, et longueur gardée de chaque entrée.
export const LISTING = { type: 'skill_listing', entry: 40 }
export const OUTPUT = {
  long: 50, head: 10, tail: 20, kept: 5, repeat: 4,
  noisy: ['npm', 'pnpm', 'cargo', 'pytest', 'make', 'jest'], modules: ['pytest', 'unittest'],
  readers: ['tail', 'grep'], important: ['error', 'fail'],
}

export const TEST_PLAN = {
  thinking: { section: THINKING_TEXT },
  persistence: { section: PERSISTENCE_TEXT },
  output: OUTPUT,
  fanout: { wait_ms: FANOUT_MS },
  compaction: { instructions: COMPACT_TEXT },
  warm: { prompt: PING_TEXT },
  kernel: {
    section: KERNEL_TEXT, replaces: 'tools', behind: [...DENIED, ...DEFERRED], denied: DENIED, refusal: REFUSAL,
    attachment: { type: 'auto_mode', contains: 'Bash tool' }, finished: '[noyau:fini]\n', listings: [LISTING],
  },
}

function section(lever: string, text: string): PromptComposeSection {
  return { id: `tokfit:${lever}`, text, scope: 'session' }
}

export const THINKING_SECTION = section('thinking', THINKING_TEXT)
export const EXECUTION_SECTION = section('execution', PERSISTENCE_TEXT)
export const KERNEL_SECTION = section('kernel', KERNEL_TEXT)

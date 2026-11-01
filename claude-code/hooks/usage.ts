// Compteurs de tokens par étape, remontés par lots vers /v1/usage pour le
// tableau de bord. Une étape ne porte que des identifiants et des nombres,
// jamais de texte. Son identifiant est stable (session, agent, tour, rang) :
// un lot renvoyé après une coupure n'est compté qu'une fois par le service.
import type { EngineInterface, PluginOptions, SessionRateLimit, TurnUsage } from 'claude-code'
import { EFFORTS, USAGE_TIMEOUT_MS, link, post } from './service'

// Lot maximal accepté par le service (USAGE_BATCH_MAX de service/usage.py).
export const BATCH_MAX = 50
// Service injoignable longtemps : les plus anciennes étapes tombent (sous-compte,
// jamais double compte) plutôt que de grossir sans fin.
const QUEUE_MAX = 1000

export type Step = {
  step_id: string
  session_id: string
  model: string
  effort?: string
  input: number
  cache_read: number
  cache_write: number
  output: number
  quota_percent?: number
}

export async function stepId(session: string, agentId: string | undefined, turnId: string, index: number): Promise<string> {
  const data = new TextEncoder().encode([session, agentId ?? 'main', turnId, String(index)].join('\n'))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return [...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function stepOf(session: string, agentId: string | undefined, turnId: string, index: number,
                             effort: unknown, usage: TurnUsage, limits: readonly SessionRateLimit[]): Promise<Step> {
  // Quota : la fenêtre la plus entamée, comme la relève le service.
  const used = limits.map(limit => limit.percentUsed).filter(value => Number.isFinite(value))
  return {
    step_id: await stepId(session, agentId, turnId, index),
    session_id: session,
    model: usage.model,
    ...(typeof effort === 'string' && EFFORTS.includes(effort) ? { effort } : {}),
    input: usage.input_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_write: usage.cache_creation_input_tokens,
    output: usage.output_tokens,
    ...(used.length ? { quota_percent: Math.min(100, Math.max(0, ...used)) } : {}),
  }
}

// Étapes en attente d'envoi, l'envoi en cours (un seul à la fois) et la
// configuration du plugin (clé, adresse).
export type Queue = { steps: Step[]; sending: Promise<void> | null; options: PluginOptions }

export function queue(options: PluginOptions): Queue {
  return { steps: [], sending: null, options }
}

// Vrai quand un lot est plein : à envoyer sans attendre la fin du tour.
export function add(q: Queue, step: Step): boolean {
  if (!q.steps.some(queued => queued.step_id === step.step_id)) q.steps.push(step)
  if (q.steps.length > QUEUE_MAX) q.steps.splice(0, q.steps.length - QUEUE_MAX)
  return q.steps.length >= BATCH_MAX
}

// Envoie ce qui attend ; ne lève jamais.
export function flush($: EngineInterface, q: Queue): Promise<void> {
  q.sending ??= send($, q).finally(() => { q.sending = null })
  return q.sending
}

async function send($: EngineInterface, q: Queue): Promise<void> {
  const to = await link($, q.options)
  if (!to) {
    // Clé retirée en cours de session : plus rien à remonter.
    q.steps = []
    return
  }
  while (q.steps.length > 0) {
    const batch = q.steps.slice(0, BATCH_MAX)
    const reply = await post($, to, '/v1/usage', { steps: batch }, USAGE_TIMEOUT_MS)
    // Injoignable, trop lent, débit dépassé ou service en erreur : le lot reste
    // pour l'envoi suivant, avec les mêmes identifiants.
    if (reply === null || reply.status === 408 || reply.status === 429 || reply.status >= 500) return
    // Accepté, ou refusé pour de bon (clé révoquée, lot illisible) : retiré.
    q.steps = q.steps.filter(step => !batch.includes(step))
  }
}

// Faits de durée joints aux compteurs, en millisecondes :
// - `model_ms` : de l'envoi de la requête de l'étape à sa réponse entière ;
// - `tool_ms` : outils lancés par la boucle (fil principal ou sous-agent) depuis
//   son étape précédente, appels simultanés comptés une fois (union des intervalles) ;
// - `turn_ms` : tour du fil principal, de sa première étape à sa fin avec une
//   réponse, posé sur sa dernière étape si elle attend encore l'envoi.
// Une durée nulle ou illisible n'est pas envoyée.
import type { Step } from './usage'

// Plafond de vraisemblance d'une durée (une semaine) : MAX_DURATION_MS de service/usage.py.
export const MAX_MS = 604_800_000

export type TimeFacts = {
  model_ms?: number
  tool_ms?: number
  turn_ms?: number
}

export type Timing = {
  // Début du tour en cours du fil principal (horloge du moteur, ms).
  turnAt: number | undefined
  // Intervalles [début, fin] des outils de chaque boucle (`main` ou identifiant d'agent).
  tools: Map<string, [number, number][]>
  // Dernière étape du fil principal mise en file, et son tour : elle reçoit `turn_ms`.
  last: { turnId: string; step: Step } | undefined
}

export function timing(): Timing {
  return { turnAt: undefined, tools: new Map(), last: undefined }
}

// Durée en millisecondes entières, bornée ; undefined si elle est nulle ou illisible.
export function duration(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  return Math.min(MAX_MS, Math.round(ms))
}

// Première étape d'un tour du fil principal : les outils du fil restés sans étape suivante sont oubliés.
export function began(t: Timing, at: number): void {
  t.turnAt = at
  t.tools.delete('main')
}

export function ran(t: Timing, loop: string, start: number, end: number): void {
  if (!(end > start)) return
  const spans = t.tools.get(loop) ?? []
  spans.push([start, end])
  t.tools.set(loop, spans)
}

// Temps des outils de la boucle depuis son étape précédente (union des intervalles), puis remis à zéro.
export function toolTime(t: Timing, loop: string): TimeFacts {
  const spans = t.tools.get(loop)
  t.tools.delete(loop)
  if (!spans?.length) return {}
  let total = 0
  let end = -Infinity
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const start = Math.max(from, end)
    if (to > start) total += to - start
    end = Math.max(end, to)
  }
  const ms = duration(total)
  return ms === undefined ? {} : { tool_ms: ms }
}

export function modelTime(sent: number, received: number): TimeFacts {
  const ms = duration(received - sent)
  return ms === undefined ? {} : { model_ms: ms }
}

export function queued(t: Timing, turnId: string, step: Step): void {
  t.last = { turnId, step }
}

// Fin d'un tour du fil principal avec sa réponse : sa durée va sur sa dernière étape, si elle est dans `waiting`.
export function ended(t: Timing, turnId: string, at: number, waiting: readonly Step[]): void {
  const last = t.last
  const from = t.turnAt
  t.turnAt = undefined
  t.last = undefined
  if (!last || from === undefined || last.turnId !== turnId || !waiting.includes(last.step)) return
  const ms = duration(at - from)
  if (ms !== undefined) last.step.turn_ms = ms
}

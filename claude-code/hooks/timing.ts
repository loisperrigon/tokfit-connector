// Faits de durée joints aux compteurs, en millisecondes :
// - `model_ms` : de l'envoi de la requête de l'étape à sa réponse entière ;
// - `tool_ms` : phase des outils de la boucle (fil principal ou sous-agent), de la
//   réponse d'une étape qui demande des outils à l'envoi de l'étape suivante du même
//   tour : outils, demandes de permission et crochets compris, appels simultanés
//   comptés une fois. Lue sur les étapes, sans crochet sur les outils : un crochet
//   `tool.call` coupe pour l'outil visé le passage en arrière-plan, sa sortie en
//   direct et l'attente de Code Mode ;
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
  // Fin de la dernière réponse de chaque boucle (`main` ou identifiant d'agent) qui a demandé des outils.
  asked: Map<string, number>
  // Dernière étape du fil principal mise en file, et son tour : elle reçoit `turn_ms`.
  last: { turnId: string; step: Step } | undefined
}

export function timing(): Timing {
  return { turnAt: undefined, asked: new Map(), last: undefined }
}

// Durée en millisecondes entières, bornée ; undefined si elle est nulle ou illisible.
export function duration(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  return Math.min(MAX_MS, Math.round(ms))
}

// Première étape d'un tour du fil principal.
export function began(t: Timing, at: number): void {
  t.turnAt = at
}

// Réponse d'une étape reçue à `at` : si elle demande des outils, leur phase commence.
export function responded(t: Timing, loop: string, at: number, toolUses: number): void {
  if (toolUses > 0) t.asked.set(loop, at)
  else t.asked.delete(loop)
}

// Étape `index` de la boucle sur le point de partir à `at` : temps depuis la réponse qui a demandé des
// outils, dans le même tour seulement (une première étape n'hérite de rien), puis remis à zéro.
export function toolTime(t: Timing, loop: string, index: number, at: number): TimeFacts {
  const from = t.asked.get(loop)
  t.asked.delete(loop)
  if (index === 0 || from === undefined) return {}
  const ms = duration(at - from)
  return ms === undefined ? {} : { tool_ms: ms }
}

// Tour de la boucle fini : une phase d'outils restée ouverte (tour interrompu) est oubliée.
export function closed(t: Timing, loop: string): void {
  t.asked.delete(loop)
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

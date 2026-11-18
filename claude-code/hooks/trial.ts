// Lignes écrites par le service pour la personne, montrées telles quelles une fois
// par processus en ligne de la conversation (`$.ui.log`) : le message de fin
// d'essai (champ `notice` d'une réponse 402) et la phrase qui dit qu'une limite du
// compte a changé le réglage (champ `notice` d'une réponse 200 de /v1/route).
// Rien n'est ajouté au texte, rien n'entre dans le prompt. Seule ligne du
// connecteur lui-même : la clé configurée refusée, remplacée par la clé anonyme.
import type { EngineInterface } from 'claude-code'

// Lignes de la console et de l'écran : le terminal en dessine 2000 caractères.
export const NOTICE_MAX = 2000
// Caractères de contrôle (séquences du terminal comprises) retirés du texte reçu.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

// Textes déjà montrés par ce processus : une réponse rejouée ne les remontre pas.
const shown = new Set<string>()

// Clé configurée refusée par le service (401, 403) : la clé anonyme a pris le relais (service.ts).
export function refusedKeyText(name: string): string {
  return `Clé ${name} configurée refusée par le service (remplacée ou révoquée) : ${name} continue avec une clé ` +
    `d'essai sur cette machine. Pour retrouver votre abonnement, connectez cet appareil à votre compte depuis /${name}.`
}

export function refusedKeyNotice($: EngineInterface, name: string): void {
  const notice = refusedKeyText(name)
  if (shown.has(notice)) return
  shown.add(notice)
  $.ui.log(notice)
}

export function trialNotice($: EngineInterface, status: number, text: string): void {
  if (status === 402) showNotice($, text)
}

// Le champ `notice` d'une réponse du service, montré s'il ne l'a pas déjà été.
export function showNotice($: EngineInterface, text: string): void {
  const notice = noticeOf(text)
  if (!notice || shown.has(notice)) return
  shown.add(notice)
  $.ui.log(notice)
}

function noticeOf(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text)
    const notice = typeof parsed === 'object' && parsed !== null ? (parsed as { notice?: unknown }).notice : undefined
    if (typeof notice !== 'string') return null
    const clean = notice.replace(CONTROL, ' ').trim().slice(0, NOTICE_MAX)
    return clean || null
  } catch {
    // Réponse illisible : rien à montrer.
    return null
  }
}

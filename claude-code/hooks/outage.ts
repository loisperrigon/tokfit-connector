// Panne du service vue par le connecteur : la décision de routage (`/v1/route`, sur le chemin de chaque
// message) ne revient pas. Une coupure franche ne coûte rien ; un service muet coûte TIMEOUT_MS par
// message. Après un délai dépassé, les demandes suivantes ne partent plus pendant `wait` (30 s, doublé à
// chaque nouvel échec jusqu'à 5 min) : les messages partent tout de suite avec le réglage en cours. La
// première réponse du service referme la panne. Pendant une panne, le bandeau dit « tokfit dégradé » :
// Claude Code garde ses outils habituels (kernel.ts rend les outils retirés dès que `agir` manque).
export const FIRST_WAIT_MS = 30_000
export const MAX_WAIT_MS = 300_000

export type Outage = {
  // Premier échec de la panne en cours ; null : service joignable (ou jamais demandé).
  since: number | null
  // Avant cet instant, aucune demande de routage ne part (service muet).
  until: number
  wait: number
}

export function outage(): Outage {
  return { since: null, until: 0, wait: 0 }
}

// Vrai si la demande ne doit pas partir : service muet récemment, attente pas finie.
export function holding(o: Outage, now: number): boolean {
  return now < o.until
}

// Échec d'une demande ; `late` : délai dépassé (service muet), seul cas qui suspend les demandes.
export function failed(o: Outage, now: number, late: boolean): void {
  o.since ??= now
  if (!late) return
  o.wait = Math.min(Math.max(o.wait * 2, FIRST_WAIT_MS), MAX_WAIT_MS)
  o.until = now + o.wait
}

// Réponse du service, quel que soit son statut : la panne est finie.
export function answered(o: Outage): void {
  Object.assign(o, outage())
}

export const DEGRADED = 'dégradé, service injoignable. Claude Code garde ses outils habituels ; les économies reprennent toutes seules.'

export function degradedNote(o: Outage): string | null {
  return o.since === null ? null : DEGRADED
}

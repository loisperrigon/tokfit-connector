// Bandeau du gain au-dessus de la saisie (composant `AbovePrompt`, terminal et
// Claude Desktop en mode code) : l'argent économisé, sur ce que la période
// aurait coûté sans tokfit, la part gagnée en barre, et le temps d'attente en
// moins, précédés de « ≈ » tant que le service les dit estimés (`saved_kind`). Les chiffres viennent du bilan du service (`GET /v1/bilan`,
// service/bilan.py), relu après un tour au plus une fois toutes les
// BADGE_EVERY_MS. À chaque hausse, le montant monte jusqu'au nouveau chiffre,
// la barre se remplit, l'étincelle scintille et le gain du dernier tour
// s'affiche quelques secondes ; puis le bandeau ne bouge plus (aucun
// rafraîchissement en continu). Service muet, lent, refus ou gain nul : le
// bandeau garde sa dernière valeur ou ne s'affiche pas ; rien d'autre ne change.
import type { EngineInterface } from 'claude-code'
import { bounded } from './bounded'
import { TIMEOUT_MS } from './service'
import type { Link } from './service'

export const BADGE_EVERY_MS = 5 * 60_000
export const FRAME_MS = 60
export const FRAMES = 22
export const DELTA_MS = 5000
const BAR = 10
const SPARKS = ['✦', '✧', '✶', '✷', '✸', '✹', '✺', '✹', '✸', '✷', '✶', '✧']

export type Gain = { saved: number; reference: number | undefined; percent: number | undefined; seconds: number | undefined; estimated: boolean }

export type Badge = {
  at?: number
  busy: boolean
  gain?: Gain
  // Montant affiché pendant la montée ; image en cours (undefined : au repos).
  from: number
  frame?: number
  stop?: () => void
  // Gain apparu au dernier relevé, montré DELTA_MS.
  delta?: number
  deltaUntil?: number
}

export function badge(): Badge {
  return { busy: false, from: 0 }
}

export function money(usd: number): string {
  return usd >= 10 ? `${Math.round(usd)} $` : `${usd.toFixed(2).replace('.', ',')} $`
}

export function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

// Marque d'un chiffre estimé, devant le montant.
export function approx(g: Gain): string {
  return g.estimated ? '≈ ' : ''
}

// Gain tiré de la réponse du bilan ; undefined sans gain positif.
export function gainOf(text: string): Gain | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { saved_usd: saved, reference_cost: reference, seconds_saved: seconds, saved_percent: percent, saved_kind: kind } = parsed as Record<string, unknown>
  if (typeof saved !== 'number' || !(saved >= 0.01)) return undefined
  const ref = typeof reference === 'number' && reference > saved ? reference : undefined
  const pct = typeof percent === 'number' && percent > 0 ? percent : ref !== undefined ? (saved / ref) * 100 : undefined
  return { saved, reference: ref, percent: pct === undefined ? undefined : Math.min(100, pct), seconds: typeof seconds === 'number' && seconds >= 60 ? seconds : undefined, estimated: kind !== 'measured' }
}

// Le bandeau en une ligne de texte, celle que lit un lecteur d'écran.
export function badgeText(g: Gain, shown: number = g.saved): string {
  const amount = `${approx(g)}${money(shown)}`
  const parts = [g.reference !== undefined ? `${amount} économisés sur ${money(g.reference)}` : `${amount} économisés`]
  if (g.percent !== undefined) parts.push(`−${Math.round(g.percent)} %`)
  if (g.seconds !== undefined) parts.push(`${duration(g.seconds)} d'attente en moins`)
  return parts.join(' · ')
}

function ease(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

// Montant et part affichés à l'image en cours.
export function current(b: Badge): { saved: number; percent: number | undefined; spark: string } {
  const g = b.gain
  if (!g) return { saved: 0, percent: undefined, spark: SPARKS[0] ?? '✦' }
  if (b.frame === undefined) return { saved: g.saved, percent: g.percent, spark: SPARKS[0] ?? '✦' }
  const k = ease(Math.min(1, b.frame / FRAMES))
  return {
    saved: b.from + (g.saved - b.from) * k,
    percent: g.percent === undefined ? undefined : g.percent * k,
    spark: SPARKS[b.frame % SPARKS.length] ?? '✦',
  }
}

export function bar(percent: number): [string, string] {
  const full = Math.max(0, Math.min(BAR, Math.round((percent / 100) * BAR)))
  return ['▰'.repeat(full), '▱'.repeat(BAR - full)]
}

// Relit le bilan si le délai est passé : le nouveau gain (undefined : plus de
// gain à montrer), ou null quand rien n'a changé (trop tôt, déjà en cours, échec).
export async function refresh($: EngineInterface, b: Badge, to: Link, now: number): Promise<Gain | undefined | null> {
  if (b.busy || (b.at !== undefined && now - b.at < BADGE_EVERY_MS)) return null
  b.busy = true
  b.at = now
  try {
    const reply = await bounded($, `${to.url}/v1/bilan`, { method: 'GET', headers: { authorization: `Bearer ${to.key}` } }, TIMEOUT_MS)
    if (!reply || reply.status !== 200) return null
    return gainOf(reply.text)
  } finally {
    b.busy = false
  }
}

// Nouveau gain : la montée part du montant affiché ; le bandeau est redessiné à chaque image.
export function animate($: EngineInterface, b: Badge, gain: Gain | undefined, now: number): void {
  const before = b.gain?.saved
  b.stop?.()
  b.stop = undefined
  b.from = b.gain ? current(b).saved : 0
  b.gain = gain
  if (gain && before !== undefined && gain.saved - before >= 0.01) {
    b.delta = gain.saved - before
    b.deltaUntil = now + FRAMES * FRAME_MS + DELTA_MS
  }
  if (!gain) {
    b.frame = undefined
    $.ui.invalidate('ui.render')
    return
  }
  b.frame = 0
  $.ui.invalidate('ui.render')
  let stop: (() => void) | undefined
  const timer = $.clock.every(FRAME_MS, () => {
    const frame = (b.frame ?? FRAMES) + 1
    if (frame >= FRAMES) {
      b.frame = undefined
      timer.cancel()
      if (b.stop === stop) b.stop = undefined
    } else {
      b.frame = frame
    }
    $.ui.invalidate('ui.render')
  })
  stop = () => timer.cancel()
  b.stop = stop
}

// Bandeau du gain au-dessus de la saisie (composant `AbovePrompt`, terminal et
// Claude Desktop en mode code) : l'argent économisé, sur ce que la période
// aurait coûté sans tokfit, la part gagnée en barre, et le temps d'attente en
// moins, précédés de « ≈ » tant que le service les dit estimés (`saved_kind`). Les chiffres viennent du bilan du service (`GET /v1/bilan`,
// service/bilan.py), relu après un tour au plus une fois toutes les
// BADGE_EVERY_MS. Le dernier relevé est rangé dans le magasin du plugin (`STORE_GAIN`, nombres seulement),
// commun aux sessions de la machine : chacune le relit toutes les SYNC_MS (`adopt`, lecture locale, sans
// réseau) et le montre, si bien que le travail d'une conversation fait monter le chiffre de toutes les autres,
// et qu'un relevé récent d'une autre session tient lieu de nouvelle lecture. À chaque hausse, le montant monte jusqu'au nouveau chiffre,
// la barre se remplit, l'étincelle scintille et le gain du dernier tour
// s'affiche quelques secondes ; puis le bandeau ne bouge plus (aucun
// rafraîchissement en continu). Sur les surfaces graphiques sans terminal (Desktop, mobile), le même gain
// passe dans la ligne d'état (`statusText`, register.ts) au lieu du bandeau. Service muet, lent, refus ou gain nul : le
// bandeau garde sa dernière valeur ou ne s'affiche pas ; rien d'autre ne change.
import type { EngineInterface } from 'claude-code'
import { bounded } from './bounded'
import { TIMEOUT_MS } from './service'
import type { Link } from './service'
import { language, t } from './lang'

export const BADGE_EVERY_MS = 5 * 60_000
export const FRAME_MS = 60
export const FRAMES = 22
export const DELTA_MS = 5000
export const SYNC_MS = 15_000
export const STORE_GAIN = 'gain'
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
  // Relecture du magasin commun en cours (arrêtée en fin de session).
  sync?: () => void
}

// Relevé commun aux sessions : heure de la lecture et gain lu (null : aucun gain à montrer).
type Shared = { at: number; gain: Gain | null }

function sharedOf(value: unknown): Shared | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { at, gain } = value as Record<string, unknown>
  if (typeof at !== 'number') return undefined
  if (gain === null) return { at, gain: null }
  if (typeof gain !== 'object') return undefined
  const g = gain as Record<string, unknown>
  const optional = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  if (typeof g.saved !== 'number' || typeof g.estimated !== 'boolean') return undefined
  return { at, gain: { saved: g.saved, reference: optional(g.reference), percent: optional(g.percent), seconds: optional(g.seconds), estimated: g.estimated } }
}

// Relevé d'une autre session plus récent que le dernier vu ici : son gain (undefined : plus de gain), sinon null.
export async function adopt($: EngineInterface, b: Badge): Promise<Gain | undefined | null> {
  const shared = sharedOf(await $.store.get(STORE_GAIN))
  if (!shared || (b.at !== undefined && shared.at <= b.at)) return null
  b.at = shared.at
  return shared.gain ?? undefined
}

export function badge(): Badge {
  return { busy: false, from: 0 }
}

// Montant en dollars : « 12 $ », « 1,50 $ » ; en anglais « $12 », « $1.50 ».
export function money(usd: number): string {
  if (language() === 'en') return usd >= 10 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
  return usd >= 10 ? `${Math.round(usd)} $` : `${usd.toFixed(2).replace('.', ',')} $`
}

export function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  if (language() === 'en') return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

// Part gagnée : « −25 % » ; en anglais « −25% ».
export function share(percent: number): string {
  return t(`−${Math.round(percent)} %`, `−${Math.round(percent)}%`)
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
  const parts = [`${amount}${savedWords(g.reference)}`]
  if (g.percent !== undefined) parts.push(share(g.percent))
  if (g.seconds !== undefined) parts.push(t(`${duration(g.seconds)} d'attente en moins`, `${duration(g.seconds)} less waiting`))
  return parts.join(' · ')
}

// Ce qui suit le montant : « économisés sur 40 $ », ou « économisés » sans référence.
export function savedWords(reference: number | undefined): string {
  return reference !== undefined ? t(` économisés sur ${money(reference)}`, ` saved out of ${money(reference)}`)
    : t(' économisés', ' saved')
}

// Le gain en texte simple pour la ligne d'état : le montant monte avec le bandeau (la part reste fixe), une étincelle tourne
// pendant la montée, puis le gain du dernier relevé reste affiché jusqu'à `deltaUntil`.
export function statusText(b: Badge, now: number): string | undefined {
  const g = b.gain
  if (!g) return undefined
  const shown = current(b)
  const parts = [`${approx(g)}${money(shown.saved)}${savedWords(undefined)}`]
  if (g.percent !== undefined) parts.push(share(g.percent))
  if (b.delta !== undefined && b.deltaUntil !== undefined && now < b.deltaUntil) {
    parts.push(`+${money(b.delta)} ${b.frame !== undefined ? shown.spark : '↑'}`)
  }
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
// Un relevé plus récent d'une autre session (magasin commun) passe avant la lecture et compte dans le délai.
export async function refresh($: EngineInterface, b: Badge, to: Link, now: number): Promise<Gain | undefined | null> {
  if (b.busy) return null
  b.busy = true
  try {
    const other = await adopt($, b).catch(() => {
      // Magasin illisible : seule la lecture du bilan compte.
      return null
    })
    if (b.at !== undefined && now - b.at < BADGE_EVERY_MS) return other
    b.at = now
    const reply = await bounded($, `${to.url}/v1/bilan`, { method: 'GET', headers: { authorization: `Bearer ${to.key}` } }, TIMEOUT_MS)
    if (!reply || reply.status !== 200) return other
    const gain = gainOf(reply.text)
    await $.store.set(STORE_GAIN, { at: now, gain: gain ?? null }).catch(() => {
      // Magasin refusé : les autres sessions liront le bilan elles-mêmes.
    })
    return gain
  } finally {
    b.busy = false
  }
}

// Nouveau gain : la montée part du montant affiché ; le bandeau est redessiné et `paint` appelé à chaque
// image, puis une dernière fois quand le gain du dernier relevé cesse d'être montré.
export function animate($: EngineInterface, b: Badge, gain: Gain | undefined, now: number, paint: () => void = () => {}): void {
  const before = b.gain?.saved
  b.stop?.()
  b.stop = undefined
  b.from = b.gain ? current(b).saved : 0
  b.gain = gain
  const draw = (): void => {
    $.ui.invalidate('ui.render')
    paint()
  }
  if (gain && before !== undefined && gain.saved - before >= 0.01) {
    b.delta = gain.saved - before
    b.deltaUntil = now + FRAMES * FRAME_MS + DELTA_MS
    const fade = $.clock.every(FRAMES * FRAME_MS + DELTA_MS, () => {
      fade.cancel()
      draw()
    })
  }
  if (!gain) {
    b.frame = undefined
    draw()
    return
  }
  b.frame = 0
  draw()
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
    draw()
  })
  stop = () => timer.cancel()
  b.stop = stop
}

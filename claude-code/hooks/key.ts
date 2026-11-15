// Clé anonyme. Sans clé configurée, demande `POST /v1/keys/anonymous` (sans
// corps ni identité) et range `{ url, key }` dans le magasin du plugin
// (`$.store`), sous l'adresse du service qui l'a émise. La clé n'est ni
// affichée, ni journalisée, ni envoyée ailleurs qu'au service. Demande bornée
// par KEY_TIMEOUT_MS ; après un échec, aucune demande avant RETRY_MS. Une clé
// refusée plus tard ne provoque aucune nouvelle demande.
import type { EngineInterface } from 'claude-code'
import { bounded } from './bounded'

// Attente maximale de la clé anonyme (une fois, au premier démarrage).
export const KEY_TIMEOUT_MS = 5000
// Après un échec (service injoignable, limite atteinte), délai avant une nouvelle demande.
export const RETRY_MS = 10 * 60_000
// Entrée du magasin du plugin : `{ url, key }`.
export const STORE_ENTRY = 'anonymous_key'
const KEY = /^ek_[A-Za-z0-9_-]{20,200}$/

type State = { url?: string; key?: string; asking?: Promise<string | null>; failedAt?: number }
// Un état par chargement du connecteur (clé : ses options, propres à chaque chargement).
const states = new WeakMap<object, State>()

// La clé anonyme pour le service `url` : rangée, sinon demandée ; null si elle manque.
export function anonymousKey($: EngineInterface, url: string, owner: object): Promise<string | null> {
  let state = states.get(owner)
  if (!state) states.set(owner, state = {})
  const known = state
  if (known.key && known.url === url) return Promise.resolve(known.key)
  known.asking ??= obtain($, url, known).finally(() => { known.asking = undefined })
  return known.asking
}

async function obtain($: EngineInterface, url: string, state: State): Promise<string | null> {
  const stored = await kept($, url)
  if (stored) return remember(state, url, stored)
  const now = await $.clock.now()
  if (state.failedAt !== undefined && now - state.failedAt < RETRY_MS) return null
  const reply = await bounded($, `${url}/v1/keys/anonymous`, { method: 'POST' }, KEY_TIMEOUT_MS)
  const key = reply?.status === 201 ? keyOf(reply.text) : null
  if (!key) {
    state.failedAt = now
    return null
  }
  try {
    await $.store.set(STORE_ENTRY, { url, key })
  } catch {
    // Magasin plein ou illisible : la clé sert pour cette session, la suivante en redemandera une.
  }
  return remember(state, url, key)
}

function remember(state: State, url: string, key: string): string {
  state.url = url
  state.key = key
  return key
}

async function kept($: EngineInterface, url: string): Promise<string | null> {
  try {
    const entry = await $.store.get(STORE_ENTRY)
    if (typeof entry !== 'object' || entry === null) return null
    const { url: from, key } = entry as { url?: unknown; key?: unknown }
    return from === url && typeof key === 'string' && KEY.test(key) ? key : null
  } catch {
    // Magasin illisible : comme vide, une clé sera demandée.
    return null
  }
}

function keyOf(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text)
    const key = typeof parsed === 'object' && parsed !== null ? (parsed as { key?: unknown }).key : undefined
    return typeof key === 'string' && KEY.test(key) ? key : null
  } catch {
    // Réponse illisible : pas de clé, nouvelle demande après RETRY_MS.
    return null
  }
}

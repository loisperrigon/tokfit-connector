// Leviers coupés pour cette session (service/experiments.py) : le service en
// tire une part au hasard pour mesurer le gain de chacun. Demandé une fois par
// session ; une panne ou une réponse illisible laisse tous les leviers actifs.
// S'y ajoutent ceux qu'une application hôte coupe pour la conversation
// (variable de l'hôte : warm,compaction…, réglages d'Open Codex : host.ts) ou
// que l'utilisateur coupe lui-même ; `routing` y coupe aussi le routage
// (`chosen`), que le service tire lui-même.
// Le choix d'un modèle par l'utilisateur change en cours de conversation : une
// variable d'environnement ne se modifie pas dans un processus lancé, donc
// la variable de fichier de l'hôte désigne un fichier (même liste, séparée par des virgules)
// relu à chaque message ; quand il se lit, il prime sur les variables.
// La même réponse dit aussi ce que le compte du client a coupé lui-même (`disabled` : routage par message
// en bêta), la version minimale du connecteur (`min_version`) et la langue des textes du connecteur
// (`language`, lang.ts) ; la demande joint les versions (versions.ts) et la locale du système.
import type { EngineInterface } from 'claude-code'
import { field, post } from './service'
import type { Link } from './service'
import { reported, updateNotice } from './versions'
import { locale, setLanguage } from './lang'
import type { Versions } from './versions'

// Attente maximale de la liste : elle peut précéder la première requête au modèle.
export const LEVERS_TIMEOUT_MS = 3_000
const NONE: ReadonlySet<string> = new Set()

// Réponse de /v1/levers pour la session : leviers témoins, coupés par le compte, ligne de mise à jour.
export type Answer = { off: ReadonlySet<string>; disabled: ReadonlySet<string>; outdated: string | null }

export type Holdout = {
  session: string | undefined; off: Promise<Answer> | undefined
  // Dernière réponse reçue (lue par le rendu du bandeau sans rien demander).
  answer: Answer | undefined
  // Variables lues une fois ; `file` : dernier relevé du fichier (relu au plus toutes les OFF_FILE_TTL_MS).
  local: Promise<{ env: ReadonlySet<string>; path: string | undefined }> | undefined
  file: { at: number; set: ReadonlySet<string> | null } | undefined
}

export function holdout(): Holdout {
  return { session: undefined, off: undefined, answer: undefined, local: undefined, file: undefined }
}

const LEVER = /^[a-z_]{1,32}$/
// Plusieurs décisions par message lisent la liste : un seul relevé du fichier par instant.
export const OFF_FILE_TTL_MS = 500

function leverList(raw: string | undefined): ReadonlySet<string> {
  return new Set((raw ?? '').split(',').map(word => word.trim()).filter(word => LEVER.test(word)))
}

// Leviers coupés par l'application hôte ou l'utilisateur : le fichier relu à
// chaque message quand l'hôte en donne un, sinon les variables lues une fois.
export async function chosen($: EngineInterface, h: Holdout): Promise<ReadonlySet<string>> {
  h.local ??= (async () => {
    // Variables de l'hôte sous le nom de sa copie embarquée, gardé dans la copie
    // publique (`publish: keep`, connector/publish.py) ; celle de l'utilisateur y
    // prend le nom de production (ici, c'est la même).
    const host = await $.env.get('ECONOMISEUR_OFF') // publish: keep
    const path = await $.env.get('ECONOMISEUR_OFF_FILE') // publish: keep
    const user = await $.env.get('TOKFIT_OFF')
    return { env: new Set([...leverList(host), ...leverList(user)]), path: path ? path : undefined }
  })().catch(() => ({ env: NONE, path: undefined }))
  const { env, path } = await h.local
  if (path === undefined) return env
  try {
    const now = await $.clock.now()
    if (h.file === undefined || now - h.file.at >= OFF_FILE_TTL_MS || now < h.file.at) {
      let set: ReadonlySet<string> | null = null
      try {
        set = leverList(await $.fs.read(path))
      } catch {
        // Fichier absent ou illisible : la variable fait foi.
      }
      h.file = { at: now, set }
    }
    return h.file.set ?? env
  } catch {
    return env
  }
}

// Réponse du service pour la session en cours (une seule demande par session).
export async function answer($: EngineInterface, h: Holdout, to: Link): Promise<Answer> {
  const session = await $.session.id()
  if (h.session !== session || h.off === undefined) {
    h.session = session
    h.off = asked($, h, to, session)
  }
  return h.off
}

// Leviers coupés pour la session en cours : témoins du service, et choix de l'hôte ou de l'utilisateur.
// Ceux que le compte coupe (`disabled`) restent hors de cette liste : le service ne les applique déjà pas.
export async function levers($: EngineInterface, h: Holdout, to: Link): Promise<ReadonlySet<string>> {
  const { off } = await answer($, h, to)
  const local = await chosen($, h)
  return local.size === 0 ? off : new Set([...off, ...local])
}

function names(value: unknown): ReadonlySet<string> {
  return Array.isArray(value) ? new Set(value.filter((lever): lever is string => typeof lever === 'string')) : NONE
}

async function asked($: EngineInterface, h: Holdout, to: Link, session: string): Promise<Answer> {
  let versions: Versions = {}
  try {
    versions = await reported($)
  } catch {
    // Versions illisibles : la demande part sans elles.
  }
  const spoken = locale()
  const reply = await post($, to, '/v1/levers', { session_id: session, versions, ...(spoken ? { locale: spoken } : {}) }, LEVERS_TIMEOUT_MS)
  const text = reply?.status === 200 ? reply.text : ''
  const switched = setLanguage(field(text, 'language'))
  const got: Answer = { off: names(field(text, 'off')), disabled: names(field(text, 'disabled')),
    outdated: updateNotice(versions.plugin, field(text, 'min_version')) }
  h.answer = got
  if (got.outdated !== null || switched) {
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // Rendu indisponible : la ligne paraîtra au prochain dessin.
    }
  }
  return got
}

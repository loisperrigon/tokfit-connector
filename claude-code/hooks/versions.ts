// Versions jointes au service une fois par session (`versions` de POST /v1/levers, service/versions.py) :
// ce connecteur, Python de son outil principal, Claude Code, et l'application hôte qui le lance
// (variable posée sous le nom de sa copie embarquée). Le service en garde la trace pour le diagnostic et
// annonce la version minimale du connecteur (`min_version`) : en dessous, le bandeau dit de relancer
// Claude Code, qui installe tout seul la version publiée (marketplace, mise à jour automatique).
import type { EngineInterface } from 'claude-code'
import { pythonFiles } from './python'

export type Versions = { plugin?: string; python?: string; claude_code?: string; host?: string }

// Texte imprimable court : le service refuse le reste (TEXT de service/versions.py).
const PRINTABLE = /^[\x20-\x7e]{1,80}$/

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return PRINTABLE.test(text) ? text : undefined
}

export async function pluginVersion($: EngineInterface): Promise<string | undefined> {
  try {
    const manifest: unknown = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
    return clean((manifest as { version?: unknown } | null)?.version)
  } catch {
    // Manifeste illisible : version inconnue.
    return undefined
  }
}

async function quietly<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch {
    // Rien de lisible : la version manque, le reste part.
    return undefined
  }
}

// Ce qui est lisible maintenant ; un champ illisible est omis (Python pas encore lancé, par exemple).
export async function reported($: EngineInterface): Promise<Versions> {
  const [plugin, python, claude, host] = await Promise.all([
    pluginVersion($),
    quietly(async () => (await pythonFiles($)).launch?.version),
    quietly(async () => (await $.session.version()).version),
    quietly(() => $.env.get('ECONOMISEUR_HOST_VERSION')), // publish: keep
  ])
  const out: Versions = {}
  const entries: [keyof Versions, unknown][] = [['plugin', plugin], ['python', python], ['claude_code', claude], ['host', host]]
  for (const [name, value] of entries) {
    const text = clean(value)
    if (text !== undefined) out[name] = text
  }
  return out
}

function parts(version: string): number[] | null {
  const found = /^(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?/.exec(version.trim())
  return found ? found.slice(1).map(part => Number(part ?? 0)) : null
}

// Vrai si `version` est lisible et sous `minimum` (comparaison nombre par nombre, comme le service).
export function older(version: string, minimum: string): boolean {
  const mine = parts(version)
  const wanted = parts(minimum)
  if (!mine || !wanted) return false
  for (let i = 0; i < 4; i++) {
    const a = mine[i] ?? 0
    const b = wanted[i] ?? 0
    if (a !== b) return a < b
  }
  return false
}

// Ligne du bandeau quand ce connecteur est sous la version minimale du service ; null sinon.
export function updateNotice(version: string | undefined, minimum: unknown): string | null {
  if (version === undefined || typeof minimum !== 'string' || !older(version, minimum)) return null
  return `connecteur ${version} trop ancien (${minimum} au moins) : relance Claude Code pour charger la mise à jour automatique.`
}

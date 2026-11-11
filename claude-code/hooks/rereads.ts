// Qualité d'une compaction : fichiers relus après elle. Un fichier déjà lu par
// le fil principal avant une compaction du connecteur, inchangé depuis, et relu
// dans les REREAD_WINDOW étapes qui suivent, est ce que le résumé a perdu ; ses
// caractères partent sur l'étape suivante (`reread_chars`) et le service les
// retire du gain de la compaction. Les chemins restent en mémoire : seuls des
// nombres partent.

// Étapes du fil principal suivies après une compaction.
export const REREAD_WINDOW = 20
const READ_TOOLS = new Set(['Read'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export type Rereads = {
  // Fichiers lus par le fil principal depuis le début de la session.
  read: Set<string>
  // Lus avant la dernière compaction du connecteur, pas encore relus ni modifiés.
  before: Set<string> | undefined
  // Étapes du fil principal encore suivies, et caractères relus en attente d'une étape.
  window: number
  chars: number
}

export function rereads(): Rereads {
  return { read: new Set(), before: undefined, window: 0, chars: 0 }
}

// Appel d'outil du fil principal : lecture (relue ou non) ou modification d'un fichier.
export function observed(r: Rereads, tool: string, path: string, chars: number): void {
  if (WRITE_TOOLS.has(tool)) {
    r.before?.delete(path)
    return
  }
  if (!READ_TOOLS.has(tool)) return
  if (r.window > 0 && r.before?.delete(path)) r.chars += chars
  r.read.add(path)
}

// Compaction du connecteur faite : ce qui a été lu jusqu'ici est suivi.
export function compacted(r: Rereads): void {
  r.before = new Set(r.read)
  r.window = REREAD_WINDOW
  r.chars = 0
}

// Étape du fil principal comptée : caractères relus à lui joindre, s'il y en a.
export function stepped(r: Rereads): number | undefined {
  const chars = r.chars
  r.chars = 0
  if (r.window > 0 && --r.window === 0) r.before = undefined
  return chars > 0 ? chars : undefined
}

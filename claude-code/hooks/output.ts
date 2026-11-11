// Sorties de commandes raccourcies avant que le modèle ne les lise.
//
// Seules les commandes bruyantes connues (tests, compilations, installations)
// sont touchées, et jamais une commande dont la sortie passe déjà par un filtre
// (`| tail`, `| grep`…) : le modèle a alors choisi ce qu'il lit. Nettoyage sans
// perte de sens (couleurs, barres de progression réécrites par retour chariot,
// lignes identiques répétées), puis, sur une longue sortie, le début, la fin
// et les lignes d'erreur du milieu. Rien n'est écrit sur la machine : la
// commande relancée avec `TOKFIT_RAW=1` devant rend la sortie entière, et
// le modèle en est prévenu par une note qu'il est seul à lire.
//
// Algorithmes inspirés des compresseurs de caveman (Apache-2.0), réécrits ici.

import { POLICY } from './policy'
export const RAW = 'TOKFIT_RAW=1'

// Au-delà de LONG lignes après nettoyage : HEAD premières, TAIL dernières et au
// plus KEPT lignes d'erreur du milieu.
export const LONG = POLICY.output.long
const HEAD = POLICY.output.head
const TAIL = POLICY.output.tail
const KEPT = POLICY.output.kept
// Une ligne répétée au moins REPEAT fois de suite n'est gardée qu'une fois.
const REPEAT = POLICY.output.repeat

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const important = (line: string): boolean => POLICY.output.important.some(word => line.toLowerCase().includes(word))

// Premier mot (nom de base) des commandes bruyantes ; `python -m <module>` à part.
const NOISY: ReadonlySet<string> = new Set(POLICY.output.noisy)
const NOISY_MODULES: ReadonlySet<string> = new Set(POLICY.output.modules)
const PYTHON = /^python(3(\.\d+)?)?$/
// Filtres déjà posés par le modèle en bout de chaîne.
const READERS: ReadonlySet<string> = new Set(POLICY.output.readers)
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function words(segment: string): string[] {
  const all = segment.trim().split(/\s+/).filter(word => word !== '')
  let start = 0
  while (start < all.length && (ASSIGNMENT.test(all[start] ?? '') || all[start] === 'time' || all[start] === 'env')) start++
  return all.slice(start)
}

function base(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

function noisySegment(segment: string): boolean {
  const [first = '', second = '', third = ''] = words(segment)
  const name = base(first)
  if (PYTHON.test(name)) return second === '-m' && NOISY_MODULES.has(third)
  return NOISY.has(name)
}

// Vrai pour une commande à raccourcir.
export function noisy(command: string): boolean {
  if (command.includes(RAW) || /<<|\$\(|`/.test(command)) return false
  const pipeline = command.split(/(?<!\|)\|(?!\|)/)
  if (pipeline.length > 1 && READERS.has(base(words(pipeline.at(-1) ?? '')[0] ?? ''))) return false
  return command.split(/&&|\|\|?|;/).some(noisySegment)
}

// Couleurs retirées, ligne réécrite par retour chariot réduite à son dernier état.
function cleanLine(line: string): string {
  const plain = line.replace(ANSI, '').replace(/\r+$/, '')
  return plain.slice(plain.lastIndexOf('\r') + 1)
}

function collapse(lines: string[]): string[] {
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    let end = index + 1
    while (end < lines.length && lines[end] === line) end++
    const count = end - index
    if (count >= REPEAT) out.push(line, `[… ligne répétée ${count - 1} fois de plus]`)
    else out.push(...lines.slice(index, end))
    index = end
  }
  return out
}

export type Trimmed = { text: string; hidden: number }

// Résultat de l'outil Bash tel que le connecteur le réécrit.
export type BashRecord = { stdout: string; stderr: string; isImage?: boolean; backgroundTaskId?: string;
  persistedOutputPath?: string; stdoutHoldsOutputEnd?: boolean; structuredContent?: unknown[] }

// Sortie réécrite et note pour le modèle, ou null s'il n'y a rien à changer.
export function shorten<R extends BashRecord>(command: string, record: R): { record: R; note?: string } | null {
  if (!noisy(command) || record.isImage || record.backgroundTaskId !== undefined || record.persistedOutputPath !== undefined
      || record.stdoutHoldsOutputEnd || record.structuredContent !== undefined) return null
  const out = trim(record.stdout)
  const err = trim(record.stderr)
  if (out.text === record.stdout && err.text === record.stderr) return null
  const hidden = out.hidden + err.hidden
  return { record: { ...record, stdout: out.text, stderr: err.text }, ...(hidden > 0 ? { note: note(hidden) } : {}) }
}

export function trim(text: string): Trimmed {
  if (text === '') return { text, hidden: 0 }
  const lines = collapse(text.split('\n').map(cleanLine))
  if (lines.length <= LONG) return { text: lines.join('\n'), hidden: 0 }
  const middle = lines.slice(HEAD, lines.length - TAIL)
  const kept = middle.map((line, at) => ({ line, at: at + HEAD })).filter(({ line }) => important(line)).slice(0, KEPT)
  const hidden = middle.length - kept.length
  const shown = [
    ...lines.slice(0, HEAD),
    `[… ${hidden} lignes masquées${kept.length ? ` ; lignes d'erreur gardées :` : ''}]`,
    ...kept.map(({ line, at }) => `${at + 1}: ${line}`),
    ...(kept.length ? ['[… fin des lignes gardées]'] : []),
    ...lines.slice(lines.length - TAIL),
  ]
  return { text: shown.join('\n'), hidden }
}

export function note(hidden: number): string {
  return `tokfit : ${hidden} lignes de cette sortie ont été masquées (début, fin et lignes d'erreur gardés). ` +
    `Pour la sortie entière, relance la commande précédée de ${RAW}.`
}

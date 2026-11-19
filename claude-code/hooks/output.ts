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

import type { OutputPlan } from './plan'
import { t } from './lang'
export const RAW = 'TOKFIT_RAW=1'

// Paramètres (seuils, listes) : ceux du plan de session (plan.ts). Au-delà de `long` lignes
// après nettoyage : `head` premières, `tail` dernières et au plus `kept` lignes importantes
// du milieu ; une ligne répétée au moins `repeat` fois de suite n'est gardée qu'une fois.

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const PYTHON = /^python(3(\.\d+)?)?$/
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

function noisySegment(segment: string, rules: OutputPlan): boolean {
  const [first = '', second = '', third = ''] = words(segment)
  const name = base(first)
  if (PYTHON.test(name)) return second === '-m' && rules.modules.includes(third)
  return rules.noisy.includes(name)
}

// Vrai pour une commande à raccourcir.
export function noisy(command: string, rules: OutputPlan): boolean {
  if (command.includes(RAW) || /<<|\$\(|`/.test(command)) return false
  const pipeline = command.split(/(?<!\|)\|(?!\|)/)
  if (pipeline.length > 1 && rules.readers.includes(base(words(pipeline.at(-1) ?? '')[0] ?? ''))) return false
  return command.split(/&&|\|\|?|;/).some(segment => noisySegment(segment, rules))
}

// Couleurs retirées, ligne réécrite par retour chariot réduite à son dernier état.
function cleanLine(line: string): string {
  const plain = line.replace(ANSI, '').replace(/\r+$/, '')
  return plain.slice(plain.lastIndexOf('\r') + 1)
}

function collapse(lines: string[], repeat: number): string[] {
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    let end = index + 1
    while (end < lines.length && lines[end] === line) end++
    const count = end - index
    if (count >= repeat) out.push(line, t(`[… ligne répétée ${count - 1} fois de plus]`, `[… line repeated ${count - 1} more times]`))
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
export function shorten<R extends BashRecord>(command: string, record: R, rules: OutputPlan): { record: R; note?: string } | null {
  if (!noisy(command, rules) || record.isImage || record.backgroundTaskId !== undefined || record.persistedOutputPath !== undefined
      || record.stdoutHoldsOutputEnd || record.structuredContent !== undefined) return null
  const out = trim(record.stdout, rules)
  const err = trim(record.stderr, rules)
  if (out.text === record.stdout && err.text === record.stderr) return null
  const hidden = out.hidden + err.hidden
  return { record: { ...record, stdout: out.text, stderr: err.text }, ...(hidden > 0 ? { note: note(hidden) } : {}) }
}

export function trim(text: string, rules: OutputPlan): Trimmed {
  if (text === '') return { text, hidden: 0 }
  const { long, head, tail, kept: most } = rules
  const lines = collapse(text.split('\n').map(cleanLine), rules.repeat)
  if (lines.length <= long) return { text: lines.join('\n'), hidden: 0 }
  const middle = lines.slice(head, lines.length - tail)
  const important = (line: string): boolean => rules.important.some(word => line.toLowerCase().includes(word))
  const kept = middle.map((line, at) => ({ line, at: at + head })).filter(({ line }) => important(line)).slice(0, most)
  const hidden = middle.length - kept.length
  const shown = [
    ...lines.slice(0, head),
    t(`[… ${hidden} lignes masquées${kept.length ? ` ; lignes d'erreur gardées :` : ''}]`,
      `[… ${hidden} lines hidden${kept.length ? '; error lines kept:' : ''}]`),
    ...kept.map(({ line, at }) => `${at + 1}: ${line}`),
    ...(kept.length ? [t('[… fin des lignes gardées]', '[… end of kept lines]')] : []),
    ...lines.slice(lines.length - tail),
  ]
  return { text: shown.join('\n'), hidden }
}

export function note(hidden: number): string {
  return t(`tokfit : ${hidden} lignes de cette sortie ont été masquées (début, fin et lignes d'erreur gardés). ` +
    `Pour la sortie entière, relance la commande précédée de ${RAW}.`,
  `tokfit: ${hidden} lines of this output were hidden (start, end and error lines kept). ` +
    `For the whole output, run the command again prefixed with ${RAW}.`)
}

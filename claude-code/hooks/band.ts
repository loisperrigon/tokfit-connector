// Dessin du bandeau du gain (badge.ts) dans le composant `AbovePrompt`, et sous lui la ligne de santé de
// l'outil principal quand il manque (python.ts : installation de Python en cours, impossible…).
// Rien à montrer, ou une enquête du moteur dans la bande : la main passe.
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import { approx, badgeText, bar, current, money, savedWords, share } from './badge'
import type { Badge } from './badge'
import { t } from './lang'

const GOLD = '#f5b301'

export function band($: EngineInterface, e: RenderInput<'AbovePrompt'>, b: Badge, now: number, note: string | null = null): RenderElement | null {
  if (e.props.hasSurvey || (!b.gain && !note)) return null
  const { Box, Text } = $.ui.resolve(e)
  const line = note
    ? h(Box, { key: 'tokfit-health', flexDirection: 'row', paddingX: 1 },
      h(Text, { color: 'warning' }, h(Text, { color: 'claude', weight: 'bold' }, 'tokfit'), t(` : ${note}`, `: ${note}`))) as RenderElement
    : null
  const gain = gainRow($, e, b, now)
  if (!line || !gain) return line ?? gain
  return h(Box, { key: 'tokfit-bands', flexDirection: 'column' }, gain, line) as RenderElement
}

function gainRow($: EngineInterface, e: RenderInput<'AbovePrompt'>, b: Badge, now: number): RenderElement | null {
  const g = b.gain
  if (!g) return null
  // Surfaces graphiques : le gain est dans la ligne d'état (register.ts), le bandeau ne garde que la santé.
  if (e.surface !== 'terminal') return null
  const { Box, Text } = $.ui.resolve(e)
  const shown = current(b)
  const moving = b.frame !== undefined
  const pieces: unknown[] = [
    h(Text, { key: 'tokfit-spark', color: GOLD, weight: 'bold' }, `${shown.spark} `),
    h(Text, { key: 'tokfit-name', color: 'claude', weight: 'bold' }, 'tokfit  '),
    ...(g.estimated ? [h(Text, { key: 'tokfit-approx', color: 'success' }, approx(g))] : []),
    h(Text, { key: 'tokfit-saved', color: 'success', weight: 'bold', tabular: true, size: 'heading' }, money(shown.saved)),
    h(Text, { key: 'tokfit-of', color: 'subtle' }, savedWords(g.reference)),
  ]
  if (shown.percent !== undefined) {
    const [full, empty] = bar(shown.percent)
    pieces.push(
      h(Text, { key: 'tokfit-bar' }, '  ', h(Text, { color: 'success' }, full), h(Text, { color: 'subtle' }, empty)),
      h(Text, { key: 'tokfit-percent', color: 'success', weight: 'bold', tabular: true }, ` ${share(shown.percent)}`),
    )
  }
  if (g.seconds !== undefined) {
    pieces.push(h(Text, { key: 'tokfit-time', color: 'subtle' }, `  ·  ⏱ ${badgeText({ ...g, reference: undefined, percent: undefined }).split(' · ')[1] ?? ''}`))
  }
  if (b.delta !== undefined && b.deltaUntil !== undefined && now < b.deltaUntil) {
    pieces.push(h(Text, { key: 'tokfit-delta', color: GOLD, weight: 'bold', dimColor: !moving && now > b.deltaUntil - 1500 }, `  +${money(b.delta)} ↑`))
  }
  // `h` rend un nœud quelconque ; une Box en est toujours un élément.
  return h(Box, { key: 'tokfit-band', flexDirection: 'row', paddingX: 1 }, ...pieces) as RenderElement
}

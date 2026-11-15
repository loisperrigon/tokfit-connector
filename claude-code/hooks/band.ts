// Dessin du bandeau du gain (badge.ts) dans le composant `AbovePrompt`.
// Rien à montrer, ou une enquête du moteur dans la bande : la main passe.
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import { badgeText, bar, current, money } from './badge'
import type { Badge } from './badge'

const GOLD = '#f5b301'

export function band($: EngineInterface, e: RenderInput<'AbovePrompt'>, b: Badge, now: number): RenderElement | null {
  const g = b.gain
  if (!g || e.props.hasSurvey) return null
  const { Box, Text } = $.ui.resolve(e)
  const shown = current(b)
  const moving = b.frame !== undefined
  const pieces: unknown[] = [
    h(Text, { key: 'tokfit-spark', color: GOLD, weight: 'bold' }, `${shown.spark} `),
    h(Text, { key: 'tokfit-name', color: 'claude', weight: 'bold' }, 'tokfit  '),
    h(Text, { key: 'tokfit-saved', color: 'success', weight: 'bold', tabular: true, size: 'heading' }, money(shown.saved)),
    h(Text, { key: 'tokfit-of', color: 'subtle' }, g.reference !== undefined ? ` économisés sur ${money(g.reference)}` : ' économisés'),
  ]
  if (shown.percent !== undefined) {
    const [full, empty] = bar(shown.percent)
    pieces.push(
      h(Text, { key: 'tokfit-bar' }, '  ', h(Text, { color: 'success' }, full), h(Text, { color: 'subtle' }, empty)),
      h(Text, { key: 'tokfit-percent', color: 'success', weight: 'bold', tabular: true }, ` −${Math.round(shown.percent)} %`),
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

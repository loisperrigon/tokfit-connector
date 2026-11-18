// Dessin du bandeau du gain (badge.ts) dans le composant `AbovePrompt`, et sous lui la ligne de santé de
// l'outil principal quand il manque (python.ts : installation de Python en cours, impossible…).
// Rien à montrer, ou une enquête du moteur dans la bande : la main passe.
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import { approx, badgeText, bar, current, duration, money } from './badge'
import type { Badge } from './badge'
import { MASCOT_HEIGHT, MASCOT_WIDTH, mascotSvg } from './mascot'

const GOLD = '#f5b301'

export function band($: EngineInterface, e: RenderInput<'AbovePrompt'>, b: Badge, now: number, note: string | null = null): RenderElement | null {
  if (e.props.hasSurvey || (!b.gain && !note)) return null
  const { Box, Text } = $.ui.resolve(e)
  const line = note
    ? h(Box, { key: 'tokfit-health', flexDirection: 'row', paddingX: 1 },
      h(Text, { color: 'warning' }, h(Text, { color: 'claude', weight: 'bold' }, 'tokfit'), ` : ${note}`)) as RenderElement
    : null
  const gain = gainRow($, e, b, now)
  if (!line || !gain) return line ?? gain
  return h(Box, { key: 'tokfit-bands', flexDirection: 'column' }, gain, line) as RenderElement
}

// Surfaces graphiques (Desktop, VS Code, mobile) : une ligne discrète à droite, sans fond, la mascotte devant ;
// le terminal garde sa ligne en caractères (barre ▰▱).
function pictureRow($: EngineInterface, e: RenderInput<'AbovePrompt'>, b: Badge, now: number): RenderElement | null {
  const g = b.gain
  if (!g || e.surface === 'terminal') return null
  const { Box, Text, Svg } = $.ui.resolve(e)
  const shown = current(b)
  const details = [
    ...(shown.percent !== undefined ? [`−${Math.round(shown.percent)} %`] : []),
    ...(g.seconds !== undefined ? [duration(g.seconds)] : []),
  ]
  const pieces: unknown[] = [
    h(Svg, { key: 'tokfit-mascot', source: mascotSvg(), alt: 'tokfit', width: MASCOT_WIDTH, height: MASCOT_HEIGHT }),
    h(Text, { key: 'tokfit-name', color: 'subtle', size: 'footnote' }, 'tokfit'),
    h(Text, { key: 'tokfit-saved', color: 'success', weight: 'semibold', tabular: true, size: 'footnote' }, `${approx(g)}${money(shown.saved)} économisés`),
  ]
  if (details.length > 0) pieces.push(h(Text, { key: 'tokfit-details', color: 'subtle', tabular: true, size: 'footnote' }, `· ${details.join(' · ')}`))
  if (b.delta !== undefined && b.deltaUntil !== undefined && now < b.deltaUntil) {
    pieces.push(h(Text, { key: 'tokfit-delta', color: 'success', size: 'footnote', dimColor: now > b.deltaUntil - 1500 }, `+${money(b.delta)} ↑`))
  }
  return h(Box, { key: 'tokfit-band', flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 1, paddingX: 1, backgroundColor: 'transparent' }, ...pieces) as RenderElement
}

function gainRow($: EngineInterface, e: RenderInput<'AbovePrompt'>, b: Badge, now: number): RenderElement | null {
  const g = b.gain
  if (!g) return null
  if (e.surface !== 'terminal') return pictureRow($, e, b, now)
  const { Box, Text } = $.ui.resolve(e)
  const shown = current(b)
  const moving = b.frame !== undefined
  const pieces: unknown[] = [
    h(Text, { key: 'tokfit-spark', color: GOLD, weight: 'bold' }, `${shown.spark} `),
    h(Text, { key: 'tokfit-name', color: 'claude', weight: 'bold' }, 'tokfit  '),
    ...(g.estimated ? [h(Text, { key: 'tokfit-approx', color: 'success' }, approx(g))] : []),
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

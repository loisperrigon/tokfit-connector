// Mascotte tokfit en pixels (un token à pattes), dessinée en SVG dans le bandeau des surfaces qui ont
// l'élément `Svg` (Desktop, VS Code, mobile). Chaque calque est une grille : une lettre est une couleur,
// « . » est vide ; une suite de pixels de même couleur sur une ligne fait un seul rectangle.
const COLORS: Record<string, string> = { k: '#000', p: '#FFD2E1', b: '#C9E4FF', w: '#fff', r: '#FF9DBB' }
const LEFT = 3
const VIEWBOX = '3 5 18 16'
const LAYERS: { top: number; rows: string[] }[] = [
  { top: 6, rows: [
    '..kkkkkkkkkkkkkk..',
    '.kkppppppbbbbbbkk.',
    '.kpppppppbbbbbbbk.',
    '.kpppppppbbbbbbbk.',
    '.kpppppppbbbbbbbk.',
    '.kpppppppbbbbbbbk.',
    '.kpppppppbbbbbbbk.',
    '.kpppppppbbbbbbbk.',
    '.kpppppppbbbbbbbk.',
    '.kpppppppbbbbbbbk.',
    '.kkppppppbbbbbbkk.',
    '..kkkkkkkkkkkkkk..',
  ] },
  { top: 10, rows: ['.....wk....wk.....', '.....kk....kk.....', '.....kk....kk.....'] },
  { top: 13, rows: ['...rr........rr...', '.......k..k.......', '........kk........'] },
  { top: 18, rows: ['....kk......kk....', '....kkk.....kkk...'] },
]

// Taille de dessin en pixels CSS : la grille fait 18 colonnes sur 16 lignes.
export const MASCOT_HEIGHT = 22
export const MASCOT_WIDTH = Math.round((MASCOT_HEIGHT * 18) / 16)

export function mascotSvg(): string {
  const rects: string[] = []
  for (const { top, rows } of LAYERS) {
    rows.forEach((row, dy) => {
      for (let x = 0; x < row.length;) {
        let end = x
        while (end < row.length && row[end] === row[x]) end++
        const color = COLORS[row[x] ?? '']
        if (color !== undefined) rects.push(`<rect x="${LEFT + x}" y="${top + dy}" width="${end - x}" height="1" fill="${color}"/>`)
        x = end
      }
    })
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" shape-rendering="crispEdges">${rects.join('')}</svg>`
}

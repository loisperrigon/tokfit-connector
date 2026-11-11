// Une seule copie du connecteur par session (hooks/single.ts) : quelle copie en est une autre.
// Le refus lui-même se joue au chargement, dans le vrai moteur : essai `connector/e2e/run.sh double`.
import { describe, expect, test } from 'claude-code/testing'
import { COPIES, twin } from '../hooks/single'

const OWN = { name: 'tokfit', root: '/support/mods/tokfit' }

describe('autre copie du connecteur', () => {
  test('même connecteur dans un autre dossier, sous son nom de dépôt ou son nom publié : une autre copie', () => {
    expect(twin(OWN, { name: 'tokfit', root: '/Users/ana/.claude/plugins/cache/tokfit/tokfit/0.4.0' })).toBe(true)
    expect(twin(OWN, { name: 'tokfit', root: '/Users/ana/.claude/plugins/cache/tokfit' })).toBe(true)
    expect(COPIES).toEqual(['tokfit', 'tokfit'])
  })

  test('la copie elle-même, ou un autre plugin : rien à refuser', () => {
    expect(twin(OWN, OWN)).toBe(false)
    expect(twin(OWN, { name: 'code-review', root: '/Users/ana/.claude/plugins/cache/code-review' })).toBe(false)
  })
})

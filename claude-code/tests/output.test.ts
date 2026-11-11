// Sorties de commandes bruyantes raccourcies avant que le modèle ne les lise :
// nettoyage sans perte, puis début, fin et erreurs d'une longue sortie.
import { describe, expect, test } from 'claude-code/testing'
import { LONG, RAW, noisy, trim } from '../hooks/output'
import { URL, config, world } from './support'

const lines = (count: number, at: (n: number) => string): string => Array.from({ length: count }, (_, n) => at(n)).join('\n')

describe('commandes visées', () => {
  test('tests, compilations et installations, même après cd ou des variables', async () => {
    for (const command of ['npm test', 'cd web && pnpm build', 'CI=1 cargo test', 'python3 -m pytest -q', '.venv/bin/python -m unittest discover -s tests',
      'make all; echo fini', 'npm test || echo raté', 'node_modules/.bin/jest']) {
      expect([command, noisy(command)]).toEqual([command, true])
    }
  })

  test('lecture, sortie déjà filtrée, sortie brute demandée ou commande composée : jamais', async () => {
    for (const command of ['cat build.log', 'git diff', 'ls -la', 'npm test 2>&1 | tail -40', 'pytest | grep FAIL', `${RAW} npm test`,
      'python3 script.py', 'npm test $(echo x)', 'cat <<EOF\nnpm test\nEOF']) {
      expect([command, noisy(command)]).toEqual([command, false])
    }
  })
})

describe('raccourci', () => {
  test('couleurs et barres de progression retirées, fins de ligne Windows gardées', async () => {
    expect(trim('\x1b[32mok\x1b[0m\n\x1b[1m\x1b[31mFAIL\x1b[0m x').text).toBe('ok\nFAIL x')
    expect(trim('télé 10%\rtélé 50%\rtélé 100%\nfini').text).toBe('télé 100%\nfini')
    expect(trim('a\r\nb\r\n').text).toBe('a\nb\n')
  })

  test('une ligne répétée n’est gardée qu’une fois, avec le compte', async () => {
    expect(trim(['x', 'x', 'x', 'x', 'x', 'y'].join('\n')).text).toBe('x\n[… ligne répétée 4 fois de plus]\ny')
    expect(trim('x\nx\nx\ny').text).toBe('x\nx\nx\ny')
  })

  test('longue sortie : début, fin et lignes d’erreur du milieu, numérotées', async () => {
    const text = lines(1000, n => n === 500 ? 'Error: attendu 2, reçu 3' : `ok ${n}`)
    const out = trim(text)
    const kept = out.text.split('\n')
    expect(kept[0]).toBe('ok 0')
    expect(kept.at(-1)).toBe('ok 999')
    expect(kept).toContain('501: Error: attendu 2, reçu 3')
    expect(out.hidden).toBe(1000 - 60 - 100 - 1)
    expect(kept.length).toBeLessThan(200)
    expect(trim(lines(LONG, n => `ok ${n}`)).hidden).toBe(0)
  })
})

describe('dans Claude Code', () => {
  const long = lines(1000, n => `PASS test ${n}`)

  test('commande bruyante : le modèle lit la sortie raccourcie et une note pour la sortie entière', async ($, on) => {
    world(on, { bash: () => ({ stdout: long }) })
    const got = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(got.deny).toBeUndefined()
    const stdout = (got.result as { stdout: string }).stdout
    expect(stdout.split('\n').length).toBeLessThan(200)
    expect(got.context?.at(-1)).toContain(RAW)
  })

  test('lecture d’un fichier : sortie intacte', async ($, on) => {
    world(on, { bash: () => ({ stdout: long }) })
    const got = await $.tool.call({ tool: 'Bash', command: 'cat test.log' })
    expect((got.result as { stdout: string }).stdout).toBe(long)
    expect(got.context).toBeUndefined()
  })

  test('sans clé : rien ne change', async ($, on) => {
    world(on, { bash: () => ({ stdout: long }), config: config(URL, 'mauvaise') })
    const plain = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect((plain.result as { stdout: string }).stdout).toBe(long)
    expect(plain.context).toBeUndefined()
  })

  test('l’outil échoue : l’erreur passe telle quelle', async ($, on) => {
    world(on, { bash: () => 'error' })
    const failed = await $.tool.call({ tool: 'Bash', command: 'npm run build' })
    expect(failed).toMatchObject({ isError: true, text: 'exit 1' })
  })
})

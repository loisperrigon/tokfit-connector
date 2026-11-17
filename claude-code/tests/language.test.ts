// Langue d'un texte et refus de langue d'une réponse de `finish` (hooks/language.ts) : dite seulement d'un
// texte clairement d'une seule langue, refus seulement quand la langue de la réponse est absente de la demande.
import { describe, expect, test } from 'claude-code/testing'
import { languageOf, languageRefusal } from '../hooks/language'

describe('langue d’un texte', () => {
  test('langues latines suivies, écritures non latines', () => {
    expect(languageOf('Fix the failing test in parser.py so that the build passes again.')).toBe('en')
    expect(languageOf('Why does the build fail on CI?')).toBe('en')
    expect(languageOf('Le build échouait parce que la variable CI n’était pas définie ; c’est corrigé et les tests passent.')).toBe('fr')
    expect(languageOf('El archivo está listo y los tests pasan sin errores.')).toBe('es')
    expect(languageOf('Die Datei ist fertig und die Tests sind grün, aber das Logging fehlt noch.')).toBe('de')
    expect(languageOf('Il file è pronto e tutti i test sono verdi, ma manca ancora il logging.')).toBe('it')
    expect(languageOf('O arquivo já está pronto e os testes passam, mas ainda não há logs para isso.')).toBe('pt')
    expect(languageOf('Исправь тест, который падает в модуле парсера.')).toBe('cyrillic')
    expect(languageOf('テストを修正しました。parser の bug を直しました。')).toBe('cjk')
  })

  test('rien dans le doute : trop court, code, mêlé, chemins et noms techniques', () => {
    for (const text of ['fix it', 'Fait.', 'Done: 3 files fixed.', '```python\nprint("the rest of it and all")\n```',
      'J’ai corrigé `parse_args` : the `--verbose` flag now works, c’est bon.',
      'Voici le README, traduis-le :\nThis project is a tool that helps you do things with the files and it is fast.',
      '/usr/lib/python3/os/es/del/ce.py https://example.com/the/and/is']) {
      expect(languageOf(text)).toBe(undefined)
    }
  })

  test('balises du moteur ôtées : seul le texte de la personne compte', () => {
    expect(languageOf('<system-reminder>Le contexte est en français et il est long et très détaillé</system-reminder>' +
      'Please fix the bug in the parser and make sure that the tests pass.')).toBe('en')
  })

  test('un emprunt ou un nom d’une autre langue dans un long texte ne le rend pas mêlé', () => {
    const long = 'The parser is fixed and the tests pass now. It was failing because the line ending was not handled, ' +
      'and the build script did not report it. We have added a test for it, and the old one is kept. ' +
      'The fix is small: the reader strips the ending before it splits the fields, so that each value is clean. ' +
      'The name of the module is « mise en page ».'
    expect(languageOf(long)).toBe('en')
  })
})

describe('refus de langue', () => {
  const ENGLISH = 'Fix the failing parser test so that the build passes again, and tell me what was wrong with it.'
  const FRENCH = 'Le test du parseur échouait parce que la fin de ligne n’était pas gérée ; c’est corrigé et les tests passent.'

  test('demande en anglais, réponse en français : refusée, avec les deux langues nommées', () => {
    expect(languageRefusal(ENGLISH, FRENCH)).toBe('[finish refused once: the reply looks written in French but the request ' +
      'is in English. If the person writes in French or asked for it, call finish again unchanged; otherwise call ' +
      'finish again with the reply in English.]')
    expect(languageRefusal('Исправь тест, который падает в модуле парсера.', 'The parser test is fixed and all the tests pass now.'))
      .toContain('in English but the request is in a Cyrillic-script language')
  })

  test('même langue, langue de la demande ou de la réponse indécise : rien', () => {
    expect(languageRefusal(ENGLISH, 'The parser test failed because the line ending was not handled; it is fixed now.')).toBe(undefined)
    expect(languageRefusal('fix it', FRENCH)).toBe(undefined)
    expect(languageRefusal(ENGLISH, 'Corrigé.')).toBe(undefined)
  })

  test('lignes collées ôtées, un mot de la langue dans la demande ou un message précédent : rien', () => {
    const ticket = 'The parser crashes when the input file ends without a newline. To reproduce it, create a file ' +
      'with two lines and no final newline, then run the parser on it. The last line is dropped and the exit code is 1.'
    expect(languageRefusal(`Peux-tu regarder ?\n\n${ticket}`, FRENCH)).toBe(undefined)
    expect(languageRefusal('corrige ça\nTraceback (most recent call last):\n  File "a.py", line 3, in <module>\n' +
      'ValueError: the value is not a number and it was not checked by the parser at all', FRENCH)).toBe(undefined)
    expect(languageRefusal(`> ${ticket}`, FRENCH)).toBe(undefined)
    expect(languageRefusal(ticket, FRENCH, ['Salut, on reprend le parseur.'])).toBe(undefined)
    // Rien de français nulle part : refusée.
    expect(languageRefusal(ticket, FRENCH, ['Please look at the parser again.'])).toContain('[finish refused once')
    expect(languageRefusal(`[INFO] the parser has started\n${ENGLISH}`, FRENCH)).toContain('[finish refused once')
  })

  test('langue de la réponse présente dans la demande : rien', () => {
    const asked = 'Please translate this README for the site, pour les visiteurs. It is a tool that helps you do things with the ' +
      'files: it is fast, and the code is small. It was written by the team that also wrote the parser, and it has ' +
      'been used for years by those who need it. Keep the tone of the original and do not add anything to it.'
    expect(languageOf(asked)).toBe('en')
    expect(languageRefusal(asked, FRENCH)).toBe(undefined)
  })
})

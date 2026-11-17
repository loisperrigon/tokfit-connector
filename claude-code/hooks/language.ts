// Langue de la réponse de `finish` comparée à celle de la demande (17/11/2026, banc Terminal-Bench : des
// réponses en français à des demandes en anglais). Heuristique prudente, sans dépendance : une langue n'est
// dite que d'un texte clairement d'une seule langue (une écriture non latine dominante, ou les mots-outils
// d'une des langues latines suivies), code, liens, chemins et balises ôtés ; et une réponse n'est refusée que si
// sa langue est absente de la demande (une consigne en français suivie d'un texte anglais n'est pas « en
// anglais »). Dans le doute, rien : un faux refus coûte un appel au modèle, une réponse dans la mauvaise langue
// reste lisible.

// Mots-outils fréquents de chaque langue ; un mot présent dans deux listes, ou dans IGNORED, ne compte pour aucune.
const WORDS: Readonly<Record<string, string>> = {
  en: 'the and is are was were been being of to with that this these those for not you your have has had it its ' +
    'from by which what why how there their they but can will would should could does did an if then than when ' +
    'where who into about only also just we our my he she them at or be do all any some each now here so please',
  fr: 'le les des du est et une qui pour dans pas ne sur avec cette ces il elle ils nous vous sont au aux mais ou ' +
    'je tu été être fait aussi sans très peut tout tous leur son ses mon mes comme donc déjà encore ' +
    'ici où parce quand alors bien qu pourquoi ça comment quoi faut voici voilà merci',
  es: 'el los las es por con para está son como más pero sus ya este esta porque cuando muy sin sobre también ' +
    'hay donde desde todo nos eso esto qué yo él ella puede ser fue lo',
  de: 'der die das und ist nicht ein eine einen zu den mit von sich auf für dem auch ich sie wir sind wird werden ' +
    'oder aber wenn dass noch nach bei aus wie nur kann hat haben war schon diese dieser mehr sehr hier zum zur ' +
    'kein keine',
  it: 'il lo gli di che è per con del della delle sono nel nella alla anche come questo questa ma più molto ' +
    'essere hanno perché quando già ancora tutto tutti solo dove cosa',
  pt: 'do da dos das não uma para com por mais como é são está foi ter tem isso isto este esta mas ' +
    'também já muito ou quando onde ao aos pelo pela nos seu sua você ele ela',
}
// Ne comptent pour aucune langue : les mots communs à plusieurs (« en » français et espagnol, « as » anglais et
// portugais…) et les mots courts qui sont aussi des noms techniques (`os`, `del`, `ce`, `ci`, `im`, `es`, `y`…).
const IGNORED = new Set(('a e o de la en entre no non si in on as que un una se ' +
  'os em um eu ser del y su al ci ce ma sa car es im ha dei').split(' '))

function owners(): Map<string, string> {
  const seen = new Map<string, string | null>()
  for (const [language, words] of Object.entries(WORDS)) {
    for (const word of new Set(words.split(' '))) seen.set(word, seen.has(word) && seen.get(word) !== language ? null : language)
  }
  return new Map([...seen].filter((entry): entry is [string, string] => entry[1] !== null && !IGNORED.has(entry[0])))
}

const OWNER = owners()

// Écritures non latines : la langue est dite par l'écriture (le chinois, le japonais et le coréen ensemble).
const SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['cyrillic', /\p{Script=Cyrillic}/u], ['greek', /\p{Script=Greek}/u], ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u], ['cjk', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
  ['devanagari', /\p{Script=Devanagari}/u], ['thai', /\p{Script=Thai}/u],
]
const LATIN = /\p{Script=Latin}/u

export const NAMES: Readonly<Record<string, string>> = {
  en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese',
  cyrillic: 'a Cyrillic-script language', greek: 'Greek', arabic: 'Arabic', hebrew: 'Hebrew',
  cjk: 'Chinese, Japanese or Korean', devanagari: 'a Devanagari-script language', thai: 'Thai',
}

// Ôtés avant de compter : blocs et morceaux de code, éléments balisés (`<system-reminder>…</system-reminder>`),
// liens, chemins et noms de fichiers.
const CODE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g
const TAGGED = /<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g
const NOISE = /https?:\/\/\S+|\S*[/\\]\S*|\S+\.\w{1,5}\b/g

// Seuils : lettres au moins pour dire quoi que ce soit ; part d'une écriture non latine qui la fait langue ;
// part latine sous laquelle le texte est mêlé ; mots-outils de la langue dite (au moins) ; mots d'une autre langue
// tolérés (emprunts, noms : un dixième des mots de la langue dite ; aucun dans un texte court, vite mêlé).
const MIN_LETTERS = 12
const SCRIPT_SHARE = 0.5
const LATIN_SHARE = 0.9
const MIN_WORDS = 3
const OTHER_SHARE = 0.1

type Profile = { letters: string[]; words: Map<string, number> }

function profile(text: string): Profile {
  const prose = text.replace(CODE, ' ').replace(TAGGED, ' ').replace(NOISE, ' ')
  const words = new Map<string, number>()
  for (const word of prose.toLowerCase().match(/\p{L}+/gu) ?? []) {
    const language = OWNER.get(word)
    if (language !== undefined) words.set(language, (words.get(language) ?? 0) + 1)
  }
  return { letters: prose.match(/\p{L}/gu) ?? [], words }
}

function written(p: Profile, script: RegExp): number {
  return p.letters.filter(letter => script.test(letter)).length
}

function clear(p: Profile): string | undefined {
  if (p.letters.length < MIN_LETTERS) return undefined
  for (const [name, script] of SCRIPTS) if (written(p, script) >= SCRIPT_SHARE * p.letters.length) return name
  if (written(p, LATIN) < LATIN_SHARE * p.letters.length) return undefined
  const [best, next] = [...p.words].sort((a, b) => b[1] - a[1])
  return best !== undefined && best[1] >= MIN_WORDS && (next?.[1] ?? 0) <= OTHER_SHARE * best[1]
    ? best[0] : undefined
}

// Vrai si le texte porte cette langue : un de ses mots-outils au moins (« Peux-tu regarder ? » suivi d'un ticket
// anglais collé), ou une lettre de son écriture. Un emprunt peut s'y glisser : il empêche seulement un refus.
const PRESENT_WORDS = 1

// Lignes collées plutôt qu'écrites par la personne, ôtées de la demande avant de compter : citations (`>`), traces
// et journaux (`Traceback`, `  File "…"`, `    at f (…)`, `#3 0x…`, `ERROR …`, horodatage ou `[niveau]` en tête,
// `NomError: …`). Un ticket ou une trace en anglais collé sous « corrige ça » ne fait pas une demande en anglais.
const PASTED = /^[ \t]*(?:>.*|Traceback\b.*|File "[^"]*".*|at [\w$.<>\[\]]+ ?\(.*|#\d+ .*|(?:ERROR|WARN(?:ING)?|INFO|DEBUG|FATAL|CRITICAL|PANIC)\b.*|\[(?:[A-Za-z]+|\d[\d .:T-]*)\].*|\d{4}-\d\d-\d\d[T ]\d.*|\d\d:\d\d:\d\d\b.*|[\w.]*(?:Error|Exception|Warning)\b:.*|thread '.*' panicked.*)$/gm

function writtenByPerson(request: string): string {
  return request.replace(PASTED, ' ')
}

function present(p: Profile, language: string): boolean {
  const script = SCRIPTS.find(([name]) => name === language)?.[1]
  return script ? written(p, script) > 0 : (p.words.get(language) ?? 0) >= PRESENT_WORDS
}

// La langue d'un texte (`en`, `fr`… ou une écriture : `cyrillic`, `cjk`…), undefined s'il n'est pas clairement
// d'une seule : trop court, mêlé, code, ou d'une langue latine non suivie.
export function languageOf(text: string): string | undefined {
  return clear(profile(text))
}

// Refus (une fois par tour, register.ts) d'une réponse clairement dans une autre langue que la demande, langue
// absente de la demande (lignes collées ôtées) et des messages précédents de la personne (`earlier`) ; undefined
// sinon. Le modèle relance `finish`, inchangé si la personne écrit ou a demandé cette langue.
export function languageRefusal(request: string, reply: string, earlier: readonly string[] = []): string | undefined {
  const asked = profile(writtenByPerson(request))
  const [wanted, given] = [clear(asked), clear(profile(reply))]
  if (wanted === undefined || given === undefined || given === wanted || present(asked, given)) return undefined
  if (earlier.some(text => present(profile(writtenByPerson(text)), given))) return undefined
  const [replyLanguage, requestLanguage] = [NAMES[given] ?? given, NAMES[wanted] ?? wanted]
  return `[finish refused once: the reply looks written in ${replyLanguage} but the request is in ` +
    `${requestLanguage}. If the person writes in ${replyLanguage} or asked for it, call finish again unchanged; ` +
    `otherwise call finish again with the reply in ${requestLanguage}.]`
}

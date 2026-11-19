// Langue des textes que le connecteur montre à la personne (notices, bandeau, ligne d'état, `/<NAME>`) :
// celle que le service rend (`language` de POST /v1/levers, service/language.py), le français tant qu'il ne
// l'a pas dite. Rien n'est jugé ici : le connecteur joint la locale du système (`locale`, un fait neutre) et
// applique la réponse. Une langue par chargement du connecteur, remise au français à chaque chargement.

export type Language = 'fr' | 'en'

let current: Language = 'fr'

// Locale BCP 47 telle que la rend Intl (« en-US », « fr-FR », « zh-Hans-CN ») ; le service ne lit rien d'autre.
const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8}){0,6}$/

export function language(): Language {
  return current
}

// Langue rendue par le service ; vrai si elle change. Toute autre valeur est ignorée.
export function setLanguage(value: unknown): boolean {
  if (value !== 'fr' && value !== 'en') return false
  const changed = value !== current
  current = value
  return changed
}

// Nouveau chargement du connecteur : rien n'est encore su.
export function resetLanguage(): void {
  current = 'fr'
}

// Le texte dans la langue en cours.
export function t(fr: string, en: string): string {
  return current === 'en' ? en : fr
}

// Locale du système, jointe telle quelle à POST /v1/levers ; undefined si elle est illisible.
export function locale(): string | undefined {
  try {
    const found = Intl.DateTimeFormat().resolvedOptions().locale
    return typeof found === 'string' && LOCALE.test(found) ? found : undefined
  } catch {
    // Intl absent ou refusé : la demande part sans locale.
    return undefined
  }
}

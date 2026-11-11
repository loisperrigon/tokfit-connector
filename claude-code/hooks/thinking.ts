// Réflexion en anglais, quelle que soit la langue de la conversation.
//
// Mesuré sur l'historique de Lois (02/11/2026) : la réflexion fait environ
// 63 % des tokens de sortie, et elle suit la langue de l'utilisateur (96 % en
// français). La même réflexion en anglais compte moins de tokens, et personne
// ne la lit : rien à traduire, la réponse reste dans la langue de
// l'utilisateur. Une section fixe ajoutée en fin de prompt système (relue en
// cache), pour un client relié au service seulement. Pas de style « caverne » :
// la consigne n'écarte que les redites, pas le raisonnement.
import type { PromptComposeSection } from 'claude-code'
import { NAME } from './service'
import { POLICY } from './policy'

export const THINKING_SECTION: PromptComposeSection = {
  id: `${NAME}:thinking`,
  text: POLICY.thinking,
  scope: 'session',
}

export const EXECUTION_SECTION: PromptComposeSection = {
  id: `${NAME}:execution`,
  text: POLICY.execution,
  scope: 'session',
}

// Mots-outils de l'anglais : assez fréquents pour qu'un texte anglais en ait toujours.
const ENGLISH = new Set(['the', 'and', 'is', 'are', 'to', 'of', 'that', 'this', 'with', 'for', 'it', 'you', 'not',
  'be', 'have', 'what', 'can', 'do', 'in', 'on', 'my', 'we', 'please', 'how', 'why', 'should', 'would', 'could'])
// En dessous, le message ne dit rien de sa langue (« ok », « go », une commande).
const MIN_WORDS = 4
const ENGLISH_SHARE = 0.15

// Langue du message : anglais, autre, ou inconnue (trop court).
export function language(text: string): 'en' | 'other' | undefined {
  const words = (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter(word => word.length > 1 || word === 'a')
  if (words.length < MIN_WORDS) return undefined
  const english = words.filter(word => ENGLISH.has(word)).length
  return english / words.length >= ENGLISH_SHARE ? 'en' : 'other'
}

// État réel de chaque levier pour cette session, et message à la personne quand le plan de
// session manque. Rien n'est décidé ici : l'état se lit dans ce que le connecteur a reçu
// (plan de session, leviers coupés) et dans ce que le moteur montre (outil `python` connecté).
import type { EngineInterface } from 'claude-code'
import { answer, chosen } from './experiments'
import type { Holdout } from './experiments'
import { sessionPlan } from './plan'
import type { Plans, SessionPlan } from './plan'
import { kernelReady } from './kernel'
import type { Kernel } from './kernel'
import { notice as healthNotice } from './python'
import type { Health } from './python'
import { NAME } from './service'
import type { Link } from './service'

// Leviers du connecteur, dans l'ordre de LEVERS de service/experiments.py (vérifié par
// tests/test_connector.py), et partie du plan de session dont chacun a besoin.
export const LEVERS: readonly (readonly [string, keyof SessionPlan | null])[] = [
  ['routing', null], ['warm', 'warm'], ['compaction', 'compaction'], ['output', 'output'], ['fanout', 'fanout'],
  ['thinking', 'thinking'], ['persistence', 'persistence'], ['kernel', 'kernel'], ['prefix', 'prefix'],
]

// Réponse 402 (essai fini) : le service porte son propre message (trial.ts).
const OWN_NOTICE = 402

export type Notice = { shown: boolean }

export function notice(): Notice {
  return { shown: false }
}

function codeText(code: number): string {
  return code === 0 ? 'service injoignable' : `code ${code}`
}

// Plan de session absent : une seule ligne pour la personne, jamais pour le modèle.
export function planNotice($: EngineInterface, n: Notice, code: number): void {
  if (n.shown || code === OWN_NOTICE) return
  n.shown = true
  $.ui.log(`Économies en pause : le plan du service n'a pas pu être chargé (${codeText(code)}). `
    + `La session continue sans les leviers qui en dépendent ; nouvel essai automatique. /${NAME} montre leur état.`)
}

export type Sources = { holdout: Holdout; content: Plans; kernel: Kernel; health: Health }

// Une ligne par levier : actif, coupé (et par qui) ou inactif (et pourquoi).
export async function leverReport($: EngineInterface, src: Sources, to: Link | null): Promise<string> {
  if (!to) return 'Leviers : inactifs, connecteur non relié au service (adresse ou clé absente).'
  const [plan, told, local] = await Promise.all([sessionPlan($, src.content, to), answer($, src.holdout, to), chosen($, src.holdout)])
  const lines: string[] = []
  for (const [lever, part] of LEVERS) {
    let state = 'actif'
    if (local.has(lever)) state = 'coupé (réglage de l\'application ou de l\'utilisateur)'
    // Routage par message en bêta coupé sur le compte : le service garde modèle et réflexion.
    else if (told.disabled.has(lever)) state = lever === 'routing' ? 'option bêta coupée (à activer dans le tableau de bord)' : 'coupé (réglage du compte)'
    else if (told.off.has(lever)) state = 'coupé (session témoin du service)'
    else if (part !== null && plan === null) state = `inactif (plan du service absent, ${codeText(src.content.missing ?? 0)})`
    else if (part !== null && plan?.[part] === undefined) state = 'inactif (absent du plan du service)'
    else if (lever === 'kernel' && !(await kernelReady($, src.kernel))) {
      const why = healthNotice(src.health.diagnosis)
      state = why ? `inactif (outil agir non connecté : ${why})` : 'inactif (outil agir non connecté)'
    }
    lines.push(`- ${lever} : ${state}`)
  }
  return ['Leviers de cette session :', ...lines, ...(told.outdated ? [`Mise à jour : ${told.outdated}`] : [])].join('\n')
}

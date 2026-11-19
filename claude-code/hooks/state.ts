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
import { t } from './lang'

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
  return code === 0 ? t('service injoignable', 'service unreachable') : `code ${code}`
}

// Plan de session absent : une seule ligne pour la personne, jamais pour le modèle.
export function planNotice($: EngineInterface, n: Notice, code: number): void {
  if (n.shown || code === OWN_NOTICE) return
  n.shown = true
  $.ui.log(t(`Économies en pause : le plan du service n'a pas pu être chargé (${codeText(code)}). `
    + `La session continue sans les leviers qui en dépendent ; nouvel essai automatique. /${NAME} montre leur état.`,
  `Savings paused: the service plan could not be loaded (${codeText(code)}). `
    + `The session goes on without the levers that need it; it will retry on its own. /${NAME} shows their state.`))
}

export type Sources = { holdout: Holdout; content: Plans; kernel: Kernel; health: Health }

// Une ligne par levier : actif, coupé (et par qui) ou inactif (et pourquoi).
export async function leverReport($: EngineInterface, src: Sources, to: Link | null): Promise<string> {
  if (!to) return t('Leviers : inactifs, connecteur non relié au service (adresse ou clé absente).',
    'Levers: inactive, connector not linked to the service (address or key missing).')
  const [plan, told, local] = await Promise.all([sessionPlan($, src.content, to), answer($, src.holdout, to), chosen($, src.holdout)])
  const lines: string[] = []
  for (const [lever, part] of LEVERS) {
    let state = t('actif', 'active')
    if (local.has(lever)) state = t('coupé (réglage de l\'application ou de l\'utilisateur)', 'off (app or user setting)')
    // Routage par message en bêta coupé sur le compte : le service garde modèle et réflexion.
    else if (told.disabled.has(lever)) {
      state = lever === 'routing' ? t('option bêta coupée (à activer dans le tableau de bord)', 'beta option off (turn it on in the dashboard)')
        : t('coupé (réglage du compte)', 'off (account setting)')
    } else if (told.off.has(lever)) state = t('coupé (session témoin du service)', 'off (service holdout session)')
    else if (part !== null && plan === null) {
      const code = codeText(src.content.missing ?? 0)
      state = t(`inactif (plan du service absent, ${code})`, `inactive (service plan missing, ${code})`)
    } else if (part !== null && plan?.[part] === undefined) state = t('inactif (absent du plan du service)', 'inactive (not in the service plan)')
    else if (lever === 'kernel' && !(await kernelReady($, src.kernel))) {
      const why = healthNotice(src.health.diagnosis)
      const reason = src.health.diagnosis?.reason
      state = reason === 'code_mode' || reason === 'permission_rules' ? t(`coupé (${why})`, `off (${why})`)
        : why ? t(`inactif (outil agir non connecté : ${why})`, `inactive (agir tool not connected: ${why})`)
        : t('inactif (outil agir non connecté)', 'inactive (agir tool not connected)')
    }
    lines.push(t(`- ${lever} : ${state}`, `- ${lever}: ${state}`))
  }
  const update = told.outdated ? [t(`Mise à jour : ${told.outdated}`, `Update: ${told.outdated}`)] : []
  return [t('Leviers de cette session :', 'Levers for this session:'), ...lines, ...update].join('\n')
}

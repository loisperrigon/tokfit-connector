// Une seule copie du connecteur par session. Le plugin installé par l'utilisateur
// et la copie qu'embarque une application hôte (Open Codex) se chargeaient ensemble
// (vu en production le 11/11/2026) : deux décisions par message, la seconde lisant le
// réglage de la première comme celui de l'utilisateur, et chaque étape comptée deux
// fois. La première copie admise refuse donc les suivantes au chargement
// (`plugin.register`) : la copie refusée ne pose aucun hook. Les deux lisent le même
// environnement (relais, leviers coupés, pont de l'application), donc celle qui reste
// se comporte comme l'autre l'aurait fait.

// Noms sous lesquels le connecteur se charge : celui du dépôt (copie embarquée par une
// application hôte) et celui de sa version publiée.
export const COPIES: readonly string[] = ['economiseur', 'tokfit'] // publish: keep
export const REFUSED = 'une copie du connecteur agit déjà dans cette session'

export type Loaded = { name: string; root: string }

// Vrai si `other` est une autre copie du connecteur que `own` (un autre dossier).
export function twin(own: Loaded, other: Loaded): boolean {
  return COPIES.includes(other.name) && other.root !== own.root
}

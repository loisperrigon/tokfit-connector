// Une seule copie du connecteur par session (plugin installé par l'utilisateur et copie
// qu'embarque une application hôte) : la première copie admise refuse les suivantes au
// chargement (`plugin.register`), la copie refusée ne pose aucun hook. Les deux lisent le
// même environnement (relais, leviers coupés, pont de l'application).

// Noms sous lesquels le connecteur se charge : celui du dépôt (copie embarquée par une
// application hôte) et celui de sa version publiée.
export const COPIES: readonly string[] = ['economiseur', 'tokfit'] // publish: keep
export const REFUSED = 'une copie du connecteur agit déjà dans cette session'

export type Loaded = { name: string; root: string }

// Vrai si `other` est une autre copie du connecteur que `own` (un autre dossier).
export function twin(own: Loaded, other: Loaded): boolean {
  return COPIES.includes(other.name) && other.root !== own.root
}

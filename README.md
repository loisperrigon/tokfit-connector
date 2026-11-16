# tokfit

Consommer moins avec le même abonnement. tokfit choisit, à chaque message,
le modèle et le niveau de réflexion de ton Claude Code (et de ton Codex) : le
moins cher qui suffit, le plus fort quand la tâche le demande. Un tableau de
bord chiffre l'économie, chaque chiffre étant marqué `measured` ou `estimated`.

## Ce qu'il fait (Claude Code)

- **Modèle et réflexion** choisis à chaque message, sous-agents compris. Le
  modèle de ta session reste le point de départ ; un message qui corrige la
  réponse précédente y ramène.
- **Cache gardé au chaud** pendant une courte pause, pour que la reprise ne
  relise pas toute la conversation au prix fort.
- **Compaction au bon moment**, en fin de tour, quand elle coûte moins cher
  que de continuer.
- **Sorties de commandes bruyantes raccourcies** (jamais une erreur) ; relance
  la commande avec `TOKFIT_RAW=1` pour la sortie entière.
- **Sous-agents lancés ensemble** : les suivants attendent au plus 3 s pour
  partager le début du premier en cache.
- **Réflexion en anglais**, moins chère ; la réponse reste dans ta langue.
- **Fin de tour vérifiée** : si le plan de la tâche a encore des étapes
  ouvertes, Claude reprend une fois.
- **Un seul outil, `python`** (levier `kernel`) : Claude n'agit plus par ses
  outils natifs (Read, Edit, Bash…), retirés de sa liste et refusés s'il les
  rappelle, mais par du code Python dans un noyau persistant sur ta machine.
  Lire, écrire, chercher et lancer des commandes s'y font en une cellule, avec
  des outils déjà chargés ; la fin du tour (`fini`) rend la réponse et refuse
  de conclure si les tests échouent. Chaque agent (le fil principal, chaque
  sous-agent) a son propre noyau : dossier courant et variables ne se
  partagent jamais. Il faut `python3` (3.9 ou plus) ; sans lui, rien ne change.
- **Début du prompt identique d'un projet à l'autre** (levier `prefix`) : la
  partie du prompt système propre au projet (chemin de la mémoire) passe dans
  le premier message, et le reste est relu en cache au lieu d'être réécrit.

`/tokfit` donne le lien de ton tableau de bord et l'état de chaque levier
pour la session : actif, coupé (et par qui) ou inactif (et pourquoi). Si le
service ne peut pas envoyer le plan des leviers, une ligne te le dit, une
seule fois, et la session continue sans eux.
Pour voir ton bilan ou bloquer des modèles et des niveaux de réflexion sur
tout ton compte, demande-le à Claude : il passe par l'outil `compte`.

Pour mesurer le gain réel de chaque levier, il est coupé sur une petite part
des sessions, tirées au sort. Pour en couper un toi-même :
`TOKFIT_OFF=warm,compaction` (leviers : `routing`, `warm`, `compaction`,
`output`, `fanout`, `thinking`, `persistence`, `kernel`, `prefix`).
`TOKFIT_OFF=kernel` rend à Claude ses outils natifs. Un modèle que tu fixes
(balise, `routing` coupé) n'entre pas dans le calcul de l'économie.

## Ce qui part, ce qui reste chez toi

- Le texte de ton message n'est envoyé qu'au service, à `/v1/route`, pour qu'il
  juge la difficulté. Il n'est jamais écrit (ni base, ni journal, ni log).
- Le reste n'est que des nombres et des libellés : compteurs de tokens, modèle,
  réflexion, faits chiffrés de chaque levier, taille du contexte de départ
  (jamais un chemin de fichier). Ils alimentent le tableau de bord.
- La fin de tour lit la conversation sur ta machine ; seuls les états du plan
  (ouvert, fait) partent.
- Le code que Claude lance dans le noyau ne quitte pas ta machine : seuls les
  nombres d'appels partent. Seule exception, voulue : une fonction générique
  qu'il range pour la réutiliser (`sauve_outil`) est gardée par le service,
  rattachée à ta clé, jamais le code de ton projet.
- Le connecteur n'écrit rien sur ta machine, hors son fichier de configuration.
- Si le service est lent (plus de 6 s) ou en panne, ton réglage en cours est
  gardé, sans message.
- Pour Codex, rien de la réponse d'un modèle d'OpenAI n'est envoyé.

## Installation

Sans clé, l'essai démarre tout seul au premier lancement (clé anonyme, rien à
remplir). Après l'abonnement, la clé tokfit (`ek_…`) remise une fois.

Claude Code :

```sh
claude plugin install tokfit --marketplace <source>                       # essai
claude plugin install tokfit --marketplace <source> --config api_key=ek_… # abonné
```

Une ligne, sans rien cloner (la clé est demandée, saisie masquée ; vide : essai) :

```sh
curl -fsSL https://raw.githubusercontent.com/loisperrigon/tokfit-connector/main/install.sh | sh -s claude
curl -fsSL https://raw.githubusercontent.com/loisperrigon/tokfit-connector/main/install.sh | sh -s codex   # lanceur : `tokfit codex …`
```

Pour les non-techniciens : [INSTALL-PROMPT.md](INSTALL-PROMPT.md) est un prompt à coller dans
Claude Code ou Codex, qui fait toute l'installation (la landing propose un bouton « Copier »).

Depuis un clone : `sh install.sh` (Claude Code) ou `sh install.sh codex`.

Mises à jour : automatiques. Au premier lancement, le plugin active la mise à jour
automatique de sa marketplace (comme « Enable auto-update » dans `/plugin`) ; un
choix déjà fait n'est pas touché. Les nouvelles versions s'installent en arrière-plan
et s'appliquent à la session suivante (ou tout de suite avec `/reload-plugins`).
Depuis une version antérieure à 0.7.8 : une seule mise à jour à la main
(`claude plugin update tokfit`), ensuite plus rien à faire.

La clé est écrite dans `~/.config/tokfit/config.json` (mode 600) ; la variable
`TOKFIT_CONFIG` désigne un autre fichier.

## Balises

Une balise dans ton message reste prioritaire sur le service : `[opus]`,
`[low]`, `ultrathink`… Pour Codex : `[low]`, `[medium]`, `[high]`, `[xhigh]`
dans le message, et les options de `codex` (`-m`, `-c`, `-p`), qui passent
avant la balise.

## Développement

```sh
claude plugin validate --strict claude-code
claude plugin test claude-code
tsc -p claude-code
```

## Licence

MIT, voir [LICENSE](LICENSE).

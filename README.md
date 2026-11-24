# tokfit

Tokfit aide Claude Code, Codex et Antigravity CLI à consommer moins.
L’installation détecte les outils présents sur ton ordinateur.

**Pour commencer**, colle le [message d’installation](INSTALL-PROMPT.md) dans
ton agent, ou utilise la commande ci-dessous.

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
- **Un seul outil, `agir`** (levier `kernel`) : Claude n'agit plus par ses
  outils natifs (Read, Edit, Bash…), retirés de sa liste et refusés s'il les
  rappelle, mais par du code Python dans un noyau persistant sur ta machine.
  Lire, écrire, chercher et lancer des commandes s'y font en une cellule, avec
  des outils déjà chargés ; la fin du tour (`finish`) rend la réponse et refuse
  de conclure si les tests échouent, ou une fois si la seule preuve donnée est de
  pure forme (un fichier présent, une compilation). Une commande longue (build,
  serveur, entraînement) tourne en arrière-plan (`job`) et se relit sans bloquer
  Claude ; elle s'arrête avec la session. Un module Python manquant s'installe à
  la demande (`need`), sans toucher un Python géré par ton système. La réponse
  reste dans ta langue, même avec un ticket ou une trace en anglais collés dans
  ta demande. Chaque agent (le fil principal, chaque
  sous-agent) a son propre noyau : dossier courant et variables ne se
  partagent jamais. Rien à installer : tokfit télécharge son propre Python
  (python-build-standalone, empreinte vérifiée) dans `~/.cache/tokfit/python`,
  à part de tes environnements (venv, conda), qu'il ne touche pas. Linux, macOS
  et Windows ; sous Windows, rien à installer non plus : le plugin passe par cmd
  et PowerShell, livrés avec Windows. Si l'outil manque,
  la raison s'affiche au-dessus de la saisie et `/tokfit` la détaille.
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
- La configuration, les clés des installations et le cache Python restent sur ta machine.
- Si le service est lent (plus de 6 s) ou en panne, ton réglage en cours est
  gardé, sans message.
- Pour Codex, rien de la réponse d'un modèle d'OpenAI n'est envoyé.

## Installation

Sur macOS ou Linux, ou dans l’environnement shell où tu utilises tes CLI :

```sh
curl -fsSL https://raw.githubusercontent.com/loisperrigon/tokfit-connector/main/install.sh | sh
```

Si plusieurs CLI sont présents, cette commande installe Tokfit dans chacun.
Depuis un clone, choisis un seul CLI avec `sh install.sh claude`,
`sh install.sh codex` ou `sh install.sh agy`. Codex et Antigravity utilisent
Python 3.9 ou ultérieur, disponible sous la commande `python3`.
Pour Claude Code seul, y compris sous Windows, tu peux aussi utiliser directement
`claude plugin install tokfit --marketplace loisperrigon/tokfit-connector`.

Ouvre ensuite une nouvelle conversation :

- **Claude Code** charge le plugin automatiquement. Tape `/tokfit` pour voir son
  état ou ouvrir ton tableau de bord.
- **Codex** peut appeler les outils `agir` (travail local en Python, avec
  approbation) et `compte` (bilan) dans les conversations ordinaires. Pour que
  tokfit puisse également choisir le modèle et l’effort au démarrage et relever
  les compteurs, commence ta conversation avec `tokfit codex "ma demande"`.
- **Antigravity CLI** peut appeler `agir` avec un schéma compact et découvrir
  les fonctions Python à la demande via `find_tool`. Les autorisations MCP
  suivent tes réglages Antigravity. `agy plugin list --json` affiche la
  version de Tokfit et l’état du plugin.
- **Claude et Codex ensemble** peuvent travailler en parallèle. Chaque session
  a son propre noyau Python. Si les deux modifient le même dossier, elles voient
  les mêmes fichiers.

Pour une installation manuelle dans l’application Antigravity ou son IDE,
place une copie de ce dépôt dans `~/.gemini/config/plugins/tokfit` pour tous
tes projets, ou `.agents/plugins/tokfit` à la racine d’un seul projet.
Antigravity doit pouvoir lancer `python3`. La procédure de chargement dépend
de l’application utilisée. [Documentation Antigravity](https://antigravity.google/docs/plugins).

### Utiliser le même abonnement

Tu peux démarrer sans clé. Laisse la saisie vide. Claude et Codex reçoivent
chacun une identité d’installation. Pour réunir leurs historiques, ouvre
`/tokfit` dans Claude, puis `tokfit compte` dans un terminal pour Codex.
Ouvre chacun des deux liens, connecte-toi au même compte tokfit et confirme
le rattachement. L’abonnement couvre ensuite les deux installations.

Si tu possèdes déjà une clé tokfit, saisis-la une fois dans l’installateur.
Les CLI lisent le même fichier privé `~/.config/tokfit/config.json`,
ou le fichier désigné par `TOKFIT_CONFIG`. Une clé réglée explicitement dans
le plugin Claude reste prioritaire dans Claude.

### Mettre à jour ou retirer un seul connecteur

- **Mettre Claude à jour** : `claude plugin update tokfit`, puis ouvre une
  nouvelle session. Claude Code prend aussi en charge les mises à jour
  automatiques de la marketplace.
- **Mettre Codex à jour.** Depuis la version 0.7.37, l’installateur téléchargé
  active les mises à jour au démarrage sur les CLI compatibles. Si tu utilisais
  une ancienne version, relance une fois la commande d’installation ci-dessus.
  Pour vérifier la version, utilise `codex plugin list -m tokfit-distribution --json`.
  Pour chercher une mise à jour immédiatement, utilise
  `codex plugin marketplace upgrade tokfit-distribution`. Les sessions ouvertes
  terminent avec leur version. Une installation depuis un clone, une source
  personnalisée ou un ancien CLI se met à jour en relançant son installateur.
- **Mettre Antigravity à jour** en relançant `sh install.sh agy` depuis un
  clone à jour ou `agy plugin install https://github.com/loisperrigon/tokfit-connector`,
  puis ouvre une nouvelle session.
- **Retirer Antigravity** avec `agy plugin uninstall tokfit`.
- **Retirer Claude** : `claude plugin uninstall tokfit`. Tu peux continuer à
  utiliser tokfit dans Codex.
- **Retirer Codex** : ferme d’abord ses sessions tokfit. Dans `codex mcp list`,
  repère l’entrée qui lance ta commande `tokfit _mcp`. Retire uniquement cette
  entrée avec `codex mcp remove NOM`. Si le plugin natif est installé, exécute
  `codex plugin remove tokfit-runtime@tokfit-distribution`, puis
  `codex plugin marketplace remove tokfit-distribution`. Si tu utilises plusieurs
  dossiers Codex, répète ces étapes dans ceux que tu veux désinstaller. Quand
  tu retires le dernier, supprime le lanceur `tokfit` et ses fichiers présents
  (`.tokfit-codex-managed`, `tokfit-codex`, `.tokfit-codex-releases`)
  dans le répertoire d’installation (par défaut
  `~/.local/bin`). Dans `$CODEX_HOME/agents` (par défaut `~/.codex/agents`),
  retire `tokfit-executor.toml` si sa première ligne est
  `# tokfit executor agent`. Garde la configuration commune tant que tu
  utilises tokfit dans Claude.

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

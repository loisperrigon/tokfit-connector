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

Pour mesurer le gain réel de chaque levier, il est coupé sur une petite part
des sessions, tirées au sort. Pour en couper un toi-même :
`TOKFIT_OFF=warm,compaction` (leviers : `routing`, `warm`, `compaction`,
`output`, `fanout`, `thinking`, `persistence`). Un modèle que tu fixes
(balise, `routing` coupé) n'entre pas dans le calcul de l'économie.

## Ce qui part, ce qui reste chez toi

- Le texte de ton message n'est envoyé qu'au service, à `/v1/route`, pour qu'il
  juge la difficulté. Il n'est jamais écrit (ni base, ni journal, ni log).
- Le reste n'est que des nombres et des libellés : compteurs de tokens, modèle,
  réflexion, faits chiffrés de chaque levier, taille du contexte de départ
  (jamais un chemin de fichier). Ils alimentent le tableau de bord.
- La fin de tour lit la conversation sur ta machine ; seuls les états du plan
  (ouvert, fait) partent.
- Le connecteur n'écrit rien sur ta machine, hors son fichier de configuration.
- Si le service est lent (plus de 6 s) ou en panne, ton réglage en cours est
  gardé, sans message.
- Pour Codex, rien de la réponse d'un modèle d'OpenAI n'est envoyé.

## Installation

Il te faut une clé tokfit (`ek_…`).

Claude Code :

```sh
claude plugin install tokfit --marketplace <source> --config api_key=ek_…
```

Une ligne, sans rien cloner (la clé est demandée, saisie masquée) :

```sh
curl -fsSL https://raw.githubusercontent.com/loisperrigon/tokfit-connector/main/install.sh | sh -s claude
curl -fsSL https://raw.githubusercontent.com/loisperrigon/tokfit-connector/main/install.sh | sh -s codex   # lanceur : `tokfit codex …`
```

Pour les non-techniciens : [INSTALL-PROMPT.md](INSTALL-PROMPT.md) est un prompt à coller dans
Claude Code ou Codex, qui fait toute l'installation (la landing propose un bouton « Copier »).

Depuis un clone : `sh install.sh` (Claude Code) ou `sh install.sh codex`.

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

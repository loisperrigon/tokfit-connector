# tokfit

Consommer moins avec le même abonnement. tokfit choisit, à chaque message,
le modèle et le niveau de réflexion de ton Claude Code (et de ton Codex) : le
moins cher qui suffit, le plus fort quand la tâche le demande. Un tableau de
bord chiffre l'économie, chaque chiffre étant marqué `measured` ou `estimated`.

## Ce qui part, ce qui reste chez toi

- Le texte de ton message n'est envoyé qu'au service, à `/v1/route`, pour qu'il
  juge la difficulté. Il n'est jamais écrit (ni base, ni journal, ni log).
- Le reste (compteurs de tokens, modèle, réflexion) alimente le tableau de bord.
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

Une ligne, avec Claude Code et/ou le lanceur Codex :

```sh
sh install.sh            # Claude Code
sh install.sh codex      # lanceur Codex : `tokfit codex …`
```

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

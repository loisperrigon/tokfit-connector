Installe Tokfit pour les CLI que j’utilise sur cet ordinateur, parmi Claude Code, Codex et Antigravity. Je veux continuer à les lancer comme d’habitude.

1. Vérifie quels CLI sont installés (`claude`, `codex`, `agy`). Pour Claude Code seul, tu peux utiliser `claude plugin install tokfit --marketplace loisperrigon/tokfit-connector`. Pour Codex et Antigravity, vérifie que `python3` pointe vers Python 3.9 ou ultérieur dans le même environnement que le CLI.
2. Pour Codex, Antigravity ou plusieurs CLI, récupère l’installateur officiel dans un dossier temporaire privé. Lis-le puis lance-le en mode de détection automatique. Avec ce nom de fichier, il récupère les composants dans le dépôt public. Je peux commencer sans clé et l’installation conserve la clé que j’ai déjà configurée.

   ```sh
   dossier=$(mktemp -d) &&
   curl -fsSL https://raw.githubusercontent.com/loisperrigon/tokfit-connector/main/install.sh -o "$dossier/tokfit-setup"
   ```

   Après lecture du script :

   ```sh
   TOKFIT_KEY= sh "$dossier/tokfit-setup"
   ```

3. Vérifie chaque installation. Pour Claude, consulte la liste des plugins. Pour Codex, vérifie la présence du lanceur et du serveur MCP Tokfit. Si la marketplace native est disponible, vérifie que `codex plugin list -m tokfit-distribution --json` affiche le plugin tokfit-runtime activé. Pour Antigravity, vérifie que `agy plugin list --json` affiche Tokfit activé et le serveur `outils`. Garde mes choix d’approbation. Utilise les noms des composants pour faire ton compte rendu, sans afficher de clé, de jeton ni de lien personnel.
4. Dis-moi quels outils sont prêts et invite-moi à ouvrir une nouvelle conversation. Dans Codex, je peux demander mon bilan et approuver un appel à `agir`. Pour le routage de modèle et le relevé des compteurs, je lance `tokfit codex "ma demande"`. Si j’ai commencé sans clé et que j’utilise les deux outils, indique-moi comment réunir mes installations : `/tokfit` dans Claude, `tokfit compte` dans mon terminal pour Codex, puis connexion au même compte tokfit et confirmation sur chaque lien.

Si un outil échoue, précise lequel, ce qui fonctionne déjà et ce qu’il reste à faire. Pour mettre à jour ou retirer un seul connecteur, suis la rubrique correspondante du [README](README.md) en préservant les réglages de l’autre.

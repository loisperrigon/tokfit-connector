Installe tokfit pour les outils que j’utilise sur cet ordinateur, Claude Code, Codex ou les deux. Je veux pouvoir continuer à les lancer comme d’habitude et retrouver mes économies sur le même compte.

1. Vérifie quels CLI sont installés dans mon environnement. Pour Claude Code seul, tu peux utiliser `claude plugin install tokfit --marketplace loisperrigon/tokfit-connector`. Si Codex est présent, vérifie que Python 3.9 ou ultérieur et un shell POSIX sont disponibles dans le même environnement que Codex.
2. Pour installer dans Codex, ou dans les deux outils, récupère l’installateur officiel dans un dossier temporaire privé. Lis-le puis lance-le en mode de détection automatique. Avec ce nom de fichier, il récupère les composants dans le dépôt public. Je peux commencer sans clé et l’installation conserve la clé que j’ai déjà configurée.

   ```sh
   dossier=$(mktemp -d) &&
   curl -fsSL https://raw.githubusercontent.com/loisperrigon/tokfit-connector/main/install.sh -o "$dossier/tokfit-setup"
   ```

   Après lecture du script :

   ```sh
   TOKFIT_KEY= sh "$dossier/tokfit-setup"
   ```

3. Vérifie chaque installation. Pour Claude, consulte la liste des plugins. Pour Codex, vérifie la présence du lanceur et du serveur MCP tokfit dans la configuration du profil utilisé. Garde mes choix d’approbation. Utilise les noms des composants pour faire ton compte rendu, sans afficher de clé, de jeton ni de lien personnel.
4. Dis-moi quels outils sont prêts et invite-moi à ouvrir une nouvelle conversation. Dans Codex, je peux demander mon bilan et approuver un appel à `agir`. Pour le routage de modèle et le relevé des compteurs, je lance `tokfit codex "ma demande"`. Si j’ai commencé sans clé et que j’utilise les deux outils, indique-moi comment réunir mes installations : `/tokfit` dans Claude, `tokfit compte` dans mon terminal pour Codex, puis connexion au même compte tokfit et confirmation sur chaque lien.

Si un outil échoue, précise lequel, ce qui fonctionne déjà et ce qu’il reste à faire. Pour mettre à jour ou retirer un seul connecteur, suis la rubrique correspondante du [README](README.md) en préservant les réglages de l’autre.

Installe tokfit sur cet ordinateur, de bout en bout, sans me poser de question technique.

tokfit choisit à chaque message le modèle et le niveau de réflexion de mon outil, pour que je consomme moins avec le même abonnement. Ma clé tokfit : {{CLE}}

1. Repère l'outil dans lequel tu tournes : Claude Code ou Codex.
2. Lance UNE seule de ces commandes, celle de ton outil. Tu peux lire le script avant, à l'adresse de la commande. La clé ne passe que par la variable TOKFIT_KEY : ne la répète pas dans ta réponse et ne l'écris dans aucun fichier du projet.
   - Claude Code : TOKFIT_KEY={{CLE}} sh -c 'curl -fsSL https://raw.githubusercontent.com/loisperrigon/tokfit-connector/main/install.sh | sh -s claude'
   - Codex : TOKFIT_KEY={{CLE}} sh -c 'curl -fsSL https://raw.githubusercontent.com/loisperrigon/tokfit-connector/main/install.sh | sh -s codex'
3. Vérifie que le service répond : curl -fsS https://tokfit.dodoia.re/health doit afficher "status":"ok".
4. Dis-moi en deux phrases ce qui est fait et ce que je dois faire ensuite :
   - Claude Code : fermer cette session et en ouvrir une nouvelle ; tokfit agit dès le prochain message.
   - Codex : lancer « tokfit codex "ma demande" » à la place de « codex "ma demande" ».

Si une étape échoue, dis-moi laquelle et pourquoi, et n'installe rien d'autre.
Pour tout retirer plus tard : « claude plugin uninstall tokfit » (Claude Code) ou supprimer le fichier ~/.local/bin/tokfit (Codex), puis supprimer le dossier ~/.config/tokfit.

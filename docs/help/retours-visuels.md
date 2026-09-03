# Retours visuels Chrome

L’extension Chrome de Pupitre transforme une zone pointée sur une page locale en demande de correction contextualisée. Elle transmet la capture, la position, des sélecteurs DOM, un extrait HTML nettoyé et les styles utiles.

## Installer l’extension

1. Depuis le dépôt Pupitre, exécute `cd chrome-extension && bun run build`.
2. Ouvre `chrome://extensions` dans Chrome.
3. Active le mode développeur.
4. Clique sur **Charger l’extension non empaquetée** et choisis `chrome-extension/dist`.
5. Dans **Réglages → Retours visuels Chrome**, génère un jeton.
6. Ouvre l’extension, saisis le jeton et le port de Pupitre : `4820` pour la stable ou `4821` pour la dev.

## Annoter une page

Sur une page servie depuis `localhost`, `*.localhost` ou `127.0.0.1` :

1. utilise `Alt+Maj+P` ou **Pointer une zone** dans l’extension ;
2. survole l’interface puis clique l’élément concerné ;
3. saisis la correction souhaitée ;
4. recommence pour ajouter d’autres annotations ;
5. ouvre l’extension, choisis la branche et éventuellement une conversation existante ;
6. envoie le panier.

Les paniers sont séparés par projet. Si aucune conversation compatible n’est sélectionnée, Pupitre en crée automatiquement une dans le worktree de la branche choisie.

## Résoudre un projet inconnu

Pupitre tente d’identifier le projet depuis le processus qui écoute sur le port de la page. Si cette détection échoue ou reste ambiguë, le panneau de l’extension affiche les projets disponibles. L’association choisie est mémorisée pour l’origine et le chemin courants.

## Sécurité et erreurs

Le jeton reste dans le stockage privé de l’extension et n’est pas transmis à la page inspectée. Les valeurs de formulaires et contenus éditables sont supprimés du contexte DOM. Si Pupitre ou le worktree est indisponible, le panier reste enregistré et peut être renvoyé.

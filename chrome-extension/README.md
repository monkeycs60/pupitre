# Extension Chrome — retours visuels Pupitre

```bash
cd chrome-extension
bun install
bun run build
```

Dans `chrome://extensions`, activer le mode développeur puis charger le dossier `chrome-extension/dist` comme extension non empaquetée. Dans Pupitre, ouvrir Réglages → Retours visuels Chrome, générer un jeton et le saisir dans l'extension avec le port de l'instance (`4820` stable, `4821` dev).

Sur une page `localhost`, utiliser `Alt+Shift+P`, cliquer la zone et saisir la correction. Le panier flottant permet ensuite de choisir la branche, suivre les zones annotées et envoyer à Pupitre sans rouvrir l’extension.

# Extension Chrome — retours visuels Pupitre

```bash
cd chrome-extension
bun install
bun run build
```

Dans `chrome://extensions`, activer le mode développeur puis charger le dossier `chrome-extension/dist` comme extension non empaquetée. Dans Pupitre, ouvrir Réglages → Retours visuels Chrome, générer un jeton et le saisir dans l'extension avec le port de l'instance (`4820` stable, `4821` dev).

Sur une page `localhost`, utiliser `Alt+Shift+P`, cliquer la zone, saisir la correction, puis ouvrir l'extension pour choisir la branche et envoyer le panier.

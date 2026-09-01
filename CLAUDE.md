# Règles du dépôt

## Chantier backend : le sidecar en développement

Le port 4820 appartient à l'instance stable et ne doit jamais être pris par un
script de développement. `bun run dev:sidecar` et
`bun run dev:sidecar:watch` visent l'instance dev sur 4821, avec les données
séparées de `~/.local/share/pupitre-dev`.

Ces commandes sont utilisables depuis une conversation Pupitre stable :
redémarrer la dev ne coupe aucun tour stable. Une modification backend se
vérifie avec la dev et le front Vite sur `http://localhost:5173`.

Le sidecar dev lancé par Tauri n'a pas de watch automatique. `dev:sidecar`
laisse choisir le moment du redémarrage ; `dev:sidecar:watch` relance à chaque
sauvegarde. Aucun changement de source n'atteint la stable sans promotion.
Seul l'utilisateur déclenche `bun run promote` ou le bouton « Promouvoir cette
version » dans les réglages de la dev.

## Vérifier dans le navigateur, pas seulement dans les tests

Toute affirmation sur ce que l'interface **fait** se vérifie dans l'app qui
tourne, avant d'être annoncée — qu'il s'agisse d'un correctif ou d'une
fonctionnalité ajoutée. Un test vert prouve qu'une fonction rend ce qu'on lui a
demandé de rendre ; il ne prouve pas que l'écran est juste.

Vite sert le même front que l'app sur `http://localhost:5173`, avec
rechargement à chaud : ouvre-le avec Claude in Chrome. **Aucun redémarrage du
sidecar n'est nécessaire pour un changement d'UI**, donc cette vérification
reste permise depuis une conversation Pupitre.

- **Mesure dans le DOM, ne te fie pas à l'œil.** Deux bugs du graphe Git sont
  passés sous des captures zoomées avant d'être trouvés en comparant des
  coordonnées : 185 lignes sur 186 étaient coupées. Compte les éléments, lis
  leurs attributs, confronte-les à ce que tu affirmes.
- **Prends une capture et joins-la** à la réponse : elle vaut mieux que la
  description du résultat.
- **Lance les deux suites.** `cd sidecar && bun test` ne joue pas les tests de
  l'UI ; `cd ui && bun test` les exécute (happy-dom + testing-library).
- Sur un composant, cherche la contradiction plutôt que la confirmation : le
  compte d'éléments attendu, l'absence de doublon, la continuité d'un tracé.

## Fin de tâche et Git

- À la fin de toute tâche qui modifie le dépôt, vérifie les changements et les tests pertinents, puis crée un commit descriptif avant de rendre la main.
- Pousse le commit seulement si l’utilisateur l’a demandé explicitement ou si la tâche prévoit une publication.
- Ne mélange pas de changements hors périmètre dans un commit sans confirmation explicite.

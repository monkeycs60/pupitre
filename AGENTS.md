# Interface

## Documents de réflexion

- Pour présenter un audit, un brainstorming, un plan, une roadmap ou une approche structurée qui deviendrait longue en Markdown, préfère un document HTML autonome et éphémère dans `/tmp`. Garde le Markdown pour les réponses courtes et les plans simples.
- Regroupe le CSS, le JavaScript et les assets nécessaires dans un seul fichier portable, vérifie son rendu avant de le remettre, puis fournis un lien direct vers le document.
- Ne versionne le document dans le dépôt que si l'utilisateur demande explicitement une version durable.

## Menus imbriqués

- Ancre chaque sous-menu au bouton qui l’ouvre, avec un conteneur local `position: relative` et un sous-menu `position: absolute` (`top: 0; left: calc(100% + 8px)`). Ne les aligne jamais globalement par rapport au bas ou au haut du menu parent : la hauteur de son contenu varie et décale alors le sous-menu.

## Chantier backend : le sidecar en développement

- Le sidecar lancé par `bunx tauri dev` n'a pas de `--watch` : une modification sous `sidecar/` dort sur le disque jusqu'à ce que le process redémarre. `bun run dev:sidecar` (racine) le relance au premier plan sans recompiler le Rust ; `bun run dev:sidecar:watch` y ajoute le redémarrage à chaque sauvegarde.
- **Si tu réponds depuis une conversation Pupitre, ne lance ni l'un ni l'autre** : ces commandes réclament le port 4820 et arrêtent le sidecar qui diffuse ta réponse. L'utilisateur perdrait le tour. La prise de port n'est jamais anodine, y compris au premier lancement.
- Dans ce cas, édite le sidecar, vérifie par `bun test` dans `sidecar/` (qui n'a besoin d'aucun sidecar vivant), et signale dans le bloc TODO que le changement exige un redémarrage pour être actif, en donnant la commande.
- `dev:sidecar` te revient pleinement hors conversation Pupitre, dans un terminal où rien ne diffuse.

## Vérifier dans le navigateur, pas seulement dans les tests

- Toute affirmation sur ce que l'interface **fait** se vérifie dans l'app qui tourne avant d'être annoncée, correctif comme fonctionnalité ajoutée. Un test vert prouve qu'une fonction rend ce qu'on lui a demandé ; il ne prouve pas que l'écran est juste.
- Vite sert le même front que l'app sur `http://localhost:5173`, avec rechargement à chaud : ouvre-le avec Claude in Chrome. Un changement d'UI n'exige **aucun redémarrage du sidecar**, donc cette vérification reste permise depuis une conversation Pupitre.
- **Mesure dans le DOM plutôt que de juger à l'œil** : compte les éléments, lis leurs attributs, confronte-les à ce que tu affirmes. Deux bugs du graphe Git sont passés sous des captures zoomées avant d'être trouvés en comparant des coordonnées — 185 lignes sur 186 étaient coupées.
- Prends une capture et joins-la à la réponse : elle vaut mieux que la description du résultat.
- Lance les deux suites : `cd sidecar && bun test` ne joue pas les tests de l'UI, que `cd ui && bun test` exécute (happy-dom + testing-library).
- Cherche la contradiction plutôt que la confirmation : compte d'éléments attendu, absence de doublon, continuité d'un tracé.

## Fin de tâche et Git

- À la fin de toute tâche qui modifie le dépôt, vérifie les changements et les tests pertinents, puis crée un commit descriptif avant de rendre la main.
- Pousse le commit seulement si l’utilisateur l’a demandé explicitement ou si la tâche prévoit une publication.
- Ne mélange pas de changements hors périmètre dans un commit sans confirmation explicite.

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

## Fin de tâche et Git

- À la fin de toute tâche qui modifie le dépôt, vérifie les changements et les tests pertinents, puis crée un commit descriptif avant de rendre la main.
- Pousse le commit seulement si l’utilisateur l’a demandé explicitement ou si la tâche prévoit une publication.
- Ne mélange pas de changements hors périmètre dans un commit sans confirmation explicite.

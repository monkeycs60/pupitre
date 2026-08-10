# Interface

## Documents de réflexion

- Pour présenter un audit, un brainstorming, un plan, une roadmap ou une approche structurée qui deviendrait longue en Markdown, préfère un document HTML autonome et éphémère dans `/tmp`. Garde le Markdown pour les réponses courtes et les plans simples.
- Regroupe le CSS, le JavaScript et les assets nécessaires dans un seul fichier portable, vérifie son rendu avant de le remettre, puis fournis un lien direct vers le document.
- Ne versionne le document dans le dépôt que si l'utilisateur demande explicitement une version durable.

## Menus imbriqués

- Ancre chaque sous-menu au bouton qui l’ouvre, avec un conteneur local `position: relative` et un sous-menu `position: absolute` (`top: 0; left: calc(100% + 8px)`). Ne les aligne jamais globalement par rapport au bas ou au haut du menu parent : la hauteur de son contenu varie et décale alors le sous-menu.

## Fin de tâche et Git

- À la fin de toute tâche qui modifie le dépôt, vérifie les changements et les tests pertinents, puis crée un commit descriptif avant de rendre la main.
- Pousse le commit seulement si l’utilisateur l’a demandé explicitement ou si la tâche prévoit une publication.
- Ne mélange pas de changements hors périmètre dans un commit sans confirmation explicite.

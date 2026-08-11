# Règles du dépôt

## Chantier backend : le sidecar en développement

Le sidecar lancé par `bunx tauri dev` n'a pas de `--watch` : une modification
sous `sidecar/` dort sur le disque jusqu'à ce que le process redémarre.
`bun run dev:sidecar` (racine) relance le sidecar au premier plan sans
recompiler le Rust ; `bun run dev:sidecar:watch` y ajoute le redémarrage à
chaque sauvegarde.

**Si tu réponds depuis une conversation Pupitre, ne lance ni l'un ni l'autre.**
Ces commandes réclament le port 4820 et arrêtent le sidecar en place — c'est-à-dire
celui qui diffuse ta réponse en cours. L'utilisateur perdrait le tour, et toi la
main. La prise de port n'est jamais anodine, y compris au premier lancement.

Dans ce cas, procède ainsi :

- édite le sidecar et vérifie-le par `bun test` dans `sidecar/`, qui n'a besoin
  d'aucun sidecar vivant ;
- signale dans le bloc TODO que le changement backend exige un redémarrage pour
  être actif, en donnant la commande.

`dev:sidecar` te revient en revanche pleinement hors conversation Pupitre — dans
un terminal, où rien ne diffuse.

## Fin de tâche et Git

- À la fin de toute tâche qui modifie le dépôt, vérifie les changements et les tests pertinents, puis crée un commit descriptif avant de rendre la main.
- Pousse le commit seulement si l’utilisateur l’a demandé explicitement ou si la tâche prévoit une publication.
- Ne mélange pas de changements hors périmètre dans un commit sans confirmation explicite.

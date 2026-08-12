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
un terminal, où rien ne diffuse. Pour savoir où tu es, remonte l'arbre des
processus depuis ton shell : un ancêtre `target/debug/app` ou le sidecar
lui-même signifie que tu réponds depuis Pupitre.

Le binaire Tauri supervise le sidecar et le relance quand il meurt, **sauf s'il
sort avec le code 0**, qui signifie « évincé par une instance plus récente ».
Un `kill` manuel produisait autrefois ce code : l'app restait alors sans backend
sans rien dire. Le sidecar sort désormais 143 sur un signal reçu, donc tuer le
process suffit à le recharger depuis les sources — c'est le redémarrage le plus
sûr, il ne prend jamais le port.

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

# Le multi-branches vit dans la conversation, pas dans des projets jumeaux

Status: accepted — implémenté le 2026-08-12, conséquences revues le 2026-11-20

Pour travailler plusieurs branches d'un même dépôt en parallèle (workflow « un ticket = une branche »), l'isolation est portée par la conversation : une conversation peut naître sur une branche, Pupitre crée alors un worktree git dédié à cette branche (`git worktree add` dans un dossier géré par Pupitre), partagé par toutes les conversations de la branche, et tous leurs agents y travaillent. Le projet reste indivisible — un dépôt = un projet, un nom, une icône ; la conversation affiche sa branche et son travail dans la carte de travail du fil au lieu de dupliquer le projet.

## Considered Options

- **Worktree-comme-projet** (rejeté) : enregistrer chaque worktree comme un projet Pupitre séparé était presque gratuit techniquement (`projects.path` accepte n'importe quel chemin), mais produit des projets jumeaux portant le même nom — contraire à l'invariant « un projet = une identité unique ».
- **Statu quo** (rejeté) : un seul checkout partagé par toutes les conversations d'un projet ; les modifications non commitées de conversations concurrentes se contaminent, et un agent qui change de branche casse les autres conversations.

## Consequences

- `conversations` porte un `worktree_path` nullable ; null = dossier principal du projet, donc le workflow mono-branche (tout sur master) ne change pas.
- Tout spawn (tours, sous-tâches, reviews, tests) résout son cwd via la conversation, plus directement via `projects.path`.
- Les reviews et `commit_links` sont naturellement scopés au worktree de leur conversation.
- Pupitre crée ses worktrees à la demande mais n'en propose pas la suppression : ils pèsent quelques Mo, restent attachés à leurs conversations, et `removeWorktree` refuse ceux qu'une conversation vivante occupe. Le ménage des worktrees d'application (`apps/<app>-<tâche>` d'affilae-mono) relève d'`ae` et du skill ticket-stack.

# Le multi-branches vit dans la conversation, pas dans des projets jumeaux

Status: accepted — implémenté le 2026-08-12

Pour travailler plusieurs branches d'un même dépôt en parallèle (workflow « un ticket = une branche »), l'isolation est portée par la conversation : une conversation peut naître sur une branche, Pupitre crée et gère alors un worktree git dédié (`git worktree add` dans un dossier géré par Pupitre), et tous les agents de cette conversation y travaillent. Le projet reste indivisible — un dépôt = un projet, un nom, une icône ; l'atelier Git gagne un sélecteur de worktree au lieu de se dupliquer.

## Considered Options

- **Worktree-comme-projet** (rejeté) : enregistrer chaque worktree comme un projet Pupitre séparé était presque gratuit techniquement (`projects.path` accepte n'importe quel chemin), mais produit des projets jumeaux portant le même nom — contraire à l'invariant « un projet = une identité unique ».
- **Statu quo** (rejeté) : un seul checkout partagé par toutes les conversations d'un projet ; les modifications non commitées de conversations concurrentes se contaminent, et un agent qui change de branche casse les autres conversations.

## Consequences

- `conversations` porte un `worktree_path` nullable ; null = dossier principal du projet, donc le workflow mono-branche (tout sur master) ne change pas.
- Tout spawn (tours, sous-tâches, reviews, tests) résout son cwd via la conversation, plus directement via `projects.path`.
- Les reviews et `commit_links` sont naturellement scopés au worktree de leur conversation.
- Pupitre possède le cycle de vie des worktrees qu'il crée (création à la demande, proposition de suppression après merge) ; les worktrees créés à la main restent utilisables via le même sélecteur.

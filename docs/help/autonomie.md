# Autonomie

L'autonomie décide de ce qu'un CLI a le droit de faire pendant un tour, sans
jamais toucher à votre prompt. Le menu `⚙` de la réglette du composer la règle
pour la conversation ; le bouton `⚙` d'un projet règle son défaut.

Les tours partent en **headless** : aucun CLI ne peut afficher de demande de
permission. Un outil qui en réclamerait une est donc refusé, pas mis en attente.
C'est ce qui sépare les deux premiers rangs des trois suivants.

| Rang | Ce que le modèle peut faire |
| --- | --- |
| Plan / lecture seule | Lit le code et propose. N'écrit rien. Codex passe en sandbox lecture seule. |
| Par défaut du provider | Le mode natif du CLI. En headless, tout ce qui demanderait une permission est refusé : le tour lit et répond, sans agir. |
| Éditions acceptées | Les écritures de fichiers passent d'office. Les commandes shell restent refusées. |
| Autonome | Édite et exécute sans demander, dans le périmètre du projet et les racines IA. |
| YOLO · sans permissions | Plus aucun garde-fou : `--dangerously-skip-permissions` côté Claude, sandbox `danger-full-access` côté Codex, `--always-approve` côté Grok. Le périmètre filesystem lui-même tombe. |

**Hériter du projet** ne choisit rien : la conversation suit le réglage du
projet, et le menu affiche lequel. Changer le défaut du projet déplace toutes
les conversations qui héritent.

Le périmètre filesystem est un réglage à part, décrit dans
[Presets](#help/presets) : l'autonomie dit *si* le modèle agit, le périmètre dit
*où*.

## Sous-agents

Pupitre ne délègue plus de travail à un second modèle pour vous. Les CLIs ont
leurs propres sous-agents : demandez-les dans le prompt, ils s'exécutent avec
les outils natifs du provider. Gardien, lui, continue de lancer ses corrections
dans des tours séparés, qui apparaissent comme des cartes dans le fil.

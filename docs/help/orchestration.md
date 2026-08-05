# Orchestration

L'orchestration donne au modèle principal un outil **Conductor** pour déléguer
des recherches ou implémentations à Claude ou Codex. Les sous-tâches tournent en
parallèle, dans le projet parent, et apparaissent comme des cartes dans le fil.

La limite est de quatre sous-tâches simultanées par conversation. Une sous-tâche
ne reçoit jamais elle-même Conductor : la récursion et les sous-sous-tâches sont
structurellement impossibles. Désactivez l'orchestration sur une conversation
qui n'a pas besoin de déléguer pour réduire les moyens exposés au modèle.

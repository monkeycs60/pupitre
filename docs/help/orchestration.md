# Orchestration

L'orchestration donne au modèle principal un outil **Conductor** pour déléguer
des recherches ou implémentations à Claude, Codex ou Grok. Les sous-tâches tournent en
parallèle, dans le projet parent, et apparaissent comme des cartes dans le fil.

La limite est de quatre sous-tâches simultanées par conversation. Une sous-tâche
ne reçoit jamais elle-même Conductor : la récursion et les sous-sous-tâches sont
structurellement impossibles. Désactivez l'orchestration sur une conversation
qui n'a pas besoin de déléguer pour réduire les moyens exposés au modèle.

Par défaut, le modèle principal choisit le provider, le modèle et l'effort de
chaque sous-tâche. Dans la configuration de la nouvelle conversation, vous
pouvez aussi imposer un preset aux sub-agents. Le preset verrouille alors son
provider, son modèle et sa vitesse ; son effort est repris par défaut. Un effort
explicite peut le remplacer, ou rester libre quand aucun verrou n'est défini.

Ce réglage ne réécrit pas le prompt utilisateur. Il agit sur le câblage et la
configuration d'exécution : l'orchestrateur reçoit les outils MCP `delegate` et
`delegate_parallel`, puis le sidecar applique le verrou au moment de créer la
sous-tâche. Les sub-agents ne reçoivent pas Conductor à leur tour.

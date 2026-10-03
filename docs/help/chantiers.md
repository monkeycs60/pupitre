# Chantiers

Un chantier regroupe les conversations d’un thème qui a un début et une fin. Un ticket externe garde la priorité.

Une branche hors tronc devient un chantier. Sur le tronc, le classement suit le premier tour : une proposition de nouveau thème doit être partagée par deux conversations. Une confiance intermédiaire affiche « à confirmer ». Un déplacement manuel verrouille le rangement.

L’onglet Chantiers permet de créer, renommer, décrire, fermer, rouvrir et fusionner. La fusion conserve conversations, notes, consignes et backlog. Reprendre ouvre une conversation liée. La fermeture automatique intervient après cinq jours sans activité ; ce délai se règle dans Réglages → Fermeture des chantiers inactifs.

Les paramètres du projet permettent de désactiver le classement automatique. Les commandes de lancement se configurent au même endroit ; le bouton ▶ les exécute sans consommer de quota.

Le backlog propose les suites récoltées dans les résumés, les handoffs et les conversations inactives. Elles restent en attente jusqu’à une action : lancer, mettre en file ou écarter. Un commit peut donner le badge « probablement fait » sans supprimer la tâche.

« Où j’en suis » synthétise jusqu’à trois chantiers, leurs prochaines tâches, l’état Git et les environnements déclarés. La carte apparaît après trois jours d’inactivité, se replie avec son bouton et réutilise une synthèse tant que les données ne changent pas.

Les routines proposent cinq modèles. Une commande conserve sa sortie sans ouvrir de conversation ; ses champs JSON numériques alimentent un graphe de tendance. Santé du projet exige un checkout du tronc déjà disponible. Devlog du vendredi publie directement dans la bibliothèque ; Vérification de prod sonde les environnements configurés.

Les environnements personnels acceptent HTTP ou les hôtes de `~/.ssh/config` pour systemd et Docker. Les sondes SSH sont en lecture seule. Les incidents similaires sont regroupés et leur triage peut être rendu avec `report_incident_triage`. Une commande de lancement « Déployer » est proposée lorsque le commit déployé est en retard.

Le bot Telegram dédié se configure dans les paramètres d’un projet avec son jeton et le chat autorisé. Seule la stable le relève. Les photos sont jointes au backlog ; les vocaux ne sont pas pris en charge. « Lancer maintenant » met l’idée en file. Les appels automatiques sont comptés dans la vue Coûts et plafonnés par usage.

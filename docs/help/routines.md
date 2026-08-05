# Routines

Une routine lance automatiquement un workflow épinglé ou un prompt libre. Son
planning reste interne au sidecar Pupitre : aucun cron système n'est créé et
aucune tâche ne tourne lorsque le sidecar est arrêté.

## Créer une routine

Ouvrez **Routines** dans la navigation globale, puis **Nouvelle routine**.
Choisissez un projet et l'une des deux sources :

- un workflow, qui garde son skill, son prompt et sa configuration de modèle ;
- un prompt libre, associé à un preset.

Le planning utilise cinq champs cron : minute, heure, jour du mois, mois et jour
de la semaine. Les jokers, listes, plages et pas sont acceptés. Par exemple,
`0 9 * * 1-5` exécute la routine à 9 h du lundi au vendredi. Les heures suivent
le fuseau local de la machine.

## Exécutions et sorties

Chaque passage crée une conversation normale marquée comme issue de la routine.
L'historique affiche son état, sa durée, le total de tokens et un bouton
**Ouvrir** vers la sortie complète. **Lancer maintenant** rend la main sans
attendre la réponse du modèle ; l'historique se met à jour pendant le run.

Mettre une routine en pause retire son prochain passage sans effacer son
historique. Un lancement manuel reste possible et ne décale pas le planning.
Supprimer une routine supprime son historique de passages, mais pas les
conversations déjà produites.

## Notifications

Pupitre enregistre une notification à la fin de chaque routine, réussie ou non,
puis la transmet au système depuis la webview. La permission native n'est
demandée qu'à la première nouvelle notification.

Le même canal signale la fin des conversations interactives longues. Le seuil,
exprimé en secondes, se règle dans l'en-tête de la vue **Routines** (120 secondes
par défaut). Les runs de routine ne déclenchent pas cette seconde notification.

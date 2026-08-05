# Tester

Tester relit la conversation et les alertes Gardien liées aux tests, puis propose
des scopes concrets. Vous choisissez le scope avant toute exécution.

Le test tourne dans une sous-tâche dédiée. Commandes, sorties bornées,
screenshots et verdict restent dans le fil. Un succès acquitte uniquement les
alertes « absence de test » explicitement rattachées à ce scope.

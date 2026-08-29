# Missions de problématiques — spécification

## Objectif

Réduire la fragmentation produite par les captures de problématiques et permettre de lancer un travail cohérent sans ouvrir une conversation par axe.

## Décisions produit

- Luna regroupe dans une même problématique les sujets qui concourent au même résultat métier. Les sous-sujets deviennent des axes dans `plans`.
- Une problématique se lance toujours entièrement : tous ses axes sont injectés dans une seule conversation.
- Le tableau de bord permet de sélectionner plusieurs problématiques ouvertes et de les lancer ensemble dans une mission nommée.
- Le regroupement manuel est non destructif : les problématiques d'origine restent visibles, attribuables et fermables séparément.
- Une mission est terminée lorsque toutes ses problématiques sont fermées. La fermeture continue de reposer sur les marqueurs `[PB-XXXXXX]` dans les commits.
- Les captures historiques ne sont pas fusionnées rétroactivement. Elles peuvent être regroupées manuellement.

## Modèle durable

Une table `problem_missions` stocke la mission, son projet, son titre et sa conversation. Une table `problem_mission_items` relie la mission à une ou plusieurs problématiques. La mission est créée dans la même transaction que ses liens, juste après la création de la conversation.

Le statut de mission est calculé à partir des statuts des problématiques liées ; aucun second état mutable n'est persisté.

Une conversation issue d'une mission conserve l'origine `problem`. Pour une mission à une seule problématique, `origin_key` reste son ID public afin de préserver les usages existants. Pour plusieurs problématiques, `origin_key` contient l'ID de mission.

## Contrat de lancement

Le contrat de création d'une conversation accepte `problemIds: string[]` et `missionTitle`. Le serveur vérifie que toutes les problématiques existent, sont ouvertes et appartiennent au projet demandé.

Le préambule contient, pour chaque problématique :

- l'ID public et le titre ;
- le contexte et la résolution attendue ;
- tous les axes avec leur consigne ;
- la convention de commit correspondante.

Si toutes les problématiques partagent le même ticket, la conversation reprend ce ticket et sa branche connue. Si elles diffèrent, aucun ticket n'est forcé ; leur contexte reste présent dans le préambule.

## Interface

### Tableau de bord

- chaque problématique ouverte possède une case de sélection ;
- l'action principale d'une carte est unique : `Lancer tous les axes` ;
- à partir de deux éléments sélectionnés, une barre de regroupement affiche le nombre, un titre de mission modifiable et `Lancer ensemble` ;
- changer de filtre vide la sélection pour éviter une action invisible.

### À reprendre

Chaque ligne montre l'ID public, le titre complet, le ticket (clé et titre), la branche connue et le nombre d'axes. Une seule action `Lancer` ouvre une conversation contenant tous les axes.

## Luna

Le prompt demande explicitement :

- de regrouper les éléments ayant le même résultat métier, la même chaîne de mesure ou la même zone fonctionnelle ;
- de créer des axes distincts pour les étapes complémentaires ;
- de ne séparer en plusieurs problématiques que les résultats indépendants pouvant être livrés et validés séparément ;
- d'éviter les doublons de contexte, métriques ou dashboard.

Le format JSON reste compatible : une problématique contient toujours une liste `conversations`, désormais présentée à l'interface comme ses axes.

## Compatibilité

Les anciens champs `originKey` et `problemPlanIndex` restent acceptés côté serveur pendant la migration, mais la nouvelle interface n'envoie plus de plan isolé. Les données existantes restent lisibles sans migration destructive.

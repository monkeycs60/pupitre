# Reprendre la dernière conversation active au démarrage

## Contexte

Pupitre conserve actuellement le projet et la conversation sélectionnés dans
l'état React de la webview. Après fermeture puis relance de l'application, cet
état est perdu et l'utilisateur doit retrouver manuellement son fil.

## Objectif

À chaque relance de Pupitre, restaurer le dernier projet et la dernière
conversation ouverts. Si l'un d'eux n'est plus disponible, ouvrir un élément
actif de repli déterministe.

## Décision

Persister un snapshot de navigation dans le `localStorage` de la webview. Cet
état concerne uniquement la navigation locale de l'interface ; il ne nécessite
ni migration SQLite ni nouvelle route sidecar.

Clé : `pupitre.last-active-location`

Valeur :

```json
{
  "projectId": "...",
  "conversationId": "..."
}
```

`conversationId` peut être `null` lorsqu'un projet est ouvert sans
conversation sélectionnée.

## Comportement

### Écriture

- La sélection d'un projet met à jour `projectId` et efface
  `conversationId` lorsque le changement de projet ferme le fil courant.
- La sélection d'une conversation met à jour les deux identifiants.
- La création, la fermeture, l'archivage et la suppression d'une conversation
  mettent aussi à jour le snapshot pour ne pas conserver un fil invalide.
- Une erreur de lecture ou d'écriture du `localStorage` est ignorée ; elle ne
  doit pas empêcher l'utilisation de Pupitre.

### Restauration

1. Charger la liste des projets.
2. Retrouver le projet mémorisé.
3. S'il est absent, sélectionner le premier projet disponible.
4. Charger les conversations actives du projet retenu.
5. Restaurer la conversation mémorisée si elle existe dans cette liste.
6. Sinon, sélectionner la conversation active la plus récemment mise à jour.
7. S'il n'existe aucun projet ou aucune conversation active, conserver l'état
   vide correspondant à l'écran actuel.

Les conversations archivées et supprimées ne sont jamais restaurées, car la
restauration interroge uniquement le scope `active`.

## Limites de portée

- Aucun changement de schéma ou de données côté sidecar.
- Aucun mécanisme de synchronisation entre plusieurs profils ou machines.
- Aucun changement de comportement pour une première ouverture sans snapshot.
- L'état de la vue secondaire (Git, Fleet, Réglages, etc.) reste inchangé ; la
  relance revient dans l'espace Conversations avec le projet et le fil
  restaurés.

## Découpage technique

- Extraire la lecture, l'écriture et la résolution des replis dans un module
  UI pur afin de tester le comportement sans monter toute l'application React.
- Ajouter un effet d'initialisation dans `App.tsx` pour charger le snapshot et
  les données nécessaires avant de sélectionner le projet et la conversation.
- Ajouter un effet de persistance piloté par les identifiants sélectionnés.
- Réutiliser `listProjects` et `listProjectConversations` ; aucun nouvel appel
  réseau n'est nécessaire.

## Vérification

- Tests unitaires du module pur : snapshot absent ou invalide, projet mémorisé
  présent, projet absent, conversation mémorisée présente, conversation
  archivée/supprimée et liste vide.
- Vérifier `bun test` sur les tests UI ciblés.
- Vérifier `bunx tsc --noEmit` et `bun run build` dans `ui`.
- Vérifier le diff Git et créer un commit local ; ne pas pousser.

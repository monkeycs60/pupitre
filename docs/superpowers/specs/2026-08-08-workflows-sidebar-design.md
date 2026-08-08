# Workflows dans la sidebar — design

## Objectif

Remplacer l'action secondaire « + Workflow » de la liste de conversations par
un espace dédié dans la sidebar, accessible avec un onglet voisin de
« Conversations ».

## Portée

- La sidebar affiche deux onglets : Conversations et Workflows, avec leur
  compteur respectif.
- L'onglet Conversations conserve sa recherche, ses filtres et son action
  « Nouvelle conversation ».
- L'onglet Workflows affiche une action « Nouveau workflow », une recherche
  locale et la liste des workflows du projet courant.
- Chaque workflow expose son nom, un aperçu de sa consigne, son skill ou son
  preset et les actions Lancer et Modifier.
- « Lancer » crée la conversation via l'API existante puis l'ouvre dans la vue
  conversation. « Modifier » réutilise le formulaire existant.
- La sélection de l'onglet est locale à la sidebar et revient à Conversations
  au changement de projet.

## Hors portée

- Pas de nouvelle vue centrale ni de nouvelle route `WorkspaceView`.
- Pas de changement du modèle de données workflow ni de l'API de création.
- Pas de modification de la planification des routines.

## Architecture

`Sidebar` reste responsable du chargement des conversations et des workflows.
Un état `sidebarTab` choisit le panneau rendu. Le lancement appelle
`runWorkflow`, puis remonte la conversation créée par le callback déjà utilisé
pour sélectionner une conversation. `WorkflowDialog` reste le formulaire de
création et d'édition ; il reçoit un workflow ciblé lorsque l'utilisateur
choisit Modifier.

## Expérience et accessibilité

- Les deux boutons de tête forment un `tablist`, avec `role=tab`,
  `aria-selected` et des panneaux associés.
- Les libellés reprennent les captures : « Conversations », « Workflows »,
  « Nouvelle conversation », « Nouveau workflow », « Lancer ».
- La liste workflow privilégie la densité : une ligne d'action, un résumé
  tronqué et des métadonnées monospace ; aucun panneau décoratif supplémentaire.
- Les états vide, filtré et indisponible restent explicites.

## Validation

- Ajouter un test unitaire de la logique de filtrage/aperçu workflow extraite
  de la sidebar.
- Vérifier `npm run lint` et `npm run build` dans `ui/`.

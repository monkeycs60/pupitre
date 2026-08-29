# Plan d'implémentation — missions de problématiques

> Exécuter en TDD, sans pause de validation intermédiaire à la demande de l'utilisateur.

## 1. Regroupement Luna et métadonnées de reprise

**Fichiers :** `sidecar/src/problems.ts`, `sidecar/src/problems.test.ts`, `sidecar/src/stores/problems.ts`, `sidecar/src/problems-store.test.ts`, `sidecar/src/db.ts`.

1. Ajouter des tests rouges sur les consignes de regroupement du prompt et sur les métadonnées ticket/branche renvoyées avec une problématique.
2. Enrichir le prompt Luna sans changer le parseur JSON.
3. Ajouter les champs calculés `ticket_key`, `ticket_title`, `ticket_branch` au modèle `Problem` et à ses requêtes.
4. Vérifier les tests sidecar ciblés.

## 2. Mission persistée et lancement multi-problématiques

**Fichiers :** `sidecar/src/db.ts`, `sidecar/src/stores/problem-missions.ts`, `sidecar/src/stores/problem-missions.test.ts`, `sidecar/src/server.ts`, `sidecar/src/dashboard-routes.test.ts`.

1. Écrire les tests rouges du store de missions : création atomique, liens uniques, état dérivé.
2. Ajouter `problem_missions` et `problem_mission_items`, puis le store.
3. Écrire les tests rouges de création d'une conversation avec un ou plusieurs `problemIds` : validation projet/statut, préambule tous axes, ticket commun, mission persistée.
4. Implémenter le contrat HTTP et conserver la compatibilité du lancement historique par plan.
5. Compter les conversations via les liens de mission en plus de l'origine historique.
6. Vérifier les tests sidecar ciblés.

## 3. Lancement de tous les axes dans l'UI

**Fichiers :** `ui/src/types.ts`, `ui/src/api.ts`, `ui/src/conversationDraft.ts`, `ui/src/Composer.tsx`, `ui/src/Chat.tsx`, `ui/src/App.tsx`, tests associés.

1. Écrire les tests rouges du nouveau seed `{ problems, missionTitle }` et du contrat `problemIds`.
2. Propager les IDs et le titre de mission jusqu'à `POST /api/conversations`.
3. Préremplir le composeur avec une synthèse structurée de tous les axes et tous les marqueurs PB.
4. Garder les parcours Sentry et ticket inchangés.
5. Vérifier les tests UI ciblés.

## 4. Regroupement manuel au tableau de bord

**Fichiers :** `ui/src/ProblemsPanel.tsx`, `ui/src/ProblemsPanel.test.tsx`, `ui/src/styles/dashboard.css`.

1. Écrire les tests rouges : une action par carte, sélection multiple, titre modifiable, lancement groupé, réinitialisation au changement de filtre.
2. Implémenter la sélection locale et la barre dense de regroupement.
3. Respecter les composants et variables visuelles existants, sans effet décoratif supplémentaire.
4. Vérifier le test ciblé.

## 5. Vue « À reprendre » enrichie

**Fichiers :** `ui/src/ProblemSuggestions.tsx`, `ui/src/ProblemSuggestions.test.tsx`, `ui/src/styles/chat.css`.

1. Écrire le test rouge pour le titre non tronqué fonctionnellement, ticket, branche, nombre d'axes et bouton unique.
2. Implémenter la ligne contextuelle et le lancement complet.
3. Vérifier les tests ciblés.

## 6. Validation système et livraison

1. Exécuter `cd sidecar && bun test`.
2. Exécuter `cd ui && bun test` puis `bun run build`.
3. Recharger le sidecar supervisé uniquement si le contexte de processus le permet.
4. Vérifier `http://localhost:5173` dans Chromium : nombre de boutons, sélection groupée, titre de mission, vue « À reprendre ».
5. Produire une capture dans `~/Downloads/`.
6. Relire le diff et créer un commit descriptif, sans push.

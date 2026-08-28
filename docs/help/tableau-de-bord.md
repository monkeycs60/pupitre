# Tableau de bord

Le tableau de bord rassemble, projet par projet, ce qui était dispersé entre
ClickUp, GitLab et les conversations Pupitre. Chaque ligne représente un
**ticket** : sa source, sa branche, sa MR, son pipeline, son éventuel
déploiement, ses conversations liées et ses notes locales.

## D'où viennent les données

La tranche A relève **ClickUp** et **GitLab** côté sidecar, sans tour de modèle
ni consommation de quota IA. Quand Pupitre est actif, la relève revient
régulièrement et vous pouvez aussi cliquer sur **Rafraîchir** pour forcer une
mise à jour. Les changements sont ensuite poussés en temps réel dans la vue.

Pour GitLab, Pupitre réutilise d'abord le token de **`glab`** déjà connecté.
Sinon, définissez-en un dans **Paramètres globaux > Tokens d'intégration**.

## Configurer le projet

Ouvrez **Réglages du projet > Intégrations** pour :

- activer ClickUp et saisir l'équipe et les listes suivies ;
- activer GitLab, déclarer le ou les projets à suivre et leurs environnements ;
- ajuster le motif de branche qui extrait la clé de ticket.

Sans intégration configurée, le tableau reste vide jusqu'à ce qu'une
conversation démarre sur une branche reconnue.

## Démarrer et reprendre

**Démarrer** crée une conversation liée au ticket. **Reprendre** continue sur le
même ticket et réutilise la branche déjà repérée dans le tableau. Dans les deux
cas, Pupitre retrouve ou crée le **worktree partagé** de la branche, injecte un
brief de reprise court, puis laisse l'agent creuser une conversation soeur au
besoin avec `read_sibling_conversation`.

## Capturer des problématiques

Le bouton **Capturer** accepte un collage brut : bugs, retours, questions et
idées peuvent être mélangés. Collez le texte puis utilisez **Ctrl + Entrée**.
Pupitre conserve immédiatement le collage, l'envoie à Luna pour le structurer,
puis affiche le résultat dans l'onglet **Problématiques**. Une capture en échec
reste visible et peut être relancée avec **Réessayer**.

Chaque problématique contient son contexte, la résolution attendue et une à
cinq propositions de conversation. Vous pouvez rattacher un ticket ClickUp,
lancer une proposition, fermer, rouvrir ou supprimer la problématique. Les
éléments fermés sont disponibles avec le filtre **Fermées**.

Lancer une proposition ouvre le compositeur avec son titre, sa consigne et son
identifiant `[PB-XXXXXX]`. Le contexte complet est reconstruit par le sidecar :
le texte du compositeur reste modifiable sans perdre les informations de la
problématique.

## Retrouver le travail à lancer

L'écran **Nouvelle conversation** remonte au-dessus du compositeur jusqu'à cinq
problématiques ouvertes. Celles qui n'ont encore aucune conversation sont
prioritaires, puis les plus récentes. **Voir toutes** ouvre directement leur
onglet dans le tableau de bord.

Quand un commit résout une problématique, incluez exactement son identifiant
entre crochets, par exemple `[PB-7K3M9Q]`. Pupitre ferme alors la problématique
et mémorise le SHA, que le commit soit détecté dans une conversation ou lors du
rafraîchissement du changelog.

## Domaines

Un **domaine** est un label métier (Match AI, onboarding…) ou technique
(API, BackOffice…) du projet. Le digest de conversation peut en proposer un
ou deux, mais une proposition reste invisible dans la sidebar et la recherche
tant qu'elle n'est pas validée dans **Réglages du projet > Domaines**.

Depuis ces réglages vous pouvez valider, renommer, fusionner ou supprimer un
domaine. La fusion reporte les conversations vers le domaine cible. Un domaine
encore associé à une conversation ne se supprime pas : il faut d'abord
dissocier ou fusionner.

Les pastilles de la sidebar ne montrent que les domaines **actifs**. Le menu
⋯ d’une conversation permet d’en attacher ou d’en retirer, parmi ceux déjà
validés. Dans la palette Ctrl+K, les pastilles du projet courant filtrent la
recherche.

## Limites

Cette vue couvre **Mes tickets**, **Problématiques**, **Environnements**, **À relire**, les notes
locales, le groupement des conversations par ticket, l'inbox **Sentry** et les
**domaines**.

Le **backlog Notion** et les **Répétitions** arriveront ensuite. Le périmètre
visé est détaillé dans [le design validé](../plans/2026-08-19-tableau-de-bord-design.md).

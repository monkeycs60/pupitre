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

## Limites de la tranche A

Cette première tranche couvre **Mes tickets**, **Environnements**, **À relire**,
les notes locales et le groupement des conversations par ticket dans la
sidebar.

Les **domaines**, le **backlog Notion**, les **Répétitions** et l'intégration
**Sentry** ne sont pas encore livrés ici. Le périmètre visé pour les tranches
suivantes est détaillé dans [le design validé](../plans/2026-08-19-tableau-de-bord-design.md).

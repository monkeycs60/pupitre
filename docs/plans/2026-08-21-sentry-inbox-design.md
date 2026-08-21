# Inbox Sentry personnalisée — design validé

Date : 2026-08-21 · Statut : validé (brainstorm Clément × Codex) · Projet d’implémentation : Pupitre.

## 1. Intention et périmètre

Pupitre ajoute à son Tableau de bord projet une inbox Sentry actionnable. Elle lit les erreurs directement dans Sentry, identifie celles qui concernent les domaines de travail de l’utilisateur et transforme une issue confirmée en flux de résolution : scout, ticket ClickUp, worktree, branche, correction et proposition de MR.

La première configuration cible le projet Pupitre `affilae-mono` et trois projets Sentry : `hapigator`, `reactor` et `reactivator`. Pupitre contient toute l’implémentation ; le dépôt affilae-mono reste une source de contexte, de skills et de code pour les conversations lancées par Pupitre.

L’intégration est strictement granulaire par projet Pupitre. Chaque projet peut activer ou non Sentry, utiliser sa propre organisation, sa propre URL de base, ses propres projets Sentry, ses propres domaines et son propre token. Aucun token, catalogue métier ou snapshot n’est partagé implicitement entre deux projets Pupitre.

Décisions de périmètre :

- production uniquement ;
- toutes les issues restent visibles, avec un filtre `Mes domaines` ;
- scan automatique toutes les 15 minutes lorsque Pupitre est actif, toutes les 60 minutes en arrière-plan, et scan manuel ;
- Sentry reste strictement en lecture seule ;
- une issue classée comme bruit reste visible dans un filtre `Bruit` ;
- confirmation humaine obligatoire avant la création d’un ticket ClickUp et avant la création d’une MR.

## 2. Domaines et classement

### 2.1 Domaines permanents

Les domaines permanents initiaux sont :

1. Match AI au sens large ;
2. signup et onboarding liés à Match AI ;
3. wishlists ;
4. Instagram.

Brand Search n’est pas un domaine permanent. Une stack située dans un module de jonction entre les recommandations Match AI et Brand Search peut être classée Match AI si elle pointe directement sur ce flux. Une erreur Brand Search ordinaire ne doit pas être marquée comme liée à l’utilisateur.

### 2.2 Périmètre Match AI

Le skill affilae-mono `matching-system` est la source de périmètre de Match AI. Le classement couvre toute la chaîne documentée, notamment :

- analyse de site annonceur et de profil éditeur ;
- création et modification de programmes et d’affiliate profiles ;
- publisher signup et onboarding Reactor/Reactivator ;
- quality gate, analyse serveur et décisions de vectorisation ;
- embeddings, Atlas, synchronisation et statut actif ;
- recherche vectorielle, filtres, rerank, scoring et explication des matchs ;
- recommandations après création de profil ;
- migrations, backfills et crons Match AI ;
- intégration Instagram lorsqu’elle intervient dans l’analyse, la création ou l’enrichissement des profils.

Le catalogue initial inclut les endpoints explicitement documentés, dont `/publisher/profile-analysis`, `/matching/search`, `/matching/explain`, `/matching/entities`, `/advertiser/matching.findPublishers`, les créations/modifications/vectorisations de programmes et d’affiliate profiles, ainsi que les endpoints d’onboarding.

### 2.3 Extension temporaire par les tickets

Les sujets des tickets ClickUp ouverts assignés à l’utilisateur complètent temporairement ses domaines. Les titres, descriptions, clés, branches et chemins de code connus servent de signaux. Lorsque le ticket est fermé, ces signaux cessent d’alimenter `Mes domaines`, sans modifier l’historique des classements déjà enregistrés.

### 2.4 Moteur explicable

Le scan ne lance aucun modèle. Le classement croise déterministement :

- titre, transaction, endpoint, culprit et tags Sentry ;
- chemins des stack frames applicatives ;
- endpoints, chemins et concepts extraits du skill `matching-system` ;
- alias métier curatés pour Match AI, wishlists et Instagram ;
- signaux issus des tickets ClickUp ouverts.

Chaque résultat persiste ses raisons exactes, par exemple `Match AI · /matching/search · matching/search.js`. Le catalogue Match AI est régénéré lorsque le skill change. Un classement incertain reste seulement dans `Toutes` ; aucune heuristique faible ne doit l’ajouter silencieusement à `Mes domaines`.

## 3. Architecture

### 3.1 Intégration projet

Une intégration Sentry est ajoutée à `project_integrations`. Sa configuration contient l’organisation, l’URL de base si elle diffère de Sentry Cloud, la liste des projets Sentry, l’environnement `production` et la configuration des domaines de ce projet Pupitre.

Chaque intégration référence un secret Sentry propre au projet Pupitre. Le token est stocké dans le magasin de réglages/secrets de Pupitre sous une clé qualifiée par l’identifiant du projet, jamais en clair dans `project_integrations.config`. Il n’est présent ni dans les snapshots, ni dans les réponses HTTP publiques. Supprimer ou désactiver l’intégration d’un projet n’affecte aucun autre projet. Les droits demandés sont uniquement les scopes de lecture nécessaires aux organisations, projets, issues et événements.

### 3.2 Client et relève

Un client Sentry dédié effectue uniquement des requêtes GET avec le token de l’intégration courante. Le `IntegrationsRefresher` existant orchestre indépendamment chaque projet Pupitre, puis chaque projet Sentry configuré dans celui-ci. Pour affilae-mono, il orchestre `hapigator`, `reactor` et `reactivator` :

- toutes les 15 minutes quand la fenêtre est active ;
- toutes les 60 minutes en arrière-plan ;
- immédiatement via `Scanner maintenant` ;
- sans bloquer ClickUp ou GitLab si un projet Sentry échoue.

La relève liste les issues non résolues ayant eu une occurrence pendant les dernières 24 heures. Elle met à jour le snapshot local et diffuse l’événement temps réel du dashboard. Un `401/403` marque l’intégration `à reconfigurer` et suspend ses scans automatiques. Une panne transitoire conserve le dernier snapshot, son horodatage et le verdict des scouts.

Le détail complet et quelques événements récents ne sont chargés qu’à l’ouverture du panneau ou au lancement du scout. Cette séparation limite le trafic Sentry et le volume stocké.

### 3.3 Modèle de données

`sentry_issues` conserve au minimum : identifiant Sentry, projet Pupitre, projet Sentry, short ID, titre, transaction, culprit, statut, niveau, compteurs, utilisateurs touchés, première et dernière occurrence, release, environnement, URL externe, tags utiles, classement, raisons, état de cycle de vie, dates de première/dernière observation et date du dernier scan réussi.

`sentry_triages` conserve : issue, conversation scout, état du scout, verdict, synthèse, preuves, cause probable, stratégie proposée, ticket ClickUp éventuel, conversation de correction éventuelle et horodatages.

Une issue est dédupliquée par le couple `{project_integration_id, sentry_issue_id}`. Deux projets Pupitre connectés à la même organisation Sentry gardent ainsi des snapshots, classements et triages indépendants. Une relève met à jour son activité sans écraser un verdict existant. Si une issue marquée `bruit` connaît une hausse ou une nouvelle occurrence après le verdict, elle est signalée comme ayant évolué ; son verdict n’est jamais remplacé automatiquement.

### 3.4 Données sensibles

Emails, adresses IP, tokens, cookies et autres données personnelles sont expurgés avant stockage durable et avant injection dans une conversation. L’UI n’affiche pas de stack brute par défaut. Le scout reçoit un contexte borné : métadonnées utiles, événements représentatifs et frames applicatives nettoyées.

## 4. Interface

Le Tableau de bord du projet gagne un onglet `Sentry`, au même niveau que les vues tickets et environnements. Il contient :

- filtres `Toutes`, `Mes domaines` et `Bruit` ;
- projet source (`hapigator`, `reactor`, `reactivator`) ;
- état `Nouvelle`, `Active`, `Calme` ou `Résolue côté Sentry` ;
- titre, transaction, dernière occurrence, fréquence et utilisateurs touchés ;
- badge de domaine et raisons principales ;
- date du dernier scan réussi et bouton `Scanner maintenant`.

Le clic sur une issue ouvre un panneau de détail sans lancer d’IA. Le panneau présente les métadonnées, quelques événements récents, les raisons du classement, un lien vers Sentry et le bouton `Lancer le scout`.

## 5. Scout et workflow de résolution

### 5.1 Scout

`Lancer le scout` crée une conversation Pupitre dédiée et liée à l’issue. Le prompt injecté demande d’établir si l’erreur est réelle, reproductible ou attendue, d’évaluer son impact et de dire si une correction raisonnable est identifiable.

Pupitre sélectionne explicitement les skills pertinents. Pour une issue Match AI, `matching-system` est toujours injecté. Le scout peut lire le code du projet et les conversations/tickets associés, mais ne modifie ni Sentry ni ClickUp.

Le verdict persistant est l’un de :

| Verdict | Résultat attendu |
| --- | --- |
| `real_fixable` | cause probable, impact, preuves, stratégie et bouton `Créer et corriger` |
| `real_investigate` | erreur réelle, informations ou vérifications encore nécessaires |
| `noise` | comportement attendu ou télémétrie non actionnable, avec justification |
| `uncertain` | données insuffisantes et prochaine vérification proposée |

Une seule conversation scout active est autorisée par issue. Une conversation terminée peut être reprise plutôt que dupliquée.

### 5.2 Création du ticket et correction

Le bouton `Créer et corriger` n’est disponible que pour `real_fixable` et demande une confirmation explicite. Après confirmation :

1. l’agent crée un ticket ClickUp avec le lien Sentry, l’application, l’impact, les preuves, la cause probable et la stratégie proposée ;
2. Pupitre récupère la clé `TECH-XXXXX` ;
3. il crée ou retrouve le worktree partagé et la branche `issue/TECH-XXXXX` ;
4. il lance une conversation de correction avec le contexte Sentry, le diagnostic du scout et le ticket ;
5. l’issue est rattachée au ticket dans le Tableau de bord.

La correction suit ensuite les pratiques du projet cible. Après code et vérifications, la création de la MR reste bloquée derrière une nouvelle confirmation explicite de l’utilisateur.

Pupitre ne résout, n’archive et n’assigne jamais l’issue dans Sentry.

## 6. Cycle de vie local

Le scan utilise une fenêtre d’activité Sentry de 24 heures. Pupitre conserve localement les issues et leurs triages pendant au moins 30 jours.

| État | Définition |
| --- | --- |
| `new` | issue jamais observée avant la relève courante |
| `active` | nouvelle occurrence depuis la relève précédente |
| `quiet` | conservée localement, sans occurrence dans la fenêtre de 24 h |
| `resolved_remote` | devenue résolue côté Sentry lors d’une synchronisation ultérieure |

Les verdicts, conversations et liens ClickUp survivent au passage vers `quiet` ou `resolved_remote`.

## 7. API Pupitre

Les routes exactes seront arrêtées dans le plan d’implémentation, mais les capacités nécessaires sont :

- lire l’inbox Sentry d’un projet avec filtres ;
- configurer et vérifier l’intégration Sentry de ce projet sans exposer son token ;
- déclencher un scan manuel avec déduplication des scans concurrents ;
- charger le détail nettoyé d’une issue ;
- lancer ou reprendre son scout ;
- persister et lire le verdict ;
- confirmer `Créer et corriger` ;
- diffuser les mises à jour de l’inbox via le canal temps réel du dashboard.

Les opérations longues réutilisent les verrous et états de conversation existants. Un redémarrage clôt proprement un scout interrompu sans perdre l’issue ni son historique.

## 8. Vérification

### Client et intégration

- pagination et fusion des trois projets Sentry ;
- environnement production uniquement ;
- respect de la fenêtre de 24 heures ;
- erreurs réseau, rate limit et `401/403` ;
- absence du token dans les logs, snapshots et réponses API.

### Classement

- endpoints et fichiers de création d’affiliate profile, signup/onboarding, analyse, quality gate, vectorisation, Atlas, recherche, scoring et crons Match AI ;
- wishlists et Instagram ;
- extension par un ticket ClickUp ouvert puis retrait après fermeture ;
- erreur Brand Search ordinaire absente de `Mes domaines` ;
- chemin de jonction Match AI/Brand Search reconnu uniquement si les autres signaux Match AI sont présents ;
- raisons de classement stables et explicables.

### Persistance et workflow

- déduplication des issues et scans concurrents ;
- verdict conservé après redémarrage et nouvelles occurrences ;
- évolution signalée sans réécriture d’un verdict `noise` ;
- scout unique par issue ;
- aucune création ClickUp sans confirmation ;
- création du worktree et de `issue/TECH-XXXXX` après le ticket ;
- contexte transmis à la conversation de correction ;
- aucune création de MR sans confirmation.

### Interface et régression

- filtres, compteurs, panneau de détail et scan manuel ;
- états dégradés et âge du dernier snapshot ;
- vérification visuelle et DOM dans l’application active ;
- suites complètes sidecar et UI, plus typecheck UI.

Le scénario d’acceptation principal utilise une issue `POST /matching/search` : elle apparaît dans `Toutes` et `Mes domaines`, explique son rattachement à `matching-system`, lance un scout, conserve son verdict et attend l’accord utilisateur avant le ticket puis avant la MR.

## 9. Hors périmètre

- notifications Slack ou ingestion depuis Slack ;
- mutations Sentry : resolve, archive, assignation ou commentaire ;
- scan des environnements testing/preprod ;
- classification IA durant la relève périodique ;
- Brand Search comme domaine permanent ;
- correction automatique ou MR automatique sans confirmation.

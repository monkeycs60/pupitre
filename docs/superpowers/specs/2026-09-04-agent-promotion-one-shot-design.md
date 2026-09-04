# Promotion one-shot supervisée par un agent

## Intention

Remplacer le lancement manuel de la promotion dans les paramètres de l'instance dev par une mission agentique persistante. Le bouton ouvre dans l'onglet Promotion une vraie conversation Pupitre configurée avec `gpt-5.6-luna` et l'effort `high`. Sa seule condition de réussite est que l'état courant du dépôt soit committé, promu et effectivement utilisable dans l'instance stable.

L'agent doit viser une exécution autonome en un seul lancement. Il ne sollicite l'utilisateur que si une décision produit ambiguë, une permission extérieure ou un blocage matériel ne peut pas être résolu techniquement. Une erreur de build, de test, de processus ou de démarrage n'est pas une raison de demander de l'aide : l'agent diagnostique, corrige, committe et retente.

## Contrat de réussite

Une mission est réussie uniquement si toutes ces conditions sont prouvées :

1. toutes les modifications présentes dans le dépôt Pupitre ont été intégrées à un ou plusieurs commits ;
2. les vérifications pertinentes passent ;
3. la version stable annonce le SHA final attendu ;
4. le frontend stable a réellement fini son amorçage avec ce même SHA ;
5. lorsqu'au moins un projet existe, l'interface stable a restauré un projet sélectionné ;
6. les processus stable et WebKit restent vivants pendant une courte période d'observation ;
7. la conversation publie un bilan final avec les preuves collectées.

Un rollback peut maintenir la stable disponible pendant une réparation, mais il ne termine jamais la mission avec succès. L'agent poursuit jusqu'à promouvoir une version corrigée. Il demande une intervention seulement lorsqu'aucune progression autonome sûre n'est possible.

## Architecture

### Mission de promotion

Le sidecar dev expose une ressource de mission dédiée, séparée du `PromotionRunner` déterministe :

- `GET /api/promotion/mission` retourne la mission active ou la dernière mission ;
- `POST /api/promotion/mission` crée et démarre une nouvelle mission lorsqu'aucune autre n'est active ;
- la réponse contient au minimum l'identifiant de conversation et l'état `running`, `waiting_user`, `succeeded` ou `failed` ;
- une seule mission peut être active à la fois.

La mission référence une conversation native persistée. Une origine de conversation `promotion` permet de la retrouver après un rechargement ou un redémarrage du sidecar dev. Une nouvelle mission crée une nouvelle conversation afin de conserver un historique intelligible.

### Conversation spécialisée

La conversation est créée dans le projet Pupitre, directement dans le dépôt principal, sans worktree isolé. Sa configuration est verrouillée côté serveur :

| Paramètre | Valeur |
|---|---|
| Fournisseur | Codex |
| Modèle | `gpt-5.6-luna` |
| Effort | `high` |
| Permission | accès nécessaire au dépôt et aux processus Pupitre |
| Orchestration | désactivée par défaut ; Luna réalise elle-même la mission |
| Répertoire | racine réelle du projet Pupitre |

Le prompt initial est construit côté serveur et n'est pas modifiable depuis l'UI. Il explicite l'autorisation de committer tout l'arbre courant, l'obligation de réparer les échecs techniques, l'interdiction d'annoncer un succès sans preuves et les garde-fous habituels du dépôt. Il demande à l'agent de privilégier `bun run promote`, de ne jamais tuer le sidecar dev qui porte sa conversation, de respecter la séparation des ports 4820/4821 et de conserver une stable exploitable pendant les réparations.

Les messages suivants de l'utilisateur utilisent l'API normale des conversations. Une question de l'agent place la mission en `waiting_user`; la réponse relance le même tour conversationnel et la mission repasse en `running`.

### Primitive déterministe

Le script `scripts/promote.ts` reste la primitive de bascule et de rollback. L'agent le pilote depuis le terminal et exploite ses événements JSON et ses codes de sortie. Il peut modifier le code du projet ou le script lui-même si le diagnostic le justifie, puis créer un nouveau commit et relancer la primitive.

La route historique `POST /api/promotion` reste disponible au moins pendant la migration et pour les tests techniques, mais elle n'est plus le parcours principal de l'interface.

### Preuve d'amorçage du frontend

Le seul endpoint `/api/health` ne prouve pas que la WebView stable rend l'application. Le frontend stable envoie donc au sidecar stable un signal d'amorçage après :

- le montage de l'application ;
- le chargement de la liste des projets ;
- la restauration de la sélection courante.

Le signal comprend le SHA frontend, l'instant du rendu, le nombre de projets et l'identifiant du projet sélectionné. Le sidecar l'expose dans un état de disponibilité consultable. Un signal d'un ancien processus ou d'un SHA différent est refusé comme preuve.

La promotion n'est validée que si le SHA du sidecar, le SHA du frontend et le SHA committé par l'agent concordent. Si des projets existent, `selectedProjectId` doit être non nul.

## Interface

Dans les paramètres de l'instance dev, la carte Instance devient un véritable onglet ou panneau Promotion. Avant le lancement, elle affiche le SHA dev, le SHA stable et le bouton **Confier la promotion à Luna**.

Après le clic, le panneau affiche la conversation native : historique des messages, événements d'outils, saisie et pièces jointes si le composant de chat les prend déjà en charge. Le statut métier reste visible au-dessus du chat : préparation, correction, promotion, vérification, décision requise ou réussite.

Le chat embarqué réutilise les composants et le flux d'événements existants, extraits au besoin du rendu principal afin d'éviter deux implémentations divergentes. Un lien permet également d'ouvrir la même conversation dans la vue Conversations. Quitter les paramètres ne stoppe jamais la mission.

Le bouton ne propose plus « autoriser un arbre modifié » : cet état est attendu et l'agent est explicitement chargé de le committer. Les commandes manuelles d'annulation et de bascule forcée quittent le parcours principal ; elles peuvent rester accessibles dans un volet technique secondaire si nécessaire au dépannage.

## Cycle de vie et reprise

1. L'utilisateur clique sur **Confier la promotion à Luna**.
2. Le sidecar dev résout le projet correspondant à sa propre racine et refuse de démarrer si cette racine n'est pas enregistrée comme projet.
3. Il crée la conversation verrouillée et lance immédiatement le prompt initial.
4. L'agent inspecte et committe l'état courant, vérifie, promeut puis observe la stable.
5. Si une étape échoue, il corrige dans la même conversation et recommence.
6. Si une décision existentielle est nécessaire, la conversation reste ouverte en attente de la réponse utilisateur.
7. Après preuve complète, l'agent produit le bilan final et la mission passe à `succeeded`.

Après un redémarrage du sidecar dev, la mission est reconstruite depuis la conversation et l'activité des tours. Si aucun tour n'est actif et que le dernier message vient de l'utilisateur, le serveur peut relancer la conversation. Si le dernier message vient de l'agent avec une question, la mission reste `waiting_user`.

## Garde-fous

- Le lancement est impossible depuis l'instance stable.
- Deux missions de promotion ne peuvent pas s'exécuter simultanément.
- L'agent ne change pas de branche et ne crée pas de worktree.
- Il peut committer tous les fichiers suivis ou non suivis du dépôt courant, conformément à l'autorisation explicite de l'utilisateur.
- Il ne pousse aucun commit vers un dépôt distant : la promotion est locale sauf demande explicite ultérieure.
- Il ne supprime pas de données utilisateur et n'utilise pas de commande Git destructive.
- Il ne déclare jamais la réussite sur la seule base d'un code de sortie ou du endpoint `/api/health`.
- Une indisponibilité du fournisseur IA laisse la stable actuelle intacte et la mission reprenable ; elle ne déclenche pas une promotion manuelle implicite.

## Tests et validation

### Sidecar

- création atomique d'une seule mission ;
- configuration Luna/high et prompt serveur non substituable ;
- association persistante avec la conversation ;
- reprise après redémarrage ;
- transitions `running`, `waiting_user` et `succeeded` ;
- refus sur la stable ;
- validation du signal frontend par SHA et fraîcheur ;
- non-régression du `PromotionRunner` et de son rollback.

### UI

- lancement depuis un dépôt propre ou modifié sans case d'autorisation ;
- affichage et reprise de la conversation intégrée ;
- envoi d'une réponse lorsque l'agent demande une décision ;
- statut et preuve finale accessibles ;
- prévention d'une deuxième mission active ;
- navigation vers la conversation standard sans perte d'état.

### Vérification réelle

Les suites `sidecar` et `ui`, les vérifications de types et les tests de promotion sont exécutés. La fonctionnalité est ensuite testée depuis `http://localhost:5173` en déclenchant une mission réelle. La stable doit afficher le SHA produit, rendre son interface et restaurer un projet. Une capture de la stable et le bilan de la conversation servent de preuve finale.

## Hors périmètre

- promotion distante ou déploiement cloud ;
- push automatique des commits ;
- sélection libre du modèle de l'agent ;
- plusieurs missions parallèles ;
- garantie qu'une panne matérielle ou une indisponibilité durable du fournisseur puisse être résolue sans intervention humaine.

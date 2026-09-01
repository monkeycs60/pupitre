# Refonte produit Pupitre — spécification one shot

## Objectif

Traiter en une livraison cohérente les recommandations et anomalies de l’audit produit du 1er septembre 2026. Le cycle de vie durable des problématiques et de leurs axes devient le fil directeur reliant le Tableau de bord, les conversations, l’Inbox, Fleet et les notifications.

La livraison comprend également une directive `@sidequest` qui lance une conversation indépendante sur la même branche et le même worktree que la conversation source.

## Périmètre

La livraison couvre :

- le cycle de vie des axes, problématiques et missions ;
- une Inbox persistante et typée ;
- la séparation nette entre Inbox et Fleet ;
- la fiabilisation des signaux changelog, Sentry et notifications ;
- la réorganisation du Tableau de bord autour des tickets ;
- le regroupement du rail par usages ;
- la clarification des presets et du vocabulaire Pupitre ;
- les quick wins et incohérences recensés par l’audit ;
- la directive `@sidequest` et ses liens de provenance.

## Hors périmètre strict

- Aucun changement au comportement, au défaut, au nom ou à l’interface de YOLO et des modes d’autonomie.
- Aucun changement aux niveaux, paliers, mesures ou écrans de gamification et de Progression.
- Pas de remplacement général de l’architecture actuelle par un journal événementiel complet.
- Pas de migration destructive ni de suppression de données utilisateur.

Les sidequests héritent de la configuration d’autonomie existante comme toute nouvelle conversation, sans introduire de nouvelle règle dans ce domaine.

## Principes d’architecture

Le sidecar porte les états durables et les règles métier. L’interface ne déduit plus le besoin d’attention depuis un historique local ni depuis la seule présence d’une conversation.

La mise en œuvre suit quatre couches :

1. états durables des exécutions d’axes et provenance des sidequests ;
2. projections calculées des problématiques et missions ;
3. items d’attention persistants et régénérables ;
4. surfaces consommatrices : Problématiques, nouvelle conversation, Inbox, Fleet, Tableau de bord et notifications.

Les changements sont développés par lots vérifiables, mais remis ensemble après validation de l’ensemble. Les migrations restent additives et rétrocompatibles.

## Cycle de vie des problématiques

### Exécution d’un axe

Chaque lancement d’axe crée une exécution durable reliée à :

- la problématique et l’index stable de l’axe ;
- la mission éventuelle ;
- la conversation ;
- le tour qui réalise le travail, dès que celui-ci est connu.

Une exécution possède l’un des états suivants :

| État | Signification | Origine habituelle |
|---|---|---|
| `pending` | L’axe n’a pas encore été lancé | État initial |
| `running` | Le tour associé est actif | Événement de démarrage |
| `interrupted` | L’utilisateur a volontairement arrêté le tour | Annulation utilisateur |
| `failed` | Le tour s’est arrêté sur une erreur technique | Événement d’erreur |
| `awaiting_validation` | Le tour s’est terminé correctement, sans preuve suffisante de résolution | Fin normale du tour |
| `completed` | Le résultat a été validé ou livré | Validation humaine ou commit marqué |
| `abandoned` | L’axe ne sera pas poursuivi | Action humaine explicite |

Les transitions automatiques sont idempotentes. Un événement ancien ou répété ne peut pas faire régresser un état final `completed` ou `abandoned`.

### Validation et commits

La fin normale d’un tour place l’axe dans `awaiting_validation`, car une réponse réussie ne prouve pas que le résultat métier est atteint.

L’utilisateur peut valider manuellement un axe. Un commit contenant `[PB-XXXXXX]` termine tous les axes non abandonnés encore actifs ou à valider de la problématique correspondante. Cette règle préserve l’automatisme existant tout en autorisant les axes d’analyse, de documentation ou de décision sans commit.

### État calculé d’une problématique

Le statut `open` ou `closed` existant reste compatible avec les intégrations actuelles, mais l’API expose aussi un état de progression calculé :

| État présenté | Règle prioritaire |
|---|---|
| Terminée | Tous les axes sont `completed` ou `abandoned`, avec au moins un axe `completed` |
| À valider | Au moins un axe est `awaiting_validation` et aucun n’est `running` |
| En cours | Au moins un axe est `running` |
| En échec | Au moins un axe est `failed`, sans axe `running` ni `awaiting_validation` |
| Interrompue | Au moins un axe est `interrupted`, sans état de priorité supérieure |
| Ouverte | Aucun axe n’a commencé ou des axes `pending` restent seuls actifs |
| Abandonnée | Tous les axes sont `abandoned` |

Une problématique passe à `closed` lorsque tous ses axes sont finaux. Une fermeture manuelle existante reste possible et termine ou abandonne explicitement les axes restants selon le choix présenté à l’utilisateur.

### État calculé d’une mission

Une mission agrège les exécutions d’axes réellement sélectionnées lors de son lancement, et non toutes les problématiques liées de manière indistincte. Elle utilise les mêmes priorités d’état que la problématique.

Le statut ne dépend plus uniquement de la fermeture globale des problématiques. Une mission peut donc être terminée tandis qu’une problématique conserve d’autres axes à lancer.

### Interface des problématiques

Chaque axe affiche son état, sa conversation associée et une action adaptée :

- `Lancer` pour un axe en attente ;
- `Ouvrir` pour un axe en cours ;
- `Reprendre` pour un axe interrompu ;
- `Relancer` pour un axe en échec ;
- `Valider` ou `Reprendre` pour un axe à valider ;
- aucune action principale pour un axe terminé ou abandonné, avec historique accessible.

La carte de problématique résume la progression réelle. La zone « À reprendre » d’une nouvelle conversation ne montre que les axes interrompus, en échec ou à valider, regroupés par problématique. Elle ne propose plus une problématique simplement parce qu’une ancienne conversation existe.

Une annulation volontaire est présentée en gris comme `Tour interrompu`. Le rouge reste réservé aux échecs.

## Inbox persistante

### Modèle

Une table sidecar `attention_items` contient des items typés avec :

- un type, un projet et une clé de source stable ;
- un niveau de sévérité ;
- un titre et un résumé ;
- une cible de navigation structurée ;
- une version de condition ;
- les dates de création, mise à jour et acquittement ;
- les métadonnées minimales propres au type.

La paire type/clé de source est unique. Les producteurs font des upserts idempotents. L’acquittement masque la version courante d’un signal. Si sa condition change ou se reproduit, une nouvelle version le fait réapparaître.

La disparition de la condition résout automatiquement l’item. Les items peuvent être reconstruits depuis leurs sources durables ; ils ne constituent pas l’unique stockage d’un état métier.

### Types initiaux

- axe interrompu, en échec ou à valider ;
- tour en erreur ;
- tour terminé avec bloc TODO non coché ;
- signalement Gardien rouge encore ouvert ;
- routine échouée ;
- pipeline rouge sur une merge request pertinente ;
- nouvelle issue Sentry pertinente dans les domaines du projet.

Chaque item propose `Ouvrir` et `Traité`. La cible peut viser une conversation, un message, un axe, un ticket ou un onglet de Tableau de bord.

### Notifications

Les notifications natives sont une sortie de l’Inbox, pas un second registre. Leur clic ouvre la cible exacte et amène Pupitre au premier plan quand l’environnement le permet. La lecture ou l’acquittement est partagé avec l’Inbox.

Les alertes de quota existantes conservent leur fonctionnement propre afin de ne pas mélanger ce chantier avec Progression.

## Fleet

Fleet redevient la surface des exécutions :

- `Actifs` présente les tours et sous-tâches en cours ;
- `Historique` présente un nombre limité d’exécutions récentes.

L’onglet local `À traiter`, le drapeau `needsAttention: true` inconditionnel et le texte générique sur l’absence de résultat final disparaissent. Les situations exigeant une action apparaissent dans l’Inbox à partir des données sidecar.

L’ancien historique local n’est pas supprimé de force. Il est simplement ignoré par le nouveau rendu et peut être nettoyé ultérieurement sans incidence métier.

## Fiabilité des signaux

### Changelog

- Dédupliquer les entrées par `(project_id, commit_sha)`.
- Exclure les worktrees Git de la découverte des dépôts racines d’un projet.
- Ne déclencher l’enrichissement Luna qu’une fois par commit de projet.
- Préserver le chemin du dépôt canonique comme information, pas comme composante d’identité.

### Sentry

Une liaison entre issue et ticket requiert un identifiant explicite ou au moins deux signaux indépendants. Un mot commun de quatre lettres ne suffit plus.

Le filtre « Mes domaines » utilise la pertinence calculée, pas la simple présence d’un ticket lié. Une intégration repasse à l’état sain après un scan réussi. En cas d’échec, l’interface précise l’appel concerné, le moment du dernier succès et l’action de configuration possible. Le message technique brut reste accessible au survol ou dans le détail.

### Notifications et routage

Les cibles utilisent une structure de navigation commune. Les résultats de recherche honorent leur `sourceId` et se positionnent sur le message concerné. Le hash d’aide est nettoyé en quittant l’Aide et correctement interprété au chargement lorsqu’il est présent.

## Tableau de bord centré ticket

Le Tableau de bord s’ouvre sur `Mes tickets`.

Les informations Sentry, changelog et environnement pertinentes deviennent des attributs ou badges de la ligne ticket. Un onglet `Flux` rassemble leur chronologie détaillée. Les Problématiques restent une surface dédiée, car leur cycle de vie ne se réduit pas à un ticket.

L’en-tête conserve `Capturer`. L’actualisation et son état sont réunis dans un seul contrôle. Le menu Changelog redondant disparaît. L’état d’intégration devient compact et détaillable ; il n’occupe plus toute la largeur de tous les onglets.

## Navigation et langage

Le rail présente quatre groupes :

| Groupe | Entrées |
|---|---|
| Travail | Conversations, Tableau de bord |
| Supervision | Inbox, Fleet |
| Bibliothèque | Skills, Documents, Mémoire, Routines |
| Système | Coûts et quotas, Progression, Réglages, Aide |

Progression reste une entrée autonome et son contenu demeure inchangé. Cette décision remplace la fusion `Consommation` proposée dans l’audit afin de respecter l’exclusion de la gamification.

Claude Design devient une action contextuelle quand Tauri le rend disponible. Le rail déplié ne masque plus le contenu et les libellés ne sont plus tronqués.

Les presets intégrés adoptent un nom par intention et un style de casse cohérent. Le modèle, le fournisseur et l’effort restent en sous-texte. Renommer un preset n’altère aucune valeur de modèle ou d’autonomie.

Un composant d’aide contextuelle explique les termes propres à Pupitre et ouvre la section d’aide correspondante. Les pages d’aide touchées par un chantier font partie de sa vérification.

## Directive `@sidequest`

### Sémantique

Une sidequest est une conversation normale et indépendante. Elle ne partage ni fil, ni fenêtre de contexte, ni cycle de vie avec la conversation source.

Elle partage exactement :

- le projet ;
- le worktree et son répertoire de travail ;
- la branche ;
- le ticket et les problématiques associés lorsqu’ils existent.

La suppression ou l’archivage d’une conversation ne supprime jamais l’autre. Leur lien sert uniquement à la provenance et à la navigation.

### Syntaxe

La forme minimale est :

```text
@sidequest Corrige la déduplication du changelog
```

Elle copie le modèle et les réglages compatibles de la conversation courante.

La forme paramétrée est :

```text
@sidequest(model="5.6-luna") Analyse les causes sans modifier le code
```

Le modèle est résolu contre le catalogue disponible avant la création. Les autres réglages compatibles restent hérités. Une valeur inconnue produit une erreur éditable et ne crée pas de conversation.

### Contexte transmis

La nouvelle conversation reçoit uniquement :

- la consigne qui suit la directive ;
- le dernier échange utilisateur-assistant complet précédant la directive ;
- le titre, le ticket et les problématiques liés ;
- la mention explicite du partage de branche et de worktree.

Elle ne reçoit pas une copie de l’historique complet.

### Provenance et interface

Une relation durable conserve la conversation source, l’événement source, la conversation créée et son libellé.

Le message source affiche une carte compacte avec l’état de la nouvelle conversation et `Ouvrir`. La sidequest affiche un lien discret `Lancée depuis…`. Elle reste listée et recherchable comme toute conversation.

La création et le lancement forment deux étapes récupérables. Si le lancement échoue après la création, la conversation reste visible avec `Relancer`. Deux conversations écrivant simultanément dans le même worktree ne sont pas bloquées ; Pupitre affiche une alerte de modifications concurrentes et les fichiers touchés lorsqu’ils sont connus.

## Quick wins inclus

La livraison corrige également :

- le bouton de pièces jointes affiché à zéro et les accords associés ;
- les popovers qui ne se ferment pas à Échap, au clic extérieur ou à l’ouverture d’un concurrent ;
- le placeholder `/` dans une conversation qui n’existe pas encore ;
- l’ancrage des résultats de recherche ;
- le hash d’aide persistant ;
- l’aide Gardien et les passages du README décrivant l’ancienne vue Code ;
- les doublons de skills, regroupés par nom avec leurs sources explicites ;
- le filtre projet des Documents, ouvert sur tous les projets avec le projet courant en premier ;
- le mois vide de Coûts, remplacé par le dernier mois avec usage ;
- le seuil de notification longue, déplacé vers Réglages ;
- l’aperçu des prochaines occurrences et le fuseau des Routines ;
- le menu Changelog redondant ;
- le délai et le placement du résumé de conversation ;
- les sections Actions et Aide de la palette de commandes.

Les fonctionnalités à moitié câblées ou le code mort relevés par l’audit ne sont supprimés que si leur retrait est nécessaire à ces changements et démontré sans consommateur. Le nettoyage sans rapport direct reste hors périmètre.

## Gestion des erreurs et concurrence

- Les transitions métier sont transactionnelles et idempotentes.
- Une liaison vers une conversation, un tour ou un ticket disparu reste affichable sous forme dégradée et peut être acquittée.
- Un producteur d’Inbox défaillant n’empêche pas les autres types d’items d’être lus.
- Les erreurs d’intégration conservent le dernier état sain et indiquent sa fraîcheur.
- Une migration interrompue peut être rejouée sans perte de données.
- Une sidequest partiellement créée reste récupérable depuis la sidebar.
- Le partage de worktree est explicite ; Pupitre avertit des écritures simultanées sans inventer de verrouillage que les outils sous-jacents ne garantissent pas.

## Compatibilité et migration

Les problèmes historiques sans exécution d’axe sont hydratés avec des axes `pending`, sauf lorsqu’un commit de fermeture existant permet de les marquer `completed`.

Les missions historiques restent accessibles. Leurs axes sont reconstruits depuis les indices sélectionnés lorsque cette information existe ; sinon tous les axes de leurs problématiques sont associés sans modifier les conversations.

Les contrats d’API existants restent acceptés pendant la migration. Les nouveaux champs sont ajoutés avant que l’interface ne commence à les exiger.

## Vérification

### Sidecar

- migrations sur base vide et base historique ;
- transitions automatiques et manuelles des axes ;
- protection des états finaux contre les événements tardifs ;
- agrégation des problématiques et missions ;
- fermeture par commit `[PB-XXXXXX]` ;
- génération, réapparition et résolution des items d’Inbox ;
- déduplication changelog et pertinence Sentry ;
- parsing, héritage de modèle, contexte et récupération des sidequests.

### Interface

- actions et états de chaque axe ;
- contenu exact de « À reprendre » ;
- Inbox, acquittement et deep links ;
- Fleet limité aux actifs et à l’historique ;
- Tableau de bord centré ticket et Flux ;
- rail regroupé sans recouvrement ;
- sidequest indépendante et navigation bidirectionnelle ;
- quick wins, clavier et accessibilité des popovers.

### Non-régression explicite

- aucune modification fonctionnelle de YOLO ou des modes d’autonomie ;
- aucune modification fonctionnelle de Progression, des niveaux ou des paliers ;
- conversations, tickets, problèmes et missions historiques toujours lisibles ;
- compatibilité des anciens contrats de lancement pendant la migration.

### Validation dans l’application

Le sidecar de développement utilise exclusivement le port 4821 et ses données séparées. Le front est vérifié sur `http://localhost:5173`.

Les vérifications dans le navigateur mesurent le DOM et cherchent les contradictions : nombre d’items, absence de doublons, état après annulation, disparition et réapparition d’un item acquitté, cible exacte d’un deep link, branche et worktree d’une sidequest. Une capture finale accompagne la livraison.

Les suites `cd sidecar && bun test` et `cd ui && bun test`, le build pertinent et l’inspection du diff précèdent le commit final d’implémentation.

## Critères d’acceptation

1. Une mission annulée n’apparaît plus comme une erreur ni comme un travail jamais commencé.
2. Chaque axe possède un état durable et une action cohérente dans toutes les surfaces.
3. Un tour terminé sans preuve de livraison attend une validation humaine.
4. Un commit marqué termine automatiquement les axes concernés.
5. Inbox et Fleet ne présentent plus les mêmes éléments ni le même objectif.
6. Les faux signaux changelog et Sentry décrits par l’audit ne sont plus reproductibles.
7. Les notifications et résultats de recherche ouvrent leur cible exacte.
8. Le Tableau de bord s’ouvre sur les tickets et expose un flux lisible.
9. Le rail est regroupé sans modifier la gamification.
10. `@sidequest` crée une conversation indépendante sur la même branche et le même worktree, avec le modèle demandé ou celui de la conversation source.
11. YOLO/autonomie et gamification restent fonctionnellement inchangés.
12. Toutes les corrections secondaires listées dans cette spécification sont couvertes par un test ou une vérification explicite.

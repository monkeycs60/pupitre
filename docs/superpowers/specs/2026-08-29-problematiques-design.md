# Problématiques : capture, résurgence et clôture automatique

**Date :** 29 août 2026  
**Statut :** validé pour planification

## Objectif

Pupitre devient le point de capture unique des observations de travail qui sont
aujourd'hui dispersées dans des notes et des conversations. Un collage brut est
sauvegardé immédiatement, puis un tour Luna invisible le découpe en problématiques
structurées, les rapproche des tickets ClickUp déjà synchronisés et prépare leur
résolution sous forme d'une ou plusieurs conversations.

La valeur principale n'est pas une nouvelle liste de tâches. Les problématiques
doivent resurgir lorsque l'utilisateur choisit son prochain travail, puis mourir
automatiquement lorsqu'un commit lié est détecté. ClickUp reste la source de vérité
des tickets ; Pupitre ne crée aucun ticket interne et n'écrit rien dans ClickUp.

## Périmètre

Le premier incrément couvre le cycle complet :

- capture native d'un texte brut dans un projet ;
- traitement asynchrone en une seule passe agentique ;
- consultation des tickets ClickUp présents dans la base locale ;
- création de problématiques distinctes et rattachement facultatif à un ticket ;
- consultation et actions depuis un onglet du tableau de bord ;
- résurgence dans l'écran de création de conversation ;
- lancement d'une ou plusieurs conversations pré-nourries ;
- fermeture automatique par ID dans un message de commit ;
- fermeture, réouverture, correction du ticket et suppression manuelles ;
- fonctionnement identique pour un projet dépourvu de ClickUp.

Sont hors périmètre : capture mobile, import depuis Keep, Tasks ou Slack, création
ou commentaire de tickets ClickUp, états de workflow supplémentaires, traitement
agentique en deux étapes et détection sémantique d'une résolution sans ID Git.

## Modèle de données

### Captures

Une capture persiste le texte avant de lancer le modèle. Elle contient un identifiant
interne, le projet, le texte brut, l'état technique `queued`, `processing`, `done` ou
`error`, le message d'erreur éventuel et les dates de création et de mise à jour.

Le texte est conservé après une réussite pour expliquer la provenance des
problématiques. Une capture en erreur est relançable sans nouvelle saisie. Au
démarrage, le service remet en file les captures `queued` et les captures restées
`processing` après un arrêt du sidecar.

### Problématiques

Chaque problématique contient :

- un ID public global de la forme `PB-XXXXXX`, en alphabet Crockford majuscule et
  protégé par une contrainte d'unicité ;
- le projet et la capture source ;
- un titre, un contexte structuré et la résolution attendue ;
- un plan de conversations ordonné, composé d'un titre et d'une consigne par
  conversation proposée ;
- un ticket local facultatif, issu de la synchronisation ClickUp ;
- un état persistant limité à `open` ou `closed` ;
- la date de fermeture et le SHA déclencheur lorsqu'elle vient de Git ;
- les dates de création et de mise à jour.

L'état « lancée » n'est pas persisté : il est déduit des conversations dont
`origin_type` vaut `problem` et dont `origin_key` contient l'ID public. Une
problématique peut donc alimenter plusieurs conversations sans introduire un
workflow supplémentaire.

La suppression manuelle est définitive et demande une confirmation dans
l'interface. Fermer et rouvrir sont réversibles. Une réouverture efface la date et
le SHA de fermeture, sans recréer une problématique supprimée.

## Traitement agentique

Le service de problématiques est une brique dédiée et invisible. Il réutilise le
générateur fournisseur déjà employé par le changelog, avec :

- provider `codex` ;
- modèle `gpt-5.6-luna` ;
- effort `medium` ;
- vitesse `fast` ;
- une invocation unique par capture.

Le prompt reçoit le nom du projet, le texte brut et un catalogue compact des tickets
ClickUp locaux du projet : identifiant local, clé, titre et statut. Pour un projet
sans ClickUp, ce catalogue est vide et le schéma de sortie reste identique.

La réponse attendue est un tableau JSON. Chaque entrée fournit le titre, le contexte,
la résolution attendue, la clé de ticket éventuelle et au moins une proposition de
conversation. Le parseur valide toute la réponse avant l'écriture : types, champs
obligatoires, longueurs et nombre d'éléments. Une clé de ticket n'est retenue que
si elle appartient au catalogue fourni ; une clé inconnue devient `null`. Une
sortie invalide ou une erreur fournisseur place la capture en `error` sans créer de
résultat partiel. Une relance manuelle effectue une nouvelle invocation complète.

Un verrou en mémoire empêche deux traitements simultanés de la même capture. Les
captures différentes peuvent rester séquentielles dans le premier incrément afin
de ne pas créer une concurrence de coût inutile.

## API et temps réel

Le sidecar expose les routes suivantes :

- `POST /api/projects/:projectId/problem-captures` crée une capture et retourne son
  état avec le statut HTTP `202` ;
- `GET /api/projects/:projectId/problems?status=open|closed|all` liste les captures
  non terminées ou en erreur et les problématiques demandées ;
- `POST /api/problem-captures/:id/retry` remet une capture en erreur dans la file ;
- `PUT /api/problems/:id/ticket` remplace ou retire le ticket local ;
- `POST /api/problems/:id/close` ferme manuellement ;
- `POST /api/problems/:id/reopen` rouvre ;
- `DELETE /api/problems/:id` supprime définitivement.

Les routes valident systématiquement l'appartenance du ticket et de la
problématique au projet concerné. Les écritures diffusent un nouveau snapshot par
le WebSocket du tableau de bord existant. Le snapshot du tableau de bord inclut les
captures non terminées ou en erreur et les problématiques du projet, afin d'éviter
un second flux temps réel.

La création de conversation étend `origin_type` avec la valeur `problem`, utilise
l'ID public comme `origin_key` et accepte `problemPlanIndex`, un entier positif ou
nul. Le sidecar résout lui-même la problématique, le ticket et la proposition
choisie ; il ne fait pas confiance à un contexte structuré renvoyé par le navigateur.

## Expérience de capture

Un bouton `Capturer` reste visible dans l'en-tête du tableau de bord. Il ouvre un
dialogue compact contenant un seul grand champ texte, un bouton `Ajouter`, le rappel
du raccourci et aucune métadonnée obligatoire.

Le chemin nominal comporte deux gestes : coller, puis `Ctrl + Entrée`. Une saisie
vide est refusée localement. Après la réponse HTTP, le dialogue se ferme, l'onglet
`Problématiques` devient actif et une ligne `Traitement en cours` apparaît sans
attendre Luna. Une erreur de traitement affiche le texte conservé, une explication
courte et l'action `Réessayer`.

## Onglet Problématiques

Le tableau de bord ajoute un cinquième onglet `Problématiques`. Il participe à la
même mémoire par projet et au même comportement clavier accessible que les quatre
onglets existants.

Les problématiques ouvertes sont affichées par défaut, les plus récentes en premier.
Chaque carte expose le titre, l'ID public, le ticket ClickUp éventuel, le contexte,
la résolution attendue et le plan de conversations. Les actions disponibles sont :

- lancer la conversation correspondant à une proposition ;
- changer ou retirer le ticket parmi ceux du projet ;
- fermer la problématique ;
- supprimer la problématique après confirmation.

Un filtre permet d'afficher les problématiques fermées. Elles indiquent le SHA ayant
provoqué la fermeture lorsqu'il existe et proposent `Rouvrir`. Les captures en cours
ou en erreur apparaissent dans le même onglet, avant les problématiques.

## Résurgence à la création d'une conversation

L'écran `Nouvelle conversation` affiche au-dessus du compositeur au maximum cinq
problématiques ouvertes, en donnant la priorité à celles qui n'ont encore lancé
aucune conversation puis aux plus récentes. Un lien `Voir toutes` ouvre directement
l'onglet `Problématiques` du tableau de bord.

Chaque proposition de conversation possède sa propre action. La sélectionner :

- rattache le ticket local éventuel à la future conversation ;
- positionne l'origine `problem` et l'ID public ;
- préremplit le compositeur avec le titre et la consigne proposée ;
- laisse l'utilisateur choisir son preset et envoyer normalement le premier tour.

Le préambule construit côté sidecar ajoute le contexte complet, la résolution
attendue et cette consigne : tout commit qui résout la problématique doit inclure
exactement `[PB-XXXXXX]` dans son message. L'ID reste visible dans le compositeur,
mais la sécurité du contexte ne dépend pas du texte éditable.

## Fermeture automatique par Git

La fermeture reconnaît uniquement la forme exacte `[PB-XXXXXX]`. Elle est limitée
aux problématiques du projet où le commit est observé. Un ID inconnu, mal formé,
fermé ou appartenant à un autre projet est ignoré sans erreur.

Deux chemins alimentent le même détecteur idempotent :

1. après un tour de conversation, les nouveaux commits tracés par
   `GitProjectService` sont inspectés immédiatement ;
2. après un rafraîchissement du changelog, les messages des commits importés sont
   inspectés afin de couvrir les commits réalisés hors d'une conversation Pupitre.

Une correspondance ferme directement la problématique et mémorise le SHA. Plusieurs
occurrences du même ID ou plusieurs scans du même commit ne produisent aucun effet
supplémentaire. Un commit peut fermer plusieurs problématiques s'il contient
plusieurs IDs exacts.

Le scanner doit examiner le message Git complet, pas seulement le sujet affiché par
le changelog. La représentation persistée du changelog peut continuer à montrer le
seul sujet si le corps n'a pas d'autre usage produit.

## Erreurs et limites

- Le texte brut est limité à 50 000 caractères côté API ; l'interface annonce la
  limite avant l'envoi.
- Une capture produit au maximum 20 problématiques. Un titre est limité à 120
  caractères, le contexte et la résolution à 4 000 caractères chacun.
- Une problématique contient entre une et cinq propositions. Chaque proposition
  limite son titre à 120 caractères et sa consigne à 4 000 caractères.
- Une clé ClickUp inventée ou issue d'un autre projet devient un rattachement nul ;
  elle n'empêche pas la création des autres champs validés.
- Les erreurs réseau, fournisseur ou JSON sont lisibles dans l'onglet et relançables.
- Aucun secret ClickUp ni contenu d'intégration brut n'est envoyé au modèle ; seul
  le catalogue local compact est fourni.

## Vérifications attendues

- persistance du collage avant l'appel fournisseur et reprise après redémarrage ;
- découpage multi-sujets et écriture atomique des problématiques ;
- rejet d'une réponse Luna partielle ou invalide sans résultats partiels ;
- rattachement ClickUp validé dans le projet et correction manuelle ;
- fonctionnement sans intégration ClickUp ;
- création d'une conversation par proposition avec contexte serveur et origine ;
- limitation de la résurgence à cinq problématiques correctement triées ;
- fermeture immédiate après un commit tracé et fermeture au scan du changelog ;
- exactitude du format `[PB-XXXXXX]`, isolation par projet et idempotence ;
- fermeture, réouverture, suppression et relance manuelles ;
- diffusion temps réel et mémoire du nouvel onglet ;
- parcours navigateur : capture en deux gestes, état en cours, résultat, lancement
  de conversation et actions de cycle de vie ;
- suites `sidecar` et `ui` complètes, build de production UI et vérification DOM
  dans l'application en cours d'exécution.

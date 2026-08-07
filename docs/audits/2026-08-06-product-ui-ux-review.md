# Audit produit, UI et UX de Pupitre

**Date :** 6 août 2026

**Version observée :** branche `codex/ui-quotas-and-presets`, commit `a3c164b`, avec les modifications locales présentes au moment de l’audit

**Environnement :** application web locale dans Chrome, sidecar sur `:4820`, interface sur `:5173`

**Fenêtres testées :** 1280 × 800 (taille Tauri par défaut) et 1024 × 720 (proche de la taille minimale)

## Résumé exécutif

Pupitre a déjà une vraie personnalité produit. Ce n’est pas un simple chat autour de deux CLI : la continuité des conversations, les quotas, le Gardien, Tester, les passations entre providers, les sous-agents et l’historique Git forment un ensemble cohérent pour piloter du travail de développement.

La principale faiblesse actuelle n’est pas un manque de fonctionnalités. C’est que l’interface expose trop tôt la mécanique interne de Pupitre et ne hiérarchise pas encore assez les tâches utilisateur. Au démarrage, l’utilisateur devrait surtout pouvoir dire ce qu’il veut accomplir, voir ce qui réclame son attention et garder le contrôle des actions risquées. Aujourd’hui, il rencontre d’abord des écrans vides, des réglages de modèle, des concepts maison et des outils rangés par technologie.

Les trois priorités sont donc :

1. **Rendre le niveau d’autonomie et les permissions visibles et contrôlables.** Le mode Codex observé demande `approvalPolicy: "never"` et auto-accepte les demandes d’approbation. Pour une application qui agit sur des dépôts, ce comportement doit être un choix explicite, visible et auditable.
2. **Faire du démarrage d’une tâche le parcours principal.** Le premier écran et la nouvelle conversation doivent privilégier le prompt, avec une configuration compacte et des détails avancés à la demande.
3. **Faire de Pupitre un poste de pilotage quotidien, pas seulement un ensemble de vues.** Il manque une vue « À traiter », une gestion complète des conversations, la récupération des brouillons, des notifications persistantes et des résultats de recherche regroupés.

Le produit gagnera davantage en supprimant de la friction et en repliant la complexité qu’en ajoutant de nouvelles grandes features.

## Méthode et limites

L’audit combine :

- une exploration réelle dans Chrome des parcours Projet, Conversation, Nouvelle conversation, changement de modèle, Gardien, Git, Coûts, Fleet, Routines, Bibliothèque, Mémoire, Aide, recherche `Ctrl+K`, workflows et suggestions de skills ;
- une vérification aux dimensions de la fenêtre native ;
- un recoupement avec le code lorsque l’observation seule ne permettait pas de conclure ;
- une vérification de la console navigateur sur les parcours visités : aucune erreur ni alerte n’a été relevée.

Les actions susceptibles de consommer du quota ou de modifier le dépôt — lancer Tester, générer un Débrief, démarrer une review Gardien, exécuter un workflow — n’ont pas été déclenchées. Leurs écrans d’initialisation et leur implémentation ont été inspectés, mais pas leur résultat final en conditions réelles.

## Les besoins utilisateur à servir

Pupitre devrait optimiser cinq tâches principales :

1. **Démarrer ou reprendre un travail** sans devoir comprendre le routage des modèles.
2. **Savoir ce qui se passe** : progression, blocage, coût en quota, résultat et prochaine action.
3. **Garder le contrôle** sur les commandes, écritures, permissions et décisions à risque.
4. **Vérifier le travail produit** avec du diff, des tests et des preuves reliés au contexte.
5. **Retrouver et réutiliser** une conversation, une décision, un skill ou un workflow sans bruit.

Une bonne règle de conception pour la suite : chaque écran doit répondre immédiatement à trois questions — « où en suis-je ? », « qu’est-ce qui demande mon attention ? » et « quelle est l’action principale ? ».

## Ce qui fonctionne déjà bien

| Élément | Pourquoi il fonctionne | Décision |
| --- | --- | --- |
| Regroupement des appels shell consécutifs | Les séries de commandes sont contractées dans un seul bloc dépliable. Le fil reste lisible sans perdre la transparence. | **Conserver** et généraliser le principe aux autres événements techniques. |
| Rendu de conversation | La largeur de lecture, la distinction des rôles et les blocs repliables rendent un historique dense encore parcourable. | **Conserver**, puis ajouter des outils de navigation dans le fil. |
| Images et pièces jointes | Glisser-déposer, collage, ajout explicite, aperçu des images et lightbox couvrent désormais le besoin de base. | **Conserver**, puis enrichir les aperçus non image. |
| Changement de modèle | L’interface explique la ré-ingestion estimée et distingue clairement un changement interne d’une passation cross-provider. | **Conserver** : c’est un bon exemple de friction utile. |
| Gardien + Tester | Le produit relie review, décisions, scopes de test, preuves et acquittement des alertes. Cette boucle est différenciante et répond à un vrai risque du développement assisté. | **Conserver** et simplifier l’entrée dans le parcours. |
| Quotas | Le pourcentage Codex, les fenêtres et les resets sont visibles ; Claude n’affiche pas un pourcentage inventé quand la donnée manque. | **Conserver** cette honnêteté, améliorer seulement le libellé « utilisé / restant ». |
| Mémoire | Confirmation avant suppression et protection contre l’abandon d’un brouillon limitent les pertes accidentelles. | **Conserver** et ajouter historique/recherche. |
| Aide contextuelle | Les concepts maison ont une documentation locale et accessible depuis leurs écrans. | **Conserver**, avec davantage d’exemples visuels et de liens d’action. |
| Architecture locale | Recherche locale, abonnements existants, reprise des vraies sessions CLI et données locales forment une proposition de valeur claire. | **Mettre davantage en avant** dans l’onboarding et les états vides. |

## Priorités P0 — à corriger avant d’élargir l’usage

### P0.1 — Rendre les permissions explicites et interactives

**Constat.** Le projet possède bien un champ `permission_mode`, mais l’interface de création ne demande que le nom et le chemin. Pour Codex, `sidecar/src/adapters/codex-app-server.ts:383` démarre le thread avec `approvalPolicy: "never"`, puis `sidecar/src/adapters/codex-app-server.ts:509` accepte automatiquement toutes les requêtes `requestApproval`. Le document de conception prévoyait pourtant des permissions par projet et des décisions Autoriser/Refuser dans l’UI.

**Frustration / risque.** L’utilisateur ne sait pas quel niveau d’autonomie est actif. Le comportement réel peut être acceptable sur un projet personnel, mais il est dangereux sur un dépôt professionnel ou lors d’une commande inhabituelle. La confiance se casse dès qu’une action risquée est réalisée sans possibilité visible d’intervention.

**Proposition.**

- À la création du projet, proposer trois modes en langage naturel : **Lecture seule**, **Demander avant action sensible**, **Autonome**.
- Afficher le mode courant dans l’en-tête du projet et dans la nouvelle conversation, avec override temporaire pour un tour.
- Remonter les demandes d’approbation inline dans le fil : commande/diff/chemin concerné, raison, risque, Autoriser une fois, Refuser, Toujours autoriser pour ce projet.
- Conserver un journal local des décisions et rendre les règles permanentes modifiables.
- En mode autonome, afficher tout de même un indicateur explicite ; ne jamais confondre absence de demande avec autorisation implicite.

**Critères d’acceptation.** Aucune action nécessitant une approbation provider ne peut être acceptée silencieusement hors mode Autonome ; le mode est visible avant l’envoi du premier message ; une décision permanente peut être révoquée.

### P0.2 — Protéger le travail conversationnel

**Constat.** Les conversations peuvent être épinglées, mais aucun parcours de renommage, archivage ou suppression récupérable n’est présent. Le titre est dérivé du début du premier message. Le brouillon du composer reste dans l’état local de `Chat.tsx` et n’est pas persisté par conversation.

**Frustration.** Au fil de l’usage, la sidebar devient un historique de titres tronqués. L’utilisateur ne peut ni ranger ni corriger un titre, et peut perdre un long prompt en changeant de conversation ou de projet. Ces deux problèmes touchent directement le travail déjà produit, donc la confiance.

**Proposition.**

- Ajouter Renommer, Archiver, Déplacer vers la corbeille et Restaurer.
- Enregistrer automatiquement un brouillon par conversation et un brouillon de nouvelle conversation par projet.
- Ajouter Dupliquer/Forker depuis un message ou depuis un Débrief.
- Trier par épinglées, actives, récentes, archivées ; charger progressivement l’historique.
- Afficher activité, échec ou demande d’attention directement sur la ligne de conversation.

**Critères d’acceptation.** Un changement de vue puis un redémarrage de l’application ne perd pas le brouillon ; une suppression est récupérable ; un utilisateur peut retrouver une conversation sans dépendre du premier message.

### P0.3 — Simplifier le démarrage d’une tâche

**Constat.** Une nouvelle conversation affiche immédiatement preset, provider, quota, plusieurs cartes de modèles, effort, vitesse, orchestration, deux modèles de sous-agents et une longue explication de routage. À 1280 × 800, la configuration prend l’essentiel de l’espace avant le composer. Le preset projet est chargé de façon asynchrone (`ConfigPanel.tsx:107`) : l’interface montre brièvement une configuration initiale différente avant d’appliquer le défaut.

**Frustration.** Le besoin réel est « je veux accomplir cette tâche ». L’utilisateur doit pourtant arbitrer des détails de moteur avant même d’écrire. Le clignotement du preset crée en plus un doute : avec quelle configuration le message partirait-il si l’on agit très vite ?

**Proposition.**

- Faire du composer le centre de l’écran.
- Résumer le routage dans une seule ligne : `Vitesse · Luna · sous-agents auto`, avec un bouton Modifier.
- Proposer trois intentions lisibles — **Rapide**, **Équilibré**, **Critique** — plutôt que d’exposer d’abord chaque paramètre.
- Placer provider, modèle, effort, vitesse et verrous de délégation sous **Réglages avancés**.
- Afficher un skeleton et bloquer l’envoi jusqu’au chargement du preset projet, sans état intermédiaire trompeur.

**Critères d’acceptation.** Un utilisateur connaissant déjà le projet peut démarrer une tâche en moins de 20 secondes sans ouvrir les réglages avancés ; aucun contrôle ne change de valeur après être devenu interactif.

## Priorités P1 — forte valeur produit et UX

### P1.1 — Remplacer les grands écrans vides par une vue « À traiter »

**Constat.** Sans projet ou sans conversation sélectionnée, la zone principale est presque entièrement vide. Fleet ne montre que les runs actifs ; une tâche terminée disparaît. Les notifications sont uniquement natives et ne possèdent pas de centre persistant ni de deep link.

**Frustration.** Le produit est présenté comme un poste de pilotage, mais il ne répond pas à « qu’est-ce qui mérite mon attention maintenant ? ». Si une notification système est refusée ou manquée, le résultat n’a pas d’inbox visible.

**Proposition.** Créer une vue d’accueil **À traiter** avec :

- tâches actives, bloquées et récemment terminées ;
- demandes d’approbation et échecs ;
- changements non relus par Gardien et tests manquants ;
- conversations récentes à reprendre ;
- seuils de quota proches ;
- CTA « Ajouter un projet » ou « Démarrer une tâche » selon le contexte.

La notification native doit ouvrir directement l’élément concerné et rester doublée par une entrée locale acquittable.

### P1.2 — Faire de la sidebar un tableau de situation

**Constat.** La sidebar montre surtout noms, chemins, conversations et quotas. Les outils quotidiens sont derrière le menu « Outils » et regroupés par noms de features : Gardien, Git, Coûts, Fleet, Mémoire, Routines, Bibliothèque.

**Frustration.** L’utilisateur doit connaître le vocabulaire du produit pour savoir où aller. Il ne voit pas au premier coup d’œil la branche, un working tree sale, un run actif ou une review bloquante.

**Proposition.**

- Ajouter sur chaque projet des signaux compacts : branche, modifications locales, run actif, alertes Gardien, élément en attente.
- Organiser la navigation par besoin : **Travail**, **À traiter**, **Vérifier**, **Automatiser**, **Connaissance**.
- Garder `Ctrl+K` pour les utilisateurs avancés, mais rendre les actions principales visibles sans mémorisation.
- Sur fenêtre étroite, regrouper les actions secondaires de l’en-tête dans un menu unique.

### P1.3 — Enrichir la navigation dans une conversation

**Constat.** Le fil est lisible et les appels shell sont bien groupés, mais un long historique n’offre ni sommaire, ni recherche interne, ni accès direct à un tour ou un résultat. Les résultats globaux ouvrent la conversation, pas le message correspondant.

**Frustration.** Une conversation longue redevient un document à faire défiler. Les preuves existent mais sont coûteuses à retrouver.

**Proposition.**

- Ajouter recherche dans le fil, surlignage et scroll jusqu’au résultat.
- Ajouter un mini-sommaire des tours avec états, erreurs, décisions, tests et Débriefs.
- Proposer Copier, Modifier et renvoyer, Réessayer, Forker ici, Épingler ce message.
- Regrouper non seulement les shells, mais aussi les séquences d’outils et les sous-agents sous un résumé « action → résultat ».
- Ajouter un bouton Aller au dernier message et des ancres stables.
- Clarifier les tokens `entrée / sortie` avec libellé ou tooltip ; ne pas utiliser une flèche ambiguë.

### P1.4 — Regrouper les résultats de recherche

**Constat.** La recherche `shell` a produit plusieurs résultats issus de la même conversation, dont un snippet ne contenant pas visiblement le terme recherché. `CommandPalette.tsx:173` ajoute chaque résultat backend sans regroupement ni ancrage d’événement.

**Frustration.** Une seule conversation peut monopoliser la palette et l’utilisateur ne sait pas pourquoi un résultat correspond. Il clique puis doit rechercher à nouveau dans le fil.

**Proposition.**

- Grouper par conversation avec un à trois meilleurs extraits, puis « voir les N occurrences ».
- Surligner le terme et garantir qu’il soit visible dans l’extrait.
- Afficher projet, date, provider et type de contenu.
- Ajouter une portée Projet courant / Tous les projets et des filtres Conversation, message, Débrief, skill.
- Ouvrir sur l’événement exact et le mettre temporairement en évidence.

### P1.5 — Faire de Gardien un parcours en un clic

**Constat.** L’état vide de Gardien conserve trois colonnes largement vides. La boîte de création demande provider auteur, provider reviewer, modèle, effort et références techniques `CONVERSATION` / `WORKTREE`. Le reviewer par défaut peut être le même provider que l’auteur.

**Frustration.** L’utilisateur veut relire « ce qui vient d’être changé », pas construire manuellement une commande de review. Les références magiques et le choix du reviewer demandent de connaître l’implémentation.

**Proposition.**

- Dans l’état vide, afficher un CTA **Relire les changements actuels** avec branche, nombre de fichiers et taille du diff détectés.
- Déduire l’auteur de la conversation et proposer par défaut un reviewer indépendant lorsque le quota le permet.
- Afficher un aperçu du scope avant consommation de quota.
- Déplacer refs, provider, modèle et effort sous Avancé.
- Replier la mise en page en une seule colonne tant qu’aucune review n’existe.

### P1.6 — Remonter la comparaison en haut de Git

**Constat.** Sur le dépôt audité, 118 commits sont rendus avant le bloc « Comparer deux références » (`GitView.tsx:136–205`). Les deux listes de refs incluent branches et historique, ce qui les rend très longues.

**Frustration.** L’action la plus utile — comprendre un changement entre deux points — exige de traverser l’historique. La longue liste consomme du DOM et beaucoup d’espace sans faciliter la sélection.

**Proposition.**

- Mettre une barre de comparaison sticky au-dessus de l’historique.
- Rendre chaque commit cliquable comme base ou cible.
- Remplacer les selects par une recherche de refs avec catégories branches/tags/commits récents.
- Paginer ou virtualiser l’historique.
- Ajouter filtre auteur/date/texte et résumé du diff avant son contenu.

### P1.7 — Transformer Bibliothèque et Workflows en outils de sélection fiables

**Constat.** La Bibliothèque charge 212 entrées et sélectionne automatiquement la première (`SkillsLibrary.tsx:50`), même si elle vient d’un autre projet. Plusieurs skills partagent le même nom selon leurs sources. Le formulaire Workflow charge toutes les entrées puis sélectionne automatiquement `loadedSkills[0]` (`WorkflowDialog.tsx:61`), alors que le placeholder indique « Choisir un skill ».

**Frustration.** Le volume et les doublons masquent les skills réellement disponibles pour le projet. L’auto-sélection peut créer un workflow avec le mauvais skill. Les listes natives deviennent impropres à 200 options.

**Proposition.**

- Par défaut, montrer **Favoris et récents du projet**, puis un bouton Explorer toutes les sources.
- Dédupliquer par invocation et présenter les sources comme variantes explicites.
- Ne rien sélectionner automatiquement ; conserver un état vide intentionnel.
- Utiliser une combobox searchable, groupée par projet/provider/source.
- Autoriser un workflow basé sur un prompt seul, sans skill obligatoire.
- Prévisualiser le prompt, l’invocation et la configuration finale ; proposer un Test run avant sauvegarde.
- Virtualiser la liste et charger le détail uniquement après sélection explicite.
- Rappeler la limite de portabilité actuelle : scripts, références et assets d’un skill ne sont pas transportés par le bridge v1.

### P1.8 — Corriger la pertinence et le vocabulaire des suggestions de skills

**Constat.** Pour un message lié à `commit et push`, le panneau a notamment suggéré `cardputer-buddy` parce qu’un mot correspondait à `push`. Le score lexical accepte tout score positif (`skill-suggestions.ts:55–80`). Le bouton visible dit « Lancer », alors que son tooltip précise qu’il ajoute seulement l’invocation au composer.

**Frustration.** Des faux positifs visibles font perdre confiance dans toutes les suggestions. Le verbe « Lancer » laisse penser qu’une action ou un tour va démarrer.

**Proposition.**

- Imposer un seuil minimal et enrichir les stop words avec les termes génériques de développement.
- Surpondérer la disponibilité projet, les favoris, la récence et les déclencheurs exacts.
- Afficher description, source et justification utile, pas seulement le mot commun.
- Renommer l’action **Ajouter au message**.
- Ajouter « Utile / Pas pertinent » pour améliorer localement le classement.
- En cas d’ambiguïté, ne pas consommer un appel Luna tant que le panneau n’est pas explicitement consulté — comportement déjà proche de l’existant à conserver.

### P1.9 — Donner une mémoire à Fleet et aux notifications

**Constat.** Fleet répond bien à « qu’est-ce qui tourne ? », mais devient vide dès que les runs sont terminés. La conception prévoyait aussi le dernier screenshot, absent des cartes actuelles. `useAppNotifications.ts:26–32` crée une notification sans gestion du clic.

**Frustration.** Une supervision active-only est utile tant que l’utilisateur regarde l’écran. Elle ne couvre pas le retour après une pause, les échecs manqués ni la comparaison des dernières exécutions.

**Proposition.** Ajouter trois onglets : **Actifs**, **À traiter**, **Récemment terminés**. Conserver le dernier événement, la dernière preuve/screenshot, la durée, les tokens, le résultat et les actions Ouvrir, Réessayer, Ignorer. Les notifications doivent deep-linker vers cette entrée.

### P1.10 — Rendre les routines accessibles sans connaître cron

**Constat.** La création expose directement `0 9 * * 1-5`, sans aperçu de fuseau ni prochaines occurrences. Le réglage global de notification se trouve dans l’en-tête de Routines et son bouton de sauvegarde affiche littéralement `s` (`RoutinesView.tsx:308–313`).

**Frustration.** L’utilisateur peut programmer la mauvaise heure et ne le découvrir qu’après exécution. Le bouton `s` ressemble à un bug et un réglage global pollue la tâche de création.

**Proposition.**

- Remplacer le cron principal par « Jours ouvrés à 09:00 », avec mode cron avancé.
- Afficher fuseau, trois prochaines exécutions et validation immédiate.
- Demander une politique de chevauchement, de retry et de retard après arrêt de l’application.
- Ajouter Exécuter maintenant en mode essai avant activation.
- Déplacer le seuil de notification dans Réglages et utiliser autosave ou un bouton « Enregistrer » complet.

### P1.11 — Prévisualiser réellement les pièces jointes

**Constat.** Les images sont bien rendues inline. Les autres fichiers apparaissent comme liens ; les formats acceptés incluent PDF, CSV, JSON et documents, mais pas audio/vidéo. La vision produit prévoyait PDF, CSV tabulaire et vidéo inline.

**Frustration.** L’utilisateur doit sortir du fil pour comprendre le contexte envoyé ou la preuve produite. Le fil perd son rôle de dossier de travail autonome.

**Proposition.**

- Aperçu sandboxé pour texte/Markdown/JSON, CSV tabulaire et PDF.
- Lecteur inline pour audio/vidéo si ces formats sont acceptés.
- Afficher taille, type, progression, limite et erreur avant envoi.
- Permettre le drop sur toute la zone de conversation avec feedback visuel, pas seulement sur le composer.
- Toujours proposer Télécharger/Ouvrir séparément pour les formats non prévisualisables.

## Priorités P2 — finition, cohérence et accessibilité

### P2.1 — Réduire la densité là où elle gêne la décision

Des tailles de texte de 9 et 10 px subsistent dans `composer.css`, `cards.css` et `sidebar.css`. À 1024 × 720, certaines métadonnées et actions deviennent difficiles à lire. La densité est utile pour le cockpit, mais elle ne doit pas toucher les informations nécessaires à une décision.

**Recommandation.** Minimum 12–13 px pour les contrôles et métadonnées utiles, 14 px pour le corps ; réserver 10–11 px aux informations purement secondaires. Tester zoom 125 % et 150 %, ainsi que la taille Tauri minimale 960 × 600.

### P2.2 — Finaliser l’accessibilité des dialogues

Les dialogues déclarent généralement `role="dialog"` et `aria-modal`, mais la gestion d’Échap est inégale et aucun focus trap/restauration systématique n’est visible. WorkflowDialog n’a pas le comportement Échap des autres modales. L’input fichier masqué et le bouton « Joindre » peuvent aussi créer deux contrôles annoncés.

**Recommandation.** Utiliser un composant Dialog commun : focus initial, trap, Échap, retour du focus au déclencheur, titre/description annoncés, fond inert. Retirer les inputs masqués de l’arbre accessible quand un bouton délégué existe. Tester clavier seul et lecteur d’écran sur création, review, changement de modèle et workflow.

### P2.3 — Rendre Coûts actionnable

La vue observée affiche 31,3 M tokens sur trois conversations, mais les colonnes délégué/économie sont toutes à zéro et prennent malgré tout de la place. Elle n’explique ni évolution, ni part du total, ni anomalie.

**Recommandation.** Masquer les colonnes uniformément nulles ; ajouter évolution par semaine, répartition entrée/sortie, part par projet/modèle, conversations atypiques et comparaison à la période précédente. Renommer « économie » en **tokens du modèle parent évités — estimation**, car les tokens de modèles différents ne sont pas strictement équivalents.

### P2.4 — Étendre Mémoire sans en faire un IDE

La sécurité de base est bonne, mais il manque création, recherche, renommage et historique. Seule la mémoire Claude est exposée alors que Pupitre présente les deux providers.

**Recommandation.** Ajouter Nouveau, recherche, renommage, versions locales et Restaurer. Clarifier la portée Claude/Codex et harmoniser progressivement la gestion des deux mémoires plutôt que laisser un intitulé global ambigu.

### P2.5 — Rendre l’aide plus opératoire

Les pages sont utiles mais essentiellement textuelles, avec des liens « En savoir plus » peu distinctifs.

**Recommandation.** Ajouter captures annotées ou mini-diagrammes, exemples avant/après et boutons contextuels tels que « Ouvrir Gardien » ou « Créer une routine ». Libeller le lien selon son sujet : « Comprendre les presets », pas seulement « En savoir plus ».

### P2.6 — Unifier les termes d’action

La même fonction est présentée comme « Reprendre le contrôle », « Débrief » et « Créer un Débrief ». Les boutons Tester et Review Gardien lancent des opérations potentiellement coûteuses sans étape de scope aussi claire que le changement de modèle.

**Recommandation.** Utiliser une nomenclature unique : **Débrief — reprendre le contrôle** lors de la découverte, puis Débrief dans l’usage courant. Avant Tester ou Gardien, afficher scope, modèle et effet attendu ; garder les réglages techniques repliés.

## Décisions recommandées : conserver, changer, retirer, ajouter

### Conserver

- Le regroupement des appels shell et la transparence des détails.
- Les preuves, screenshots, tests et sous-agents inline.
- La passation cross-provider avec avertissement de coût contextuel.
- Les quotas honnêtes et la distinction provider/modèle.
- Gardien avec décisions ciblées plutôt qu’un bouton d’approbation global.
- Le panneau de skills repliable et fermé par défaut.

### Changer

- Nouvelle conversation : prompt d’abord, configuration avancée ensuite.
- Gardien : scope détecté et CTA direct, formulaire technique en avancé.
- Git : comparaison en haut, historique virtualisé.
- Bibliothèque : contexte projet par défaut, variantes explicites, pas d’auto-sélection.
- Fleet : actifs + attention + récents.
- Routines : langage naturel + aperçu des occurrences.
- Recherche : résultats regroupés et ancrés.

### Retirer de la vue principale

- La longue explication de routage des sous-agents avant le premier message.
- Les colonnes Coûts entièrement à zéro.
- Le cron brut comme seul parcours de création.
- Les réglages de notification dans l’en-tête Routines.
- L’auto-sélection du premier skill dans Bibliothèque et Workflow.
- Les résultats de recherche dupliqués pour une même conversation.
- Les références `CONVERSATION` / `WORKTREE` du parcours Gardien standard.

### Ajouter

- Modes de confiance et approbations inline.
- Vue À traiter et centre de notifications.
- Brouillons persistants et cycle de vie des conversations.
- Recherche/sommaire dans un fil et deep links vers les événements.
- Aperçus PDF/CSV/texte/audio/vidéo.
- Historique court de Fleet, retries et preuves.
- Historique/versionnement de Mémoire.
- Mesure de pertinence pour les suggestions de skills.

## Architecture d’information proposée

```text
Accueil / À traiter
├── À approuver
├── En échec ou bloqué
├── En cours
└── Récemment terminé

Travail
├── Projets
├── Conversations
└── Nouvelle tâche

Vérifier
├── Gardien
├── Tester
└── Git

Automatiser
├── Workflows
└── Routines

Connaissance
├── Bibliothèque
├── Mémoire
└── Aide
```

Les coûts et quotas sont transverses : ils doivent apparaître dans les décisions où ils comptent, puis disposer d’une vue analytique secondaire. Ils ne doivent pas être un silo que l’utilisateur doit penser à consulter.

## Proposition de roadmap

### Lot 1 — confiance et réduction de friction

1. Modes de permission par projet et approbations Codex inline.
2. Persistance des brouillons, Renommer/Archiver/Corbeille.
3. Nouvelle conversation compacte avec chargement atomique du preset.
4. Correction immédiate du bouton `s`, suppression des auto-sélections de skill.
5. Focus trap/Échap/restauration via un composant Dialog partagé.

### Lot 2 — poste de pilotage quotidien

1. Accueil À traiter et centre de notifications avec deep links.
2. Fleet récent/échec/retry.
3. Recherche regroupée, ancrée et scoped au projet.
4. Recherche et sommaire dans la conversation.
5. Statuts projet et conversation dans la sidebar.

### Lot 3 — simplification des outils avancés

1. Gardien en un clic avec scope détecté.
2. Git : compare sticky, combobox refs, historique virtualisé.
3. Bibliothèque/workflows dédupliqués et contextualisés.
4. Routines en langage naturel avec prochaines occurrences.
5. Aperçus d’artefacts inline.

### Lot 4 — apprentissage produit

1. Coûts avec tendances et anomalies.
2. Feedback local sur les suggestions de skills.
3. Historique de Mémoire.
4. Aide visuelle et onboarding guidé.

## Mesures de succès proposées

Ces métriques doivent être locales et agrégées si la promesse de confidentialité l’exige.

| Objectif | Mesure |
| --- | --- |
| Démarrer sans friction | Temps entre sélection du projet et premier envoi ; part des tâches lancées sans ouvrir Avancé. |
| Garder le contrôle | Nombre de demandes d’approbation, taux de refus, règles permanentes révoquées, actions autonomes clairement signalées. |
| Réduire les pertes | Brouillons restaurés, conversations archivées/restaurées, abandons après changement de vue. |
| Retrouver l’information | Taux de clic sur résultat, temps jusqu’au message cible, reformulations de requête. |
| Améliorer les suggestions | Taux Ajouter au message, taux Pas pertinent, précision par source/trigger. |
| Rendre les contrôles utiles | Part des reviews lancées avec scope automatique, alertes résolues, tests exécutés après alerte. |
| Faire vivre Fleet | Ouvertures depuis une notification, reprises après échec, temps avant traitement d’un run bloqué. |

## Conclusion

Pupitre possède déjà les briques d’un excellent outil de travail : contexte durable, orchestration, contrôle, preuves et connaissance locale. La prochaine étape n’est pas d’augmenter encore la surface fonctionnelle. Elle est de rendre cette puissance progressive : tâche utilisateur d’abord, détails techniques ensuite ; attention d’abord, navigation ensuite ; contrôle explicite avant autonomie.

Si un seul principe doit guider la prochaine passe : **montrer moins de mécanismes, mais mieux montrer l’état, le risque et la prochaine action**.

# Retours visuels Chrome vers Pupitre — spécification

## Objectif

Permettre d'annoter une interface de développement ouverte dans Chrome, puis de transmettre à Pupitre une demande de correction précisément rattachée à la zone visée, au bon projet et à la bonne branche. Le parcours ne requiert aucune modification du projet inspecté.

## Périmètre

La première version comprend :

- une extension Chrome locale chargeable en mode développeur ;
- un mode de pointage disponible sur les pages locales autorisées ;
- plusieurs annotations regroupées dans un panier séparé par projet ;
- la détection automatique du projet depuis l'origine de la page et le processus qui sert cette origine ;
- le choix de la branche cible ;
- la réutilisation ou la création du worktree correspondant ;
- la réutilisation d'une conversation compatible ou la création automatique d'une conversation ;
- l'envoi d'un prompt structuré avec captures et contexte DOM ;
- l'ouverture de la conversation cible dans Pupitre.

## Hors périmètre

- Publication de l'extension sur le Chrome Web Store.
- Inspection de sites distants ou de pages autres que les origines locales explicitement autorisées.
- Modification ou instrumentation des applications inspectées.
- Synchronisation du panier entre plusieurs machines ou profils Chrome.
- Édition graphique de captures, commentaires collaboratifs ou historique durable des annotations après envoi.
- Exécution automatique d'une correction sans démarrer un tour visible dans Pupitre.

## Architecture

L'extension communique directement avec l'API HTTP locale du sidecar. Un service worker Chrome porte les appels réseau ; le script injecté dans la page se limite à l'inspection DOM et à l'affichage du calque d'annotation. Le JavaScript du projet inspecté n'accède ni au jeton ni à l'API Pupitre.

Le système se compose de quatre unités :

1. **Inspecteur de page** : survol, sélection, extraction DOM bornée et affichage des marqueurs.
2. **Panier de l'extension** : stockage local des annotations, groupées par projet détecté.
3. **Pont HTTP du sidecar** : appairage, identification du projet, branches disponibles et soumission idempotente.
4. **Orchestrateur Pupitre** : préparation du worktree, résolution de la conversation, stockage des médias et lancement du tour.

Le canal direct est préféré à Chrome Native Messaging, dont l'installation et le binaire intermédiaire seraient disproportionnés pour un outil local. Il est également préféré à un relais via un onglet Pupitre, qui rendrait la fonctionnalité dépendante d'un onglet et de son état.

## Appairage et sécurité

Pupitre génère un jeton d'appairage local révocable. L'utilisateur le transmet à l'extension depuis une surface dédiée des réglages. Le jeton est conservé dans le stockage privé de l'extension et utilisé par son service worker.

Le sidecar :

- n'accepte que les origines d'extension appairées ;
- limite les routes du pont aux opérations nécessaires ;
- refuse les charges dépassant les limites définies ;
- ne renvoie pas de secrets, chemins arbitraires ou contenus de fichiers source à l'extension ;
- permet de révoquer l'appairage depuis Pupitre.

Les permissions de l'extension sont limitées aux URLs locales explicitement prises en charge. Les champs sensibles du DOM, notamment les mots de passe, valeurs de formulaires et contenus éditables, ne sont jamais collectés.

## Identification du projet

Pour une page locale, le sidecar reçoit l'hôte et le port, retrouve le processus à l'écoute puis son répertoire de travail. Il remonte jusqu'à la racine Git et la compare aux projets Pupitre et à leurs worktrees connus.

Chaque origine peut ainsi pointer vers un projet différent lorsque plusieurs serveurs tournent simultanément. Si plusieurs candidats restent possibles ou si la détection échoue, l'extension demande une association manuelle. Cette association est mémorisée par origine et, au besoin, par préfixe de chemin pour les applications servies derrière une origine commune.

Le panier est indexé par identifiant de projet. Une annotation ne peut pas être envoyée avec celles d'un autre projet.

## Interaction dans Chrome

Un raccourci ou l'action de l'extension active le mode annotation. Pendant le survol, un contour temporaire matérialise l'élément DOM ciblé. `Échap` quitte le mode sans créer d'annotation.

Un clic :

1. enregistre l'élément et la position précise dans celui-ci ;
2. remplace le contour par une croix numérotée au point cliqué ;
3. ouvre une bulle permettant de saisir la correction ;
4. propose `Ajouter au panier` ou `Envoyer`.

Les croix restent visibles tant que leurs annotations sont dans le panier. La numérotation est propre au panier courant. La suppression d'une annotation retire sa croix et renumérote l'ensemble de manière cohérente.

Le panneau de l'extension présente le projet détecté, les annotations du panier, la branche cible et la conversation qui sera utilisée. Une consigne générale facultative peut compléter les consignes attachées à chaque annotation.

## Données d'une annotation

| Donnée | Usage |
|---|---|
| Texte saisi | Décrire la correction attendue |
| Capture recadrée | Montrer précisément le composant ciblé |
| Capture du viewport | Situer le composant dans l'écran |
| Croix numérotée rendue sur les captures | Relier sans ambiguïté texte et position |
| Coordonnées du clic | Conserver le point exact dans l'élément et le viewport |
| Sélecteurs DOM candidats | Retrouver l'élément sans dépendre d'un sélecteur unique |
| Extrait HTML borné | Identifier la structure et le contenu voisins |
| Styles calculés pertinents | Aider au diagnostic de taille, espacement, couleur et position |
| URL, viewport et ratio de pixels | Reproduire l'état d'affichage |

Le HTML est limité à l'élément et à un voisinage utile, avec bornes de profondeur et de taille. Les captures restent locales et empruntent le stockage média existant de Pupitre.

## Branche, worktree et conversation

Le panneau charge les branches du projet détecté. La branche courante du serveur inspecté est proposée par défaut lorsqu'elle peut être déterminée ; sinon Pupitre utilise le choix mémorisé pour ce projet ou demande une sélection.

Pupitre ne change jamais la branche du répertoire principal. À l'envoi :

1. il réutilise le worktree de la branche cible ou en crée un ;
2. il recherche une conversation active attachée au même projet, à la même branche et au même worktree ;
3. il la réutilise lorsqu'elle a été explicitement choisie ;
4. en l'absence de conversation compatible, il en crée automatiquement une dans ce worktree ;
5. il ouvre la conversation dans l'application et démarre le tour.

Le message utilisateur regroupe le panier dans l'ordre des numéros. Chaque section contient la consigne, les références aux captures et les informations DOM. Un préambule précise que les sélecteurs et styles sont des indices observés, et que l'agent doit vérifier le résultat dans le navigateur.

## Fiabilité et erreurs

Le panier est conservé dans le stockage local de l'extension jusqu'à confirmation de l'envoi.

- Si Pupitre est indisponible, l'extension garde le panier et propose de réessayer.
- Si le projet n'est pas identifié, elle demande une association manuelle.
- Si la branche ou le worktree ne peut pas être préparé, aucune conversation n'est créée et le panier reste intact.
- Si la création de conversation réussit mais que le lancement échoue, la conversation reste visible et relançable ; le panier n'est marqué envoyé qu'après acceptation du message par le sidecar.
- Un identifiant d'envoi stable rend la soumission idempotente et empêche les doubles conversations ou doubles messages.
- Un succès vide uniquement le panier du projet concerné.

Les erreurs utilisateur sont formulées dans l'extension avec une action possible. Les détails techniques restent disponibles pour le diagnostic sans remplacer le message principal.

## API locale envisagée

Les noms exacts pourront suivre les conventions trouvées à l'implémentation, mais les responsabilités restent séparées :

| Opération | Rôle |
|---|---|
| Appairer ou vérifier l'extension | Établir et tester l'autorisation locale |
| Résoudre une origine | Retourner le projet détecté ou les candidats |
| Lister les branches et conversations compatibles | Alimenter le choix de destination |
| Soumettre un panier | Valider, stocker les médias, préparer la cible et lancer le tour |

La soumission transporte un schéma versionné afin de permettre l'évolution indépendante de l'extension et du sidecar.

## Vérification

Les tests unitaires de l'extension couvrent l'extraction DOM, la suppression des données sensibles, les coordonnées, la numérotation et la séparation des paniers. Les tests du sidecar couvrent l'authentification, la résolution origine-processus-projet, les associations manuelles, l'idempotence, le choix de branche, la création de worktree et la création ou réutilisation de conversation.

Les tests d'intégration vérifient les cas Pupitre indisponible, projet ambigu, branche invalide, erreur après création de conversation et double envoi.

La recette se fait dans Chrome sur `http://localhost:5173` et sur un second projet local lancé en parallèle. Elle confirme dans le DOM la présence et le nombre des croix, l'isolation des paniers, le projet et la branche réellement sélectionnés, puis le message reçu dans la bonne conversation. Une capture du résultat est jointe au compte rendu. Les suites `sidecar` et `ui` sont exécutées avant livraison.

## Critères d'acceptation

- Une page locale peut être annotée sans modifier son dépôt.
- Plusieurs projets locaux simultanés obtiennent des paniers indépendants.
- Chaque annotation possède une consigne et une croix numérotée visible.
- La branche cible est choisissable sans changer la branche du répertoire principal.
- L'absence de conversation déclenche sa création automatique dans le bon worktree.
- Le tour reçoit les captures, la cible DOM et les consignes dans un message cohérent.
- Un échec ne perd pas le panier et un double envoi ne duplique pas le travail.
- L'extension ne collecte pas les valeurs sensibles et une page inspectée ne peut pas lire le jeton d'appairage.

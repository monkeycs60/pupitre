# Contexte compact et centre de handoff

## Objectif

Réduire le contexte affiché aux seules données fiables, libérer le header de conversation et transformer « Passer la main » en un espace de transfert explicite proposant deux documents distincts.

## Surface de conversation

### Header

- Retirer le panneau détaillé de contexte et son hover de ventilation.
- Remonter le switch `Conversation / Code` à droite du header, avant les actions secondaires.
- Ne plus afficher le bouton permanent `Passer la main` dans le header.

### Pied du dernier run

- Conserver `terminé` et la durée à gauche.
- Placer à droite une jauge compacte avec uniquement le pourcentage de contexte réellement rapporté par le provider.
- Ne jamais afficher de ventilation estimée.
- Au survol ou au focus de la jauge, révéler l’action `Passer la main` sans déplacer le reste de la ligne.
- Au clavier, la jauge et l’action restent accessibles sans dépendre du hover.
- Le Gardien reste sur sa ligne indépendante sous le pied du run.

La jauge n’apparaît que sur le dernier run terminé de la conversation. Pendant un run, le header ne change pas de hauteur et l’action de handoff reste indisponible.

## Centre de handoff

`Passer la main` ouvre un dialogue large structuré autour de deux documents indépendants.

### Discussion complète

Document déterministe, disponible immédiatement sans appel au modèle. Ordre du contenu :

1. titre et métadonnées minimales de la conversation ;
2. instruction du ticket provenant du Tableau de bord, seulement lorsqu’elle existe ;
3. échanges visibles dans leur ordre réel, avec les rôles `Utilisateur` et `Modèle` ;
4. images et pièces jointes référencées par leur nom.

Le document exclut les prompts système, AGENTS.md, skills, mémoire, raisonnement interne, appels d’outils, sorties techniques, métriques et événements d’infrastructure.

Actions :

- `Copier la discussion` copie le Markdown exact ;
- `Enregistrer` télécharge le Markdown ;
- aucun modèle n’est appelé pour produire ce document.

### Handoff généré

Réutiliser la génération de débrief existante et son cache. Le document reste une synthèse opérationnelle, sans transcript complet en annexe.

Actions :

- `Générer le handoff` lance la génération existante ;
- `Copier` et `Enregistrer` exportent la synthèse ;
- `Créer une conversation` reprend les sélecteurs provider, modèle, effort et vitesse existants.

La discussion complète et le handoff généré sont présentés comme deux vues, pas comme deux cartes empilées. Le passage d’une vue à l’autre ne perd ni le document généré ni les réglages de la conversation cible.

## Backend et données

- Ajouter une route de lecture/export de transcript, construite depuis les événements persistés de la conversation.
- Sérialiser uniquement `user-message` et `text-final`.
- Inclure les noms d’images et de pièces jointes portés par les messages utilisateur.
- Lire `ticket_instruction` depuis la conversation source.
- Conserver les routes actuelles de génération et de création de handoff.
- Borner proprement la taille de la réponse HTTP sans tronquer silencieusement : une limite dépassée produit une erreur explicite.

## États et erreurs

- Discussion complète : chargement, prête, erreur explicite, nouvelle tentative.
- Handoff : état initial, génération, prêt, erreur explicite, nouvelle tentative.
- Copie : confirmation temporaire `Copié` sans fermer le dialogue.
- Création de conversation : verrouiller uniquement les contrôles concernés pendant l’appel.
- Un run actif bloque la génération et la création, comme aujourd’hui.

## Tests et vérification

- Tests backend du transcript : ordre, instruction ticket optionnelle, pièces jointes, exclusion des événements techniques, limite de taille.
- Tests UI : absence du détail estimé, jauge sur le dernier run seulement, révélation hover/focus, ouverture du centre de handoff, conservation des deux documents et des réglages.
- Tests d’accessibilité : rôles, intitulés, navigation clavier et focus visible.
- Suites `ui` et `sidecar`, build et lint.
- Vérification dans Vite avec mesures DOM et captures : header plus compact, jauge alignée au pied, aucun panneau de ventilation, parcours complet des deux exports.

## Hors périmètre

- Exposer ou exporter les instructions système et fichiers mémoire.
- Exporter les appels d’outils ou le raisonnement du modèle.
- Modifier la méthode de calcul du pourcentage provider.
- Ajouter un nouveau format autre que Markdown.

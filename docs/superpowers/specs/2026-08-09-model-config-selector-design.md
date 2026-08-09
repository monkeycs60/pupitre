# Sélecteur unifié de modèle et presets

**Date :** 9 août 2026  
**Statut :** validé — prêt à planifier

## Objectif

Remplacer le panneau de configuration encombrant affiché pour une nouvelle conversation et les listes natives de la modale « Changer de modèle » par un sélecteur compact partagé.

Le sélecteur doit :

- laisser le champ de saisie d'une nouvelle discussion immédiatement disponible ;
- rendre la configuration lisible depuis un chip compact ;
- présenter tous les presets, sans limite de nombre ;
- permettre d'ajuster modèle, effort, vitesse, autonomie et sous-agents sans ouvrir un formulaire à huit champs ;
- montrer le coût relatif des modèles et le quota disponible de chaque abonnement ;
- conserver le comportement sûr du handoff lors d'un changement de provider dans une conversation existante.

La référence visuelle est `Refonte UIUX app Tori (3).zip`, version 3. Les valeurs qui s'y trouvent prévalent sur les versions 1 et 2.

## Parcours utilisateur

### Nouvelle conversation

Le bloc « CONFIGURATION » et sa ligne récapitulative sont supprimés du haut du composer. La zone de saisie reste le premier élément disponible. Dans la barre basse du composer, un chip affiche :

`pastille · nom du preset (ou Réglages libres) · modèle court · effort · chevron`

Le chip ouvre vers le haut un menu principal ancré à droite :

1. Quand les réglages divergent du preset, un bandeau ambre montre le diff puis propose d'enregistrer un nouveau preset, d'écraser le preset courant ou de revenir à celui-ci.
2. La section Presets affiche la liste complète, dans une zone avec hauteur maximale et défilement vertical. Les trois presets intégrés restent seulement des repères ; ils ne constituent pas une limite.
3. Les réglages ouvrent leurs sous-menus : Modèle, Effort, Vitesse (Codex), Autonomie et Sub-agents.
4. Les actions secondaires restent accessibles par un menu contextuel par preset : renommer, supprimer si autorisé, restaurer pour un preset intégré, définir comme défaut.
5. Les liens d'aide et la réinitialisation du preset par défaut ferment le menu ou appliquent leur action de manière explicite.

Un preset appliqué apparaît en violet. Une configuration modifiée apparaît en ambre. En l'absence de preset sélectionné, le chip adopte l'état pointillé « Réglages libres ». Une modification manuelle ne crée ni n'écrase jamais un preset automatiquement.

### Modèle

Le sous-menu Modèle regroupe les modèles Codex puis Claude ; le provider n'est plus un réglage indépendant. Chaque groupe affiche son quota restant et une jauge à 20 segments. Chaque ligne de modèle affiche une coche si elle est sélectionnée, le nom lisible, une jauge de coût à 20 segments, un repère de coût, le ratio avec la sélection courante et les prix API entrée/sortie par million de tokens.

Les prix ne représentent pas une facture pour les abonnements : ils sont uniquement un repère de coût relatif. Le pied de menu le dit explicitement.

Le coût de référence d'un modèle est calculé pour 40 000 tokens d'entrée et 3 000 tokens de sortie. La jauge est linéaire par rapport au modèle le plus cher et contient toujours au moins un segment. La couleur traduit le rapport au modèle le moins cher : vert en dessous de 5×, ambre en dessous de 15×, rouge au-delà. Le ratio, lui, compare le modèle à la sélection courante : `×n` pour un modèle plus cher, `÷n` pour un moins cher et `×1` pour les modèles proches.

### Conversation existante

« Changer de modèle » réutilise le même sélecteur. Le choix reste éditable dans le menu ; le bouton principal de la modale applique le changement seulement après confirmation.

- Même provider : appel de changement de modèle existant.
- Provider différent : appel de handoff existant, avec l'estimation de contexte et le message de continuité déjà présents.

Le sélecteur ne modifie jamais une conversation active par lui-même. La modale garde donc les garanties actuelles de confirmation, d'erreur et d'annulation.

## Architecture

`ModelConfigSelector` est le composant de présentation partagé. Il reçoit la configuration en cours, les presets, les quotas et des callbacks de sélection ou d'action. Il ne connaît ni la création de conversation ni le handoff.

`ConfigPanel` devient un contrôleur léger : chargement des presets, choix du preset par défaut du projet et branchement des opérations CRUD déjà exposées par l'API. Il rend le chip dans le composer et ne rend plus le formulaire de configuration complet.

`SwitchModelModal` charge les presets nécessaires et instancie le même sélecteur. Elle conserve la soumission, l'estimation de ré-ingestion et les branches `switchConversationModel` / `handoffConversation`.

Le catalogue de modèles et son tarif sont centralisés dans `modelOptions.ts`. Il est typé, dérive les coûts, labels et tons à partir de la même source et ne duplique pas les modèles déjà autorisés par provider.

Le stockage côté sidecar ne change pas : `PresetStore.list()` retourne déjà une liste sans plafond et l'API CRUD existante suffit.

## Accessibilité et comportements

- Clic hors du menu et Échap ferment le popover ; Échap dans un sous-menu revient au niveau supérieur.
- Le chip, les lignes de menu et les actions sont des boutons accessibles au clavier, avec focus visible.
- Flèches haut/bas déplacent la sélection ; droite ou Entrée ouvre un sous-menu ; gauche revient au menu principal.
- Le menu conserve son ouverture après la sélection d'un réglage afin de rendre les ajustements successifs rapides.
- L'animation d'ouverture est courte et désactivée avec `prefers-reduced-motion`.
- Un quota indisponible ne bloque jamais la sélection de modèle : l'en-tête affiche un état inconnu plutôt qu'un pourcentage inventé.
- Les erreurs d'API de presets restent signalées par le mécanisme de notification actuel et la configuration visible demeure intacte après un échec.

## Tests et vérification

- Tests unitaires du catalogue : coût d'échange, segments, tons absolus, ratios `×`/`÷` et format monétaire français.
- Tests de rendu et d'interaction : sélection de preset, état modifié, retour au preset, plus de 100 presets et défilement.
- Tests d'intégration : changement inter-provider qui conserve le handoff et changement intra-provider qui utilise l'API de bascule.
- Vérification manuelle : création de conversation, preset par défaut, preset libre, navigation clavier, absence de quota et réduction des animations.
- Les tests UI existants de création de conversation et de changement de modèle restent verts.

## Hors périmètre

- Mesurer automatiquement la médiane de tokens par projet pour remplacer l'échange de référence fixe.
- Rafraîchir les tarifs API depuis le sidecar.
- Modifier le modèle de données ou les routes de presets.


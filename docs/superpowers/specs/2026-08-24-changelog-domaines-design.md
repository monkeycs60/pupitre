# Changelog par domaine et documentation produit vivante

**Date :** 24 août 2026  
**Statut :** remplacé le 27 août 2026 par
[`2026-08-27-project-changelog-design.md`](./2026-08-27-project-changelog-design.md)

## Objectif

Transformer le « Résumé session » en checkpoint de mémoire produit. Pupitre doit
identifier toutes les modifications significatives réellement réalisées pendant
une séquence de travail, les faire valider rapidement, puis enrichir immédiatement
le catalogue et le skill de chaque domaine concerné dans le dépôt du projet.

Le titre d'un ticket ne constitue pas une unité de connaissance suffisante : un
ticket ou une conversation peut livrer plusieurs évolutions fonctionnelles,
techniques, UI ou design. L'unité cataloguée est donc la modification autonome,
compréhensible indépendamment et appuyée par des preuves.

Pupitre sert d'atelier de collecte, d'attribution et de validation. La connaissance
partageable vit dans le projet afin qu'un membre de l'équipe ou un nouvel agent la
retrouve après un clone, sans dépendre de la base locale de Pupitre.

## Déclenchement et parcours

Une conversation n'a pas de fin fiable : elle peut être abandonnée ou reprise.
La fonctionnalité étend donc le checkpoint incrémental « Résumé session » existant.

1. Pupitre détecte des signaux indiquant qu'une séquence contient probablement des
   changements cataloguables : modifications Git, commit, tests finaux ou annonce
   de terminaison.
2. L'interface signale discrètement « Changements prêts à cataloguer ». Cette
   détection ne lance aucun modèle et n'écrit aucun fichier.
3. L'utilisateur clique sur la proposition ou force le traitement depuis l'action
   « Résumé session ».
4. Pupitre analyse seulement les événements postérieurs au précédent résumé, ainsi
   que l'état Git et les vérifications pertinentes.
5. Une validation rapide présente les modifications certaines présélectionnées et
   les changements ambigus dans une section distincte, non présélectionnée.
6. L'utilisateur peut tout valider, ou corriger, fusionner, scinder, réattribuer et
   rejeter individuellement les propositions.
7. Après confirmation, Pupitre écrit immédiatement les catalogues et skills des
   domaines concernés. Le diff reste dans le worktree afin de rejoindre normalement
   le même commit que le travail décrit.

Plusieurs checkpoints peuvent jalonner la même conversation. Une plage déjà traitée
ne doit jamais être reproposée.

## Modèle de génération

La mémoire produit requiert davantage de jugement que le digest léger. Tous les
traitements de ce parcours utilisent `gpt-5.6-luna` avec un effort `high` : résumé
de session, détection des modifications, rédaction des entrées et consolidation des
skills. Ce choix est indépendant du provider et du modèle de la conversation source.

Le digest court et les suggestions de domaines peuvent continuer à utiliser leur
modèle léger actuel. Aucun appel Luna n'est lancé avant le clic de l'utilisateur.

## Définition d'une modification cataloguable

Une modification est réalisée lorsqu'elle existe dans le worktree ou dans un commit
de la séquence et que sa vérification pertinente a réussi. Une idée, un plan, une
orientation discutée ou une tentative abandonnée n'entre pas au catalogue.

Une entrée est attendue lorsqu'un changement durable affecte au moins un axe :

- capacité utilisateur ou comportement produit ;
- règle métier ;
- interface, expérience utilisateur, design visuel ou accessibilité ;
- contrat de données ou d'API ;
- architecture structurante ;
- procédure opérationnelle ;
- capacité offerte aux agents, skill ou MCP du projet.

Un ajustement interne sans conséquence durable ne constitue pas une entrée. À
l'inverse, une modification UI ou design est cataloguée dès qu'elle change de façon
significative l'expérience, la composition ou la représentation du produit.

Le générateur doit pouvoir conclure qu'aucune modification notable n'a été réalisée.
Il segmente par unité de changement compréhensible, et non par ticket, commit ou
fichier.

## Sources, preuves et attribution

L'analyse confronte :

- les nouveaux événements de la conversation ;
- le diff Git et les commits de la séquence ;
- les tests et vérifications effectués ;
- les domaines actifs associés à la conversation ;
- les tickets, MR, documents et autres références disponibles.

La conversation explique l'intention, Git montre la réalisation et les
vérifications étayent le statut « réalisé ».

Les changements que Pupitre peut relier avec certitude à la séquence sont proposés
comme certains. Les modifications préexistantes, humaines ou issues d'une autre
conversation apparaissent comme ambiguës, avec la raison de l'incertitude et les
fichiers concernés. Elles ne sont jamais cochées automatiquement.

Une entrée validée contient au minimum : identifiant stable, titre, description,
nature (`ajout`, `modification`, `correction` ou `retrait`), domaine, impact, date et
preuves. La motivation et les liens connexes sont ajoutés lorsqu'ils sont établis,
jamais inventés.

## Domaines et catalogues

Une conversation sans domaine actif peut produire un résumé, mais aucune écriture de
catalogue tant que l'utilisateur n'a pas attribué les propositions à au moins un
domaine actif.

Chaque domaine possède son propre catalogue dans le dépôt. Une évolution
transversale produit une entrée adaptée à la perspective de chaque domaine concerné.
Ces variantes partagent un identifiant de modification pour préserver leur relation
et empêcher les doublons, sans imposer de catalogue canonique global.

L'emplacement est détecté à partir des conventions existantes du projet :
`.claude/skills`, `.agents/skills` ou une convention équivalente reconnue. Si
plusieurs racines coexistent sans source canonique identifiable, le réglage projet
demande explicitement laquelle Pupitre doit enrichir. La décision est persistée par
projet ; Pupitre ne maintient pas silencieusement deux copies divergentes.

Dans la racine retenue, chaque domaine forme une unité partageable :

```text
<racine-skills>/<domaine>/
├── SKILL.md
└── CHANGELOG.md
```

`CHANGELOG.md` est le catalogue chronologique, cumulatif et lisible. Les entrées sont
stables, déterministes et accompagnées de leurs références. La base Pupitre conserve
l'index technique, la provenance, l'état de validation et les identifiants nécessaires
à l'idempotence.

## Skill de domaine

`SKILL.md` décrit l'état intelligible et actuel du domaine ; il ne recopie pas tout
le changelog. Sa synthèse peut couvrir :

- mission, périmètre et vocabulaire ;
- état actuel et capacités ;
- direction observable à partir des modifications réalisées ;
- principes et décisions matérialisés dans le produit ;
- architecture et points d'entrée ;
- interactions avec les domaines voisins ;
- risques, dette et questions encore visibles dans l'état réalisé ;
- travaux récents significatifs ;
- skills, MCP et outils qui vivent dans le projet et sont utiles au domaine.

Une direction produit n'est jamais inventée à partir d'une intention. Elle peut être
formulée comme observation révisable lorsqu'une série de modifications validées la
rend manifeste.

Le skill peut expliquer quels MCP du projet utiliser, pour quel besoin, avec quels
prérequis et restrictions. Il documente les capacités ; il ne modifie ni permissions
ni configuration d'exécution.

## Publication immédiate et protection des écrits humains

La confirmation de la validation déclenche une seule opération logique : persistance
des entrées validées, mise à jour des `CHANGELOG.md`, puis mise à jour des `SKILL.md`.
Une erreur laisse l'opération réessayable et ne marque pas une entrée comme publiée.

Pupitre ne remplace jamais aveuglément un skill. Il conserve une empreinte de la
dernière version qu'il a publiée et compare le fichier courant avant toute nouvelle
écriture. Une modification humaine concurrente provoque un conflit visible avec diff,
jamais un écrasement silencieux. Les ajouts au catalogue sont également idempotents
grâce à l'identifiant stable de modification.

Les instructions et procédures explicitement humaines doivent être préservées. La
mise à jour Luna propose une nouvelle version intégrée du skill à partir du fichier
courant, du catalogue validé et de l'historique connu ; elle ne reconstruit pas le
fichier depuis le seul résumé récent.

Pupitre ne crée pas automatiquement de commit : les changements documentaires restent
visibles dans le worktree, sous le contrôle du workflow Git du projet.

## Interface de validation rapide

La validation doit rester assez légère pour être utilisée systématiquement :

- compteur et action « Tout valider » pour les modifications certaines ;
- cartes éditables avec domaine, nature, titre, impact et preuves ;
- fusion et scission lorsque le modèle segmente mal ;
- réattribution à un ou plusieurs domaines actifs ;
- rejet individuel sans justification obligatoire ;
- section séparée « Attribution incertaine », fermée par défaut et jamais cochée ;
- aperçu du diff documentaire avant confirmation finale ;
- message explicite lorsque rien de notable n'est détecté.

La vue Changelog du tableau de bord agrège les catalogues indexés par Pupitre et permet
de filtrer par projet, domaine et période. Un export Markdown reste disponible, mais
les fichiers du projet constituent déjà le principal support de partage.

## Données et frontières

La persistance doit distinguer trois états : proposition générée, entrée validée et
publication dans le dépôt. Elle relie chaque entrée au projet, au domaine, à la
conversation, à la plage d'événements, au modèle générateur, aux preuves et aux
variantes transversales partageant le même identifiant.

Les secrets et configurations MCP sensibles ne sont jamais copiés dans les catalogues
ou skills. Une source dégradée n'empêche pas la génération à partir des preuves encore
disponibles ; l'interface signale alors les limites d'attribution.

## Tests et vérification

- incrémentalité entre deux résumés et absence de reproposition ;
- appel obligatoire à Luna 5.6 en effort high, seulement après action utilisateur ;
- segmentation de plusieurs modifications dans un même ticket ;
- prise en compte des évolutions UI, UX et design ;
- possibilité de produire zéro entrée ;
- séparation et non-présélection des changements ambigus ;
- blocage de publication sans domaine actif ;
- catalogues par domaine et identifiant partagé pour une évolution transversale ;
- détection des conventions de skills et résolution explicite des ambiguïtés ;
- publication immédiate, déterministe et idempotente ;
- préservation des modifications humaines avec diff de conflit ;
- rendu de la validation rapide, édition, fusion, scission, rejet et validation globale ;
- filtres de la vue Changelog et export Markdown stable ;
- vérification dans l'application avec un travail réel comportant plusieurs changements,
  dont une évolution UI, puis contrôle du diff produit dans le dépôt cible.

## Hors périmètre

- cataloguer les décisions ou orientations non réalisées ;
- créer ou modifier automatiquement des permissions MCP ;
- commiter, pousser, publier une release ou déployer automatiquement ;
- la tranche D Backlog Notion et Répétitions ;
- maintenir plusieurs copies de skills sans source canonique choisie.

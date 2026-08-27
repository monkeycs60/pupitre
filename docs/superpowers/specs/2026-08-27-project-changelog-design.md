# Changelog automatique local par projet

**Date :** 27 août 2026  
**Statut :** validé pour implémentation

## Objectif

Pupitre maintient dans sa base locale un changelog exhaustif des commits de chaque
projet enregistré. Le résumé de session reste une synthèse de conversation et ne
déclenche plus de proposition, de validation ou d'écriture documentaire dans le
dépôt.

Chaque entrée expose la branche, le SHA, le sujet Git original, le domaine produit
et une phrase produit concise en français. Pupitre ne crée ni conversation visible,
ni `CHANGELOG.md`, ni modification de `SKILL.md` pour ce traitement.

## Synchronisation

- Le sidecar scanne les projets enregistrés dont le chemin existe et contient un
  dépôt Git.
- L'historique initial commence au 1er janvier 2026 et inclut tous les commits
  accessibles depuis les branches locales ou distantes.
- Le scan persiste immédiatement les commits inconnus, même si aucun enrichissement
  IA n'est disponible.
- Une synchronisation se déclenche au démarrage si elle est due, toutes les deux
  heures ensuite, ou manuellement depuis le tableau de bord du projet.
- Deux projets peuvent être traités en parallèle. Un verrou en mémoire empêche deux
  traitements simultanés du même projet.
- La prochaine échéance est persistée afin que le survol puisse afficher le temps
  restant après un redémarrage.

## Enrichissement agent

Après le scan, un tour Codex jetable et invisible enrichit au maximum dix commits
en attente, les plus récents en premier. Il utilise `gpt-5.6-luna`, effort `medium`,
vitesse standard et un accès en lecture seule au projet. Ce tour passe par le mode
agent Codex existant de Pupitre, sans API directe et sans ligne dans les
conversations.

Le modèle choisit au plus un domaine actif existant et rédige une phrase produit
simple. Une réponse invalide ou une erreur laisse les commits en attente pour un
passage ultérieur ; les sujets Git bruts restent consultables.

## Interface

Le tableau de bord contient un menu projet « Changelog » :

- « Voir le changelog » fait défiler jusqu'au catalogue ;
- « Actualiser le changelog » lance immédiatement un passage ;
- le survol affiche « Prochaine actualisation dans … », « Actualisation en cours »,
  « Jamais actualisé » ou l'erreur du dernier passage.

La liste affiche une entrée compacte : domaine, branche, SHA court, date, phrase
produit puis sujet Git original. Un filtre par domaine reste disponible. L'état
d'enrichissement est discret et n'empêche jamais la consultation.

## Persistance et reprise

Une table d'entrées est unique par `(project_id, commit_sha)`. Une table d'état par
projet conserve le statut, la dernière tentative, la dernière réussite, la prochaine
échéance et l'erreur éventuelle. Les anciennes tables de validation peuvent rester
présentes pour compatibilité de base, mais aucun nouveau code ne les alimente.

## Suppression de l'ancien parcours

- `POST /session-summary` ne renvoie que le résumé.
- Les routes de validation et publication de changelog sont retirées.
- Le dialogue de validation et ses appels UI sont retirés.
- Le service n'écrit plus dans `.claude/skills` ou `.agents/skills`.
- Les fichiers historiques déjà présents dans les autres dépôts ne sont pas
  supprimés automatiquement.

## Vérifications

- import Git idempotent depuis le 1er janvier 2026 ;
- branche et sujet original conservés ;
- lot d'enrichissement plafonné à dix et trié du plus récent au plus ancien ;
- configuration Luna medium standard, sans conversation ;
- verrou par projet et planification persistée à deux heures ;
- erreur IA non destructive et reprise des entrées en attente ;
- résumé de session indépendant ;
- menu, survol, actualisation manuelle et rendu compact vérifiés dans l'interface.

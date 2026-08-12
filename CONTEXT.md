# Pupitre

Pupitre pilote les CLIs Claude Code et Codex par conversations rattachées à des projets, avec un calque de review (le Gardien) posé sur le diff Git.

## Language

### Gardien

**Gardien** :
Le rôle de review : un modèle en lecture seule qui examine un diff et produit des signalements, sur les risques comme sur la qualité — cohérence d'architecture, duplication, code mort, simplicité. Il surligne, l'utilisateur dirige — il ne bloque jamais.
_Avoid_ : reviewer, garde, mode bloquant, Architecte (profil séparé rejeté)

**Sévérité** :
L'urgence de traitement d'un signalement, indépendante de sa nature (risque ou qualité) : Rouge = à traiter avant de pousser, Orange = mérite un traitement, Gris = cosmétique. La nature du constat est portée par la catégorie, jamais par la couleur.
_Avoid_ : criticité, niveau de risque (la sévérité n'est pas réservée au risque)

**Verdict d'adéquation** :
La synthèse rendue par le Gardien en tête d'une review : le diff répond-il à la demande utilisateur qui l'a produit, entièrement ou partiellement. Ce n'est pas un signalement — il n'est ancré sur aucune ligne.
_Avoid_ : score, ratio

**Review** :
Une passe du Gardien sur un diff donné, toujours rattachée à une conversation.
_Avoid_ : scan (acceptable à l'oral, pas dans l'UI), audit

**Zone** :
Un tronçon de diff soumis au Gardien en une seule passe ; l'unité de progression d'une review (« zone 3/7 »). Jamais un signalement.
_Avoid_ : chunk, segment

**Signalement** :
Un constat unitaire du Gardien, ancré sur des lignes du diff : sévérité (Rouge, Orange, Gris), catégorie, message, éventuel manque de test.
_Avoid_ : zone (surcharge historique de l'UI), flag (réservé au code), finding

**Contre-avis** :
Un second avis en lecture seule rendu sur un signalement par le provider opposé : confirmé, écarté ou nuancé.
_Avoid_ : second opinion, arbitrage

**Dispatch** :
L'envoi d'un agent en écriture chargé de traiter un signalement, avec une consigne éditable par l'utilisateur.
_Avoid_ : assignation, délégation

**Traité** :
Statut d'un signalement clos par l'utilisateur après lecture (« OK, vu »).
_Avoid_ : acquitté, acké

**Ignoré** :
Statut d'un signalement écarté comme faux positif.
_Avoid_ : rejeté, dismissed

**Résolu** :
Statut d'un signalement fermé automatiquement parce qu'une review ultérieure ne le retrouve plus sur un code modifié.
_Avoid_ : corrigé (rien ne prouve la correction), fermé

### Conversations

**Projet** :
L'identité unique d'un dépôt dans Pupitre — un nom, une icône, un seul projet par dépôt. Le travail multi-branches vit *à l'intérieur* du projet, jamais sous forme de projets jumeaux.
_Avoid_ : projet-ticket, projet-worktree

**Carte de review** :
L'event du fil de conversation qui résume une review terminée et permet le triage des signalements sans quitter la conversation.
_Avoid_ : notification de review, résumé de scan

**Atelier Git** :
La vue Git du rail : diff complet avec signalements ancrés, comparaisons Base/Cible, traitement en masse, historique commits ↔ conversations. Surface d'inspection, pas de triage quotidien.
_Avoid_ : vue Git (acceptable), guichet

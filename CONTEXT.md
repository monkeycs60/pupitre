# Pupitre

Pupitre pilote les CLIs Claude Code et Codex par conversations rattachées à des projets, avec un calque de review (le Gardien) posé sur le diff Git.

## Language

### Instances

**Instance stable** :
La version compilée et figée de Pupitre utilisée au quotidien, sur le port 4820
et les données `~/.local/share/pupitre`.
_Avoid_ : prod, release

**Instance dev** :
La version issue des sources vivantes, dédiée au développement de Pupitre, sur
le port 4821 et les données `~/.local/share/pupitre-dev`.
_Avoid_ : staging, sandbox

**Promotion** :
La construction puis la bascule atomique d'une version dev vers l'instance
stable, après attente de ses activités en cours.
_Avoid_ : déploiement, mise en prod

**Pastille d'instance** :
L'indicateur de la barre de titre qui nomme l'instance, le SHA du sidecar et la
présence éventuelle de sources périmées.

### Gardien

**Gardien** :
Le rôle de review : un modèle en lecture seule qui examine un diff et produit des signalements, sur les risques comme sur la qualité — cohérence d'architecture, duplication, code mort, simplicité. Il surligne, l'utilisateur dirige — il ne bloque jamais.
_Avoid_ : reviewer, garde, mode bloquant, Architecte (profil séparé rejeté)

**Sévérité** :
La gravité d'un signalement au sens « red flag », indépendante de sa nature (risque ou qualité). Rouge = ce qui ne devrait jamais apparaître dans le code : erreur de débutant, problème de performance, code dangereux ou horrible. Orange = moins grave mais aux implications potentiellement sérieuses : choix sous-optimaux, patterns douteux. Gris = correct mais améliorable. La nature du constat est portée par la catégorie, jamais par la couleur.
_Avoid_ : criticité, niveau de risque (la sévérité n'est pas réservée au risque), urgence

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

**Ligne Gardien** :
La ligne d'état du fil de conversation : statut de la dernière review et
bouton pour ouvrir la vue Code. Plus de triage des signalements dans le fil.
_Avoid_ : carte de review, notification de review, résumé de scan

**Atelier Git** :
La vue Code du rail, deux onglets : Changements (diff de la conversation,
signalements ancrés inline, actions Corriger/OK vu/Ignorer, commit) et
Historique (commits de la branche, review par commit).
_Avoid_ : vue Git (acceptable), guichet

### Tableau de bord

**Tableau de bord** :
La vue de projet qui présente tickets, environnements, MR à relire et backlog, chaque ligne avec ses actions d'agent.
_Avoid_ : dashboard, agrégateur, poste

**Ticket** :
L'unité de travail d'un projet, quelle que soit sa source — tâche ClickUp (`TECH-XXXXX`), item Notion, ou simple branche. Agrège branche, MR, pipeline, déploiements, conversations et notes.
_Avoid_ : tâche (réservé à ClickUp), issue, carte

**Domaine** :
Un label métier (Match AI, onboarding…) ou technique (API, BackOffice…) d'un projet ; taxonomie évolutive qui étiquette les conversations et porte la doc vivante et le changelog produit.
_Avoid_ : tag, catégorie, module

**Répétition** :
Le pré-mâchage d'un item de backlog ou d'un ticket, en lecture seule par défaut, qui produit un dossier injecté au démarrage du travail. Déclenchée à la main, sur proposition quota, ou automatiquement.
_Avoid_ : pré-mâchage (acceptable à l'oral), warm-up, préparation

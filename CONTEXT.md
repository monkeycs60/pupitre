# Pupitre

Pupitre pilote les CLIs Claude Code et Codex par conversations rattachées à des projets.

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


**Atelier Git** :
La vue Code du rail, deux onglets : Changements (diff de la conversation et
commit) et Historique (commits de la branche).
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

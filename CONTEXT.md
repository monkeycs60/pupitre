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

### Providers

**Provider** :
L'abonnement consommé, pas le binaire : le CLI n'est que le moyen de l'atteindre. Le nom affiché dit l'abonnement, la clé interne garde le nom du CLI, d'où les parenthèses quand les deux diffèrent.
_Avoid_ : moteur, agent (l'agent est le tour, pas l'abonnement)

**OpenCode Go** :
L'abonnement consommé par la clé interne `reasonix` : quota lu sur `opencode.ai/zen/go/v1/usage` avec `OPENCODE_API_KEY`, modèles servis par `opencode.ai/zen/go` (dont `go41`), tours exécutés par le CLI `reasonix`. Affiché « OpenCode Go (Reasonix) », et « OpenCode Go » seul là où la place manque.
_Avoid_ : ReasonX, Zen, Reasonix seul (c'est le CLI, pas l'abonnement)

**Claude, Codex, Grok** :
Les trois autres abonnements. Leur CLI porte le même nom, d'où l'absence de parenthèses — sauf la marque de Codex, qui nomme l'abonnement (ChatGPT) là où la réglette nomme le CLI.

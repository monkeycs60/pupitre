# Tableau de bord — tickets, domaines, backlog et Répétitions — design validé

Date : 2026-08-19 · Statut : validé (brainstorm Clément × Claude) · Nouveau chantier, sans refonte de l'existant.

## 1. Intention

Le travail quotidien est éparpillé : todo personnelle (Keep), tickets ClickUp, erreurs Sentry relayées sur Slack, MR et pipelines GitLab, déploiements testing/preprod, notes « dans le ticket, dans Keep et dans ma tête ». Pupitre a déjà le pouvoir d'agir sur ces services (MCP utilisateur actifs, skills `create-mr`, `fix-ci`, `clickup`) mais aucune surface qui les relie.

Le chantier ajoute une vue **Tableau de bord** par projet. Elle n'est pas un agrégateur de flux — un écran de plus à regarder meurt en trois semaines — mais un poste de travail où **chaque ligne est actionnable par un agent** avec le bon contexte et le bon skill, ce que ni ClickUp, ni GitLab, ni Slack ne peuvent offrir.

Deux axes structurent tout :

| Axe | Entité | Agrège | Débloque |
| --- | --- | --- | --- |
| Travail | le **Ticket** | état de la tâche, branche(s)/worktree, MR, pipeline, déploiements, *n* conversations, notes | le tableau ; « Démarrer / Reprendre sur cette branche » avec brief des conversations sœurs |
| Connaissance | le **Domaine** | les conversations qui l'ont touché, quel que soit le ticket | labels dans la sidebar ; doc vivante par domaine (successeur du skill `matching-system` tenu à la main) ; changelog produit chronologique |

Un ticket touche un ou plusieurs domaines ; un domaine traverse des dizaines de tickets. Les deux se croisent sur la conversation, unité de Pupitre.

Hors périmètre, décidé : FormPilot comme pont navigateur (le sidecar va chercher les données lui-même ; un `pupitre://` suffira plus tard) ; Slack en entrée (Sentry est lu à la source) ; Google Keep (pas d'API pour un compte perso — la todo migre vers Notion).

## 2. Vocabulaire

- **Tableau de bord** : la vue de projet qui présente tickets, environnements, MR à relire et backlog, avec leurs actions.
- **Ticket** : l'unité de travail d'un projet, quelle que soit sa source — tâche ClickUp (`TECH-XXXXX`), item Notion, ou simple branche. Un projet perso sans gestion de projet a quand même des tickets (`source: git`), pour que le tableau ne soit jamais vide.
- **Domaine** : un label métier (Match AI, onboarding, auth…) ou technique (API, BackOffice, Billing…) d'un projet ; taxonomie évolutive, amorcée depuis le champ *Service* de ClickUp pour affilae-mono.
- **Item de backlog** : une entrée de la base Notion *Backlog*, rattachée à un projet Pupitre, éventuellement promue en ticket.
- **Répétition** : le pré-mâchage d'un item ou d'un ticket, en lecture seule par défaut, qui produit un **dossier** (brief, points d'entrée dans le code, plan, questions, risques) injecté quand on démarre le travail. Déclenchée à la main, sur proposition quota, ou automatiquement.
- **Brief de reprise** : le préambule composé à la demande quand on démarre ou reprend un ticket — tâche et commentaires, dossier de Répétition, digests et Débriefs des conversations sœurs, notes.

## 3. Principes

1. **Relève déterministe, sans LLM.** Le sidecar interroge les API des services avec des tokens d'API (ClickUp, GitLab via `glab`/fetch, Notion, Sentry) sur le patron du `QuotaRefresher` : toutes les 5 min quand la fenêtre a le focus, 30 min sinon, et à la demande. Aucune de ces lectures ne consomme de quota IA — même nature d'appel que `GET /api/oauth/usage`.
2. **Le modèle n'intervient que sur une action** : démarrer/reprendre, réécrire une MR (`create-mr`), réparer un pipeline (`fix-ci`), relire, répéter, proposer des labels (deux champs ajoutés au digest haiku existant, pas de tour supplémentaire), écrire le changelog (ajouté au Résumé session existant).
3. **Le ticket est source-agnostique.** Chaque projet déclare ses intégrations et sa convention de branche ; le tableau est le même pour tous, seules les colonnes disponibles changent. affilae-mono : ClickUp + GitLab, branches `issue|maintenance|feature/TECH-XXXXX`, environnements GitLab `deploy:preprod`, `deploy:testing…testing_4` (reactor seulement ; hapigator est déployé à la main par la devops et s'affiche comme tel). Projet perso : Notion + GitHub, ou rien.
4. **Rien ne s'invente.** Une source en panne garde ses dernières données et le dit ; un rapprochement ambigu crée deux références, jamais une fusion ; une jauge sans donnée nomme ce qui manque.

## 4. Modèle de données

`project_integrations` : `project_id`, `type` (`clickup` | `gitlab` | `github` | `notion` | `sentry`), `config` JSON (listes ClickUp, projet GitLab, base Notion, projets Sentry), `branch_pattern` (regex qui extrait la clé, ex. `^(issue|maintenance|feature)/(TECH-\d+)`), `status` (`ok` | `dégradée` | `hors ligne` | `non configurée` | `à reconfigurer`), `last_ok_at`, `last_error`. Les tokens vivent dans `settings`, jamais dans cette table ni dans l'API publique.

| Table | Champs clés | Notes |
| --- | --- | --- |
| `tickets` | `id`, `project_id`, `key`, `source` (`clickup` \| `notion` \| `git`), `title`, `status`, `external_url`, `updated_at`, `archived_at` | une clé par projet ; créée à la première rencontre ; archivée après 14 jours sans mention par aucune source |
| `ticket_refs` | `ticket_id`, `kind` (`branch` \| `mr` \| `pipeline` \| `deployment` \| `sentry_issue`), `ref`, `payload` JSON, `seen_at` | état brut conservé (statut pipeline, environnement, auteur et date du déploiement, labels `deploy:*`) ; deux MR pour une clé = deux lignes |
| `ticket_notes` | `ticket_id`, `body`, `created_at` | notes locales ; les commentaires ClickUp sont lus à la volée |
| `conversations.ticket_id` | colonne ajoutée | déduit de la branche à la création, ou choisi à la main |
| `domains` | `project_id`, `name`, `kind` (`métier` \| `technique`), `status` (`actif` \| `proposé`) | tranche B |
| `conversation_domains` | `conversation_id`, `domain_id`, `origin` (`auto` \| `manuel`) | un label auto ne s'attribue que s'il a été accepté au moins une fois |
| `backlog_items` | `project_id`, `notion_page_id`, `title`, `status`, `ticket_id?`, `dossier_document_id?`, `rehearsed_at?` | miroir local de la base Notion, tranche D |
| `rehearsals` | `item_id?`, `ticket_id?`, `provider`, `model`, `mode` (`lecture` \| `actif`), `status`, `conversation_id`, `triggered_by` (`manuel` \| `proposition` \| `auto`), `started_at`, `ended_at`, `error` | tranche D |

Le brief de reprise n'est pas une table : il se compose à la demande à partir des digests et Débriefs des conversations partageant le `ticket_id`.

## 5. Flux

**Relève.** Un `IntegrationsRefresher` relève chaque source indépendamment (une transaction SQLite par source) : tâches ClickUp assignées à moi et leurs statuts ; MR GitLab où je suis auteur ou relecteur, leur dernier pipeline et leurs labels ; déploiements par environnement ; items Notion à faire / en cours ; issues Sentry non résolues (tranche E). Chaque relève rapproche par clé de ticket (branche, titre de MR, champ Notion) et écrit `tickets` / `ticket_refs`. Le WS diffuse `tickets-updated` ; l'UI ne poll jamais. Un 401/403 passe l'intégration en « à reconfigurer » et suspend sa relève ; GitLab en panne ne bloque pas Notion.

**Démarrer / Reprendre** = `POST /api/conversations` avec `branch` et `ticketId`. Le worktree est créé ou **retrouvé** (`GitService.createWorktree`, déjà le cas : deux conversations sur la même branche partagent le même dossier). Le sidecar assemble le brief de reprise et l'injecte comme le Handoff injecte son débrief ; le message original est conservé tel quel dans l'historique. L'agent dispose d'un outil `pupitre-mcp` `read_sibling_conversation(id)` pour creuser une conversation sœur à la demande — les transcripts bruts ne sont jamais injectés d'office.

**Labels de domaine (B).** Le digest haiku, aux mêmes paliers qu'aujourd'hui, propose 1-2 domaines existants et, s'il le faut, un nouveau nom qui arrive en `proposé`. L'utilisateur valide, renomme ou fusionne depuis les réglages du projet. Les pastilles s'affichent dans la sidebar et filtrent la recherche.

**Changelog produit et doc vivante (C).** Le Résumé session produit en plus, par domaine touché : une ligne de *changelog produit* (français, langage PO, un point précis) et des *notes techniques* (repères pour un dev). Le changelog s'empile chronologiquement par domaine et par projet, exportable en Markdown (PO, entretiens) ; les notes régénèrent périodiquement le `SKILL.md` du domaine dans `.claude/skills/<domaine>/` — ce que `matching-system` fait aujourd'hui à la main. Le skill `release-notes` d'affilae-mono partage la même source.

**Backlog Notion (D).** Base Notion *Backlog* : titre, projet (mappé sur un projet Pupitre), statut, clé de ticket éventuelle, drapeau « répété », lien vers le dossier. Le sidecar la lit avec un token d'intégration interne ; le MCP Notion sert à l'agent dans les conversations. Promouvoir un item en ticket ClickUp = action d'agent qui crée la tâche et recopie l'id dans Notion : Notion reste l'espace personnel, ClickUp celui de l'équipe.

## 6. Écran Tableau de bord

Entrée dans le rail et dans la palette Ctrl+K, une vue par projet.

| Bloc | Contenu | Actions |
| --- | --- | --- |
| **Mes tickets** | une ligne par ticket actif : clé, titre, statut, branche, MR (état, pipeline), où elle est déployée, *n* conversations, dernière activité, notes | Démarrer · Reprendre · Réécrire la MR (`create-mr`) · Réparer le pipeline (`fix-ci`) · ouvrir la source · notes |
| **Environnements** (si GitLab) | testing, testing_2…4, preprod : quelle branche, qui, depuis quand | ouvrir la MR ; plus tard, déclencher `deploy:*` |
| **À relire** | MR où je suis relecteur, pipeline et âge | Relire (conversation de relecture sur la MR) |
| **Backlog** (D) | items Notion du projet, drapeau « répété », dossier | Répéter maintenant · Promouvoir en ticket |
| **Proposition de Répétition** (D) | carte quand les règles de quota sont réunies | Lancer · Ignorer jusqu'à la fenêtre suivante |

La sidebar groupe les conversations par ticket sous le projet (repli possible), avec les pastilles de domaine. Un bandeau signale toute intégration dégradée (« ClickUp injoignable depuis 12 min ») sans jamais vider le tableau.

## 7. Répétitions

**Trois déclencheurs, un moteur** (`RehearsalScheduler`, nourri par le `QuotaTracker`) :

| Déclencheur | Quand | Comportement |
| --- | --- | --- |
| Manuel | bouton sur un item/ticket, ou « Répéter le backlog » | part tout de suite, sans regarder les quotas |
| Proposition *(défaut)* | règles réunies | carte + notification native ; un clic lance, un clic ignore jusqu'à la fenêtre suivante |
| Automatique | règles réunies, mode activé dans Routines | lance sans demander, journalise, plafond par jour |

**Règles d'arbitrage**, par provider et par fenêtre, toutes réglables :

| Règle | Défaut | Lecture |
| --- | --- | --- |
| Fenêtre 5 h | reset ≤ 60 min **et** utilisé ≤ 65 % | du reste va se perdre |
| Hebdo — budget quotidien | 100 / 7 ≈ 14,3 % par jour ; attendu = jours écoulés × 14,3 % ; en retard si utilisé < attendu − 5 pts | on est sous le rythme, autant l'utiliser |
| Les deux | 5 h réunie **et** hebdo ≤ attendu + 10 pts | ne pas dépenser le reste des 5 h si la semaine surconsomme |
| Codex | mêmes règles sur `primary` / `secondary` | on choisit le provider le plus en retard |
| Collision | aucun tour interactif sur le provider | — |
| Plafond | 2 / jour en automatique, illimité en manuel | — |
| Priorité | items Notion à faire sans dossier, les plus anciens d'abord ; puis tickets démarrés sans dossier | — |

Une Répétition est une conversation marquée `rehearsal`, avec consigne explicite, dans un worktree jetable ou en lecture sur le dépôt. Sortie obligatoire : un document HTML publié via `pupitre-mcp` (brief, points d'entrée, plan, questions, risques), attaché à l'item/ticket, « répété » coché dans Notion. Échec ou timeout (15 min) → `error` visible, pas de nouvelle tentative automatique avant 24 h sur le même item.

**Mode actif**, désactivé par défaut, réglable par item ou par projet : la Répétition peut écrire du code dans un worktree sur une branche dédiée, pousser et commenter le ticket. Même en mode actif : jamais de merge, jamais de déploiement, et le Gardien passe sur le diff produit avant ouverture. La carte de proposition affiche toujours « lecture seule » ou « actif ».

## 8. Tests

- **Sidecar (`bun test`)** : rapprochement branche/MR/ticket par `branch_pattern` (clé reconnue, clé absente, deux MR pour une clé, clé dans deux projets) ; transactions de relève indépendantes et conservation des données sur panne ; statut `à reconfigurer` sur 401 ; composition du brief de reprise (ordre, bornes de taille, conversations sœurs) ; règles de quota des Répétitions sur des snapshots fabriqués (5 h seule, hebdo en retard, hebdo en avance qui bloque, collision, plafond) ; garde de structure : une Répétition en mode lecture ne reçoit aucun câblage d'écriture (même patron que la garde de profondeur des sous-tâches).
- **UI (`bun test`, happy-dom)** : tableau rendu depuis un snapshot, actions présentes selon les intégrations déclarées (pas de colonne Environnements sans GitLab), bandeau de dégradation, groupement sidebar par ticket, carte de proposition.
- **Navigateur** : chaque tranche se vérifie sur `http://localhost:5173` avec Claude in Chrome — compter les lignes de tickets contre l'API, vérifier qu'un « Reprendre » ouvre bien une conversation sur le worktree existant (même `worktree_path`), capture jointe.

## 9. Découpage en tranches

| Tranche | Contenu | Utilisable seule ? |
| --- | --- | --- |
| **A** | `project_integrations`, `tickets`, `ticket_refs`, `ticket_notes`, `conversations.ticket_id` ; relève ClickUp + GitLab (MR, pipelines, environnements) ; vue Tableau de bord (Mes tickets, Environnements, À relire) ; Démarrer/Reprendre avec brief ; `read_sibling_conversation` ; sidebar groupée | oui — résout l'éparpillement initial |
| **B** | `domains`, labels proposés par le digest, validation dans les réglages, pastilles et filtres | oui |
| **C** | changelog produit et notes techniques au Résumé session, export Markdown, régénération de `SKILL.md` par domaine | dépend de B |
| **D** | intégration Notion, `backlog_items`, `rehearsals`, `RehearsalScheduler`, proposition/auto, mode actif | dépend de A |
| **E** | intégration Sentry : issues non résolues rattachées aux tickets ou en bloc à part, action « Triager » | dépend de A |

Chaque tranche fait l'objet d'un plan d'implémentation séparé (`superpowers:writing-plans`) et d'un commit par tâche.

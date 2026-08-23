# Pupitre

Mission control bureau pour Linux : une app qui pilote **Claude Code**, **Codex CLI** et **Grok Build** sur tes abonnements (jamais d'API payante), avec discussions par projet, orchestration, contrôle des changements, tests guidés et historique Git. Le pupitre du chef d'orchestre : l'app dirige les CLIs sans jouer une note elle-même.

## Architecture (M4)

```
┌─────────────────────────────────────────────┐
│  Tauri 2 (Rust minimal)                     │
│  fenêtre native, spawn du sidecar en dev    │
├─────────────────────────────────────────────┤
│  Sidecar Bun/TypeScript (le cerveau)        │
│  stores SQLite · adapters claude/codex/grok │
│  conversations · subtasks · reviews · skills│
│  serveur HTTP+WS · Git · tests · media       │
├─────────────────────────────────────────────┤
│  Frontend React + Vite (webview)            │
│  chat · Gardien · Résumé · Handoff · Tester │
│  bibliothèque · suggestions · lightbox       │
└─────────────────────────────────────────────┘
```

Les CLIs sont normalisés en un schéma d'événements unifié (`sidecar/src/events.ts`) ; le frontend ne connaît jamais Claude, Codex ou Grok directement. Les sessions sont celles des vrais CLIs (`claude -r`, `codex exec resume`, `grok --resume`) : reprise gratuite, et tes skills/CLAUDE.md/AGENTS.md marchent tels quels. Grok lit aussi `~/.grok/skills` et les skills Claude par compatibilité.

## Contrôle des changements (M3)

- **Gardien** analyse le diff Git avec un modèle fort et ancre ses signalements
  sur les lignes concernées, inline dans l'onglet Changements. Il surligne,
  l'utilisateur dirige : par signalement, envoyer un agent avec une consigne,
  marquer vu ou ignorer. Une fois toutes les corrections en cours terminées,
  la relecture repart automatiquement, en incrémental.
- **Résumé session** produit un bilan court des fonctionnalités et correctifs
  implémentés, avec les éléments restant explicitement à terminer. Le **Handoff**
  conserve le débrief complet pour transférer le travail à une nouvelle session.
- **Git** affiche branches, commits, HEAD et worktrees, relie les commits à leur
  conversation d'origine ; Historique des commits avec review par commit.
- **Tester** relit le fil, propose des scopes et méthodes concrètes, puis exécute
  le choix en sous-tâche. Sorties bornées tête/fin, captures navigateur, preuves
  et verdict restent inline ; un succès acquitte atomiquement les alertes
  « absence de test » liées et rafraîchit Gardien dans tout le projet.

Les opérations longues d'une conversation partagent un verrou explicite. Au
redémarrage, les reviews, sous-tâches et scopes interrompus sont clôturés, et une
continuation de passation restée incomplète est retirée plutôt que laissée dans
la sidebar. Exception contrôlée : pendant un tour Codex ou Claude, le composeur
reste ouvert et les précisions — captures comprises — sont injectées dans le tour
actif, puis conservées comme telles dans l'historique. Codex utilise
`turn/steer` ; Claude reçoit des messages `stream-json` sur son entrée persistante
et lit les captures depuis leur chemin local. Un tour Grok est one-shot
(`grok -p`) : le composeur se bloque jusqu'à la fin, comme `codex exec`.

## Bibliothèque de skills (M4-K)

- La vue **Bibliothèque** indexe et surveille les skills Claude globaux et de
  plugins, les skills `.claude/skills` des projets, les prompts Codex et les
  fichiers `AGENTS.md`. La recherche porte sur le nom, la description et les
  déclencheurs ; les favoris sont propres à chaque projet.
- Une invocation `$nom-du-skill` fonctionne dans les deux providers. Pupitre
  injecte le `SKILL.md` demandé dans le tour tout en conservant le message
  original dans l'historique. Le pont v1 ne transporte volontairement ni les
  scripts, ni les références, ni les assets du skill.
- Le seul panneau latéral de l'app propose jusqu'à trois skills par matching
  lexical sur le brouillon ou le dernier message. Il est fermé par défaut et
  mémorise le choix de l'utilisateur. Luna fast n'intervient que pour départager
  des scores proches lorsque le panneau est ouvert.
- **Nouveau skill** demande un besoin et une portée projet/globale. Codex Sol
  rédige le fichier avec le `skill-creator` indexé s'il existe ; l'installation
  refuse d'écraser un `SKILL.md` existant et rafraîchit immédiatement l'index.

## Workflows et routines (M4-L)

- Un workflow épinglé associe un skill, un prompt et un preset ou modèle. Il
  apparaît sous son projet dans la sidebar et démarre une nouvelle conversation
  en un clic ; son CRUD reste accessible par **+ Workflow**.
- La vue globale **Routines** planifie un workflow ou un prompt libre avec une
  expression cron cinq champs, calculée par le sidecar sans dépendance au cron
  système. Chaque passage devient une conversation normale marquée routine.
- L'historique affiche état, durée, tokens et accès à la sortie. Une exécution
  manuelle démarre en arrière-plan sans décaler le prochain passage planifié.
- Une notification native signale la fin des routines et des tâches
  interactives longues. Leur seuil est réglable dans la vue Routines (120 s par
  défaut), et la permission n'est demandée qu'au premier événement réel.

## Fleet, recherche et palette (M4-M)

- **Fleet** agrège en temps réel les tours, sous-tâches et routines actifs sur
  tous les projets. Chaque cellule expose durée, modèle et dernier événement,
  avec un accès direct à la conversation concernée.
- La recherche globale repose sur un index SQLite FTS5 local : titres de fils,
  messages utilisateur, réponses finales et Débriefs sont indexés au fil de
  l'eau, avec reconstruction de l'historique au démarrage. Aucune donnée ne
  quitte la machine pour rechercher.
- **Ctrl+K** ouvre la palette depuis n'importe quel écran. Elle navigue vers les
  projets et conversations, interroge la recherche globale, lance workflows et
  skills, ouvre Fleet/Routines/Bibliothèque et déclenche Tester, Résumé session ou
  Gardien sur le fil courant.

## Tableau de bord (tranche A)

- Le **Tableau de bord** ajoute une vue projet centrée sur le **ticket** :
  une ligne relie la tâche, sa branche, sa MR, son pipeline, son éventuel
  déploiement, ses conversations Pupitre et ses notes locales.
- Les données viennent de **ClickUp** et **GitLab**. La relève reste
  déterministe, sans LLM, avec rafraîchissement automatique quand Pupitre est
  actif, relance manuelle possible et diffusion temps réel vers l'UI.
- Côté GitLab, Pupitre réutilise le token de **`glab`** quand il existe ; un
  token dédié peut sinon être défini dans **Paramètres > Tokens**.
- Le bouton **Démarrer** ouvre une nouvelle conversation liée au ticket ; le
  bouton **Reprendre** rattache la suite au même ticket et à la même branche.
- Les deux actions retrouvent ou créent le **worktree partagé** de la branche,
  puis injectent un brief court : contexte du ticket, conversations soeurs et
  possibilité d'appeler `read_sibling_conversation` à la demande.
- La configuration projet se fait dans **Réglages du projet > Intégrations** :
  listes ClickUp, projets GitLab, environnements suivis et motif de branche.
- **Sentry** se configure séparément pour chaque projet Pupitre : token local
  opaque, organisation et projets Sentry. L'inbox ne relève que la production,
  toutes les 15 minutes quand l'app est active et toutes les 60 minutes en
  arrière-plan ; un scan manuel reste disponible.
- **Mes domaines** met en avant les issues liées aux domaines permanents du
  projet et aux tickets ClickUp actifs. Pour affilae-mono, le catalogue couvre
  Match AI au sens large (matching, profils affiliés, signup/onboarding et
  vectorisation), Wishlists et Instagram ; Brand Search seul reste exclu.
- Une issue ouvre un détail expurgé, puis **Scout** enquête en lecture seule et
  rend un verdict structuré. Une erreur fixable peut, après confirmation,
  créer son ticket ClickUp, sa branche `issue/TECH-…`, son worktree et une
  conversation de correction. La MR reste soumise à une confirmation distincte.
- La taxonomie **Domaines** vit dans les réglages du projet : le digest propose
  1–2 labels, les pastilles et le filtre de recherche n'affichent que les
  domaines validés. ClickUp (champ Service) et les skills projet amorcent des
  propositions, jamais des labels visibles.
- Elle ne couvre pas encore **Notion / backlog** ni **Répétitions** ; le périmètre complet reste décrit dans
  [le design du chantier](docs/plans/2026-08-19-tableau-de-bord-design.md).

## Coûts, mémoire et aide (M4-N)

- **Coûts** présente l'usage mensuel en tokens par conversation et modèle. Les
  tokens Luna délégués sont comptés comme budget du modèle parent préservé, sans
  inventer de prix en euros.
- **Mémoire** lit et édite `~/.claude/memory` avec écritures atomiques,
  protection contre les chemins extérieurs et confirmation avant suppression ou
  abandon d'un brouillon.
- **Reprendre au terminal** copie `claude --resume`, `codex resume` ou `grok --resume` avec l'id
  de session du fil. L'import inverse est reporté après constat de plusieurs
  formats Codex incompatibles dans l'historique local.
- **Aide** embarque les pages Markdown des concepts Pupitre, les recherche en
  local et reçoit les liens contextuels des écrans et contrôles non évidents.

## Sous-tâches déléguées (M2-D1)

Une conversation peut déléguer du travail à un autre modèle (le Conductor de la phase D). Le moteur vit dans `sidecar/src/subtasks.ts` :

- `POST /api/subtasks {conversationId, provider, model, effort?, speed?, prompt, label?}` → `201 {id}`, tour lancé en arrière-plan dans le cwd du projet parent, **sans prendre le verrou de conversation** (une sous-tâche tourne délibérément en parallèle du tour parent qui l'a demandée).
- `GET /api/subtasks/:id` → `{status, resultText, error, subtask}` — `resultText` = concaténation des `text-final`, `error` = message du dernier statut terminal en échec (`null` sinon). Un sub-agent qui plante n'écrit souvent aucun `text-final` : sans `error`, l'orchestrateur et la carte UI n'ont qu'un « ÉCHEC » sans cause.
- `GET /api/subtasks/:id/events` → replay, et `GET /api/conversations/:id/subtasks` → les sous-tâches d'une conversation.
- Les événements d'une sous-tâche sont stockés dans la table `events` sous **son propre id** : le replay HTTP et le canal `/ws?conversation=<subtaskId>` fonctionnent à l'identique d'une conversation.
- Au lancement, un event `subtask-ref` est appendé à la **conversation parente** : c'est ce qui permet à l'UI d'afficher la carte de sub-agent. La carte charge d'abord le snapshot HTTP et n'ouvre un WebSocket que si elle est **dépliée** ou si la sous-tâche **tourne encore** (`ui/src/subtaskStream.ts`) : un fil qui a délégué trente fois ne tient pas trente sockets sur des flux définitivement muets. Tant que le snapshot n'est pas revenu, la carte est dans un état neutre (« chargement ») — jamais « en cours », sinon les cartes historiques gonfleraient le compteur de sub-agents de la sidebar à chaque ouverture du fil.
- `POST /api/subtasks/:id/cancel` → `202` (interrompt la sous-tâche en vol, statut terminal `error: annulé`), `409` si elle est déjà terminée, `404` si l'id est inconnu.
- `POST /api/conversations/:id/cancel` annule **en cascade** : le tour parent *et* toutes ses sous-tâches en vol (`SubtaskRunner.cancelByConversation`). `202` dès qu'il y avait quelque chose à annuler (même sans tour parent en cours), `409` sinon. Sans la cascade, tuer l'orchestrateur laissait ses sub-agents tourner sans plus personne pour lire leur résultat.

**Limite de concurrence : 4 sous-tâches simultanées par conversation parente** (`MAX_CONCURRENT_SUBTASKS`). Au-delà, l'API répond `429` et c'est à l'appelant (le bridge MCP de D2) de séquencer ses délégations. La limite est par conversation, pas globale : deux conversations peuvent orchestrer en parallèle sans se gêner. Elle protège du fan-out incontrôlé — autant de process CLI, de quota consommé et d'écritures concurrentes dans le même working directory qu'il y a d'appels.

## Bridge MCP « conductor » (M2-D2)

C'est ce qui donne à l'orchestrateur la *main* sur les sous-tâches : un serveur MCP stdio maison, `sidecar/src/conductor-mcp.ts`, lancé **par le CLI** et qui rappelle le sidecar en HTTP local.

```
bun sidecar/src/conductor-mcp.ts     # PUPITRE_PORT, PUPITRE_CONVERSATION_ID
```

Le bridge est **sans état** : chaque outil est un appel à l'API D1 ci-dessus. Un process par tour orchestrateur, rien à nettoyer.

| Outil | Effet |
| --- | --- |
| `delegate({provider, model, effort?, speed?, prompt, label?})` | `POST /api/subtasks`, puis poll de `GET /api/subtasks/:id` toutes les 2 s jusqu'à `done`/`error` (timeout 15 min). Rend le `resultText` ou l'erreur. |
| `delegate_parallel({tasks:[…max 4]})` | Crée toutes les sous-tâches (le `429` de la limite de concurrence est encaissé et réessayé — c'est le séquençage attendu côté appelant), attend tout, rend les résultats dans l'ordre des tâches. |
| `check_quotas()` | `GET /api/quotas` mis en forme lisible (fenêtres, % utilisé, reset). |

Les descriptions d'outils sont la doc que lit l'orchestrateur : modèles disponibles (`claude` : fable-5 / opus / sonnet / haiku ; `codex` : gpt-5.6-sol / gpt-5.6-luna / gpt-5.6-terra ; `grok` : grok-4.6 / grok-4.5), efforts, `speed: fast` **codex uniquement**, et la recommandation de routage (sous-tâche d'exécution → `gpt-5.6-luna`, effort low/medium, fast ; `check_quotas` avant de choisir en cas d'hésitation).

**Câblage, par tour** — piloté par la colonne de conversation `orchestrator` (INTEGER, **défaut 1**, acceptée par `POST /api/conversations`) :

- **claude** : `--mcp-config '<JSON inline>'` avec `{mcpServers:{conductor:{command, args:[<chemin absolu>], env:{PUPITRE_PORT, PUPITRE_CONVERSATION_ID}}}}`. Pas de `--strict-mcp-config` : les serveurs MCP de l'utilisateur restent actifs.
- **codex (app-server)** : le champ `config` de `thread/start` / `thread/resume` est un **override de configuration par thread** (clés de `config.toml`) — on y met `mcp_servers.conductor`. C'est ce qui résout le problème du process app-server *partagé* par tout le sidecar : chaque thread démarre ses propres serveurs MCP, donc chaque tour reçoit son propre `PUPITRE_CONVERSATION_ID` par l'environnement. Aucun besoin de passer l'id par le prompt.
- **codex exec** (chemin historique `PUPITRE_CODEX_MODE=exec`) : les mêmes valeurs en overrides `-c mcp_servers.conductor.*`.
- **grok** : `grok -p` n'a pas `--mcp-config`. Le pont est un plugin éphémère sous `~/.grok/plugins/.pupitre-*` (chargé et de confiance), retiré à la fin du tour. Le flux est `streaming-messages-json` (même fil Messages que Claude Code). Pas de précision en vol : le headless Grok ne lit pas stdin.
- Filet documenté : chaque outil accepte aussi un paramètre optionnel `conversation_id` qui prime sur l'environnement, pour un hôte incapable de transmettre un environnement par tour.

Le port du sidecar est fourni au `ConversationRunner` par une fonction **obligatoire** (résolue à chaque tour, le serveur étant construit après le runner). Un tour orchestrateur qui résout un port invalide échoue immédiatement avec un `status: error` explicite, au lieu de lancer un CLI dont les délégations partiraient vers un port mort.

**Garde de profondeur** : un tour de sous-tâche ne reçoit **jamais** le câblage conductor. Ce n'est pas une convention mais une propriété de structure — `SubtaskRunner` ne construit pas le champ `conductor` de `TurnOptions` et aucun chemin ne permet de l'y ajouter. Un sub-agent ne voit donc pas les outils de délégation : pas de sous-sous-tâche, pas de récursion (testé dans `tests/conductor-wiring.test.ts`).

## Presets et réglages (M2-E1)

Les configurations de nouveau tour sont persistées dans `presets` (`provider`, modèle, effort, vitesse, orchestration et verrou éventuel des sub-agents). Trois presets intégrés sont créés idempotemment — **Éco**, **Qualité max**, **Vitesse**. **Tous les presets sont éditables** via le CRUD HTTP (`/api/presets`) ; `built_in` ne signifie plus « immuable » mais « restaurable et non supprimable » : `POST /api/presets/:id/restore` remet un intégré à ses valeurs d'usine, et le seed au démarrage est un `INSERT OR IGNORE` pur pour ne jamais réécrire une édition. Chaque projet peut mémoriser son choix avec `PUT /api/projects/:id/default-preset`; supprimer un preset personnel efface aussi les défauts projet qui le référencent.

Les réglages transverses vivent dans la table key/value `settings` (`GET/PUT /api/settings`). Au premier démarrage E1, l'UI importe les anciens seuils de notification de quota depuis `localStorage`, les enregistre côté sidecar puis retire la clé historique. Les clés de déduplication des notifications restent locales à la webview.

## Relève des quotas

Les providers n'exposent pas leur état de la même façon, et le `QuotaRefresher` (`sidecar/src/quota-refresh.ts`) cache l'asymétrie derrière un seul appel :

| | Lecture d'état | Pourcentage d'usage | Coût d'une relève |
| --- | --- | --- | --- |
| codex | `account/rateLimits/read` sur l'app-server | oui (`usedPercent`) | gratuit |
| claude | aucune — le `rate_limit_event` n'existe que dans le flux d'un tour, et n'est écrit ni dans les transcripts ni dans un cache | **non**, seulement `resetsAt` | un tour minimal |
| grok | `GET …/v1/billing?format=credits` avec le jeton de `grok login` | oui (`creditUsagePercent`) | gratuit |

La sonde claude (`sidecar/src/adapters/claude-quota.ts`) est donc réduite au strict nécessaire : modèle haiku, prompt système d'une ligne, aucun MCP, aucun hook, répertoire temporaire vide pour ne découvrir aucun `CLAUDE.md`. Au démarrage, elle ne tourne que si le relevé stocké ne couvre plus la fenêtre en cours (`claudeQuotaIsStale`) ; `POST /api/quotas/refresh` la force. Deux relèves simultanées ne paient qu'un seul tour.

L'UI ne comble jamais un trou par une supposition : sans pourcentage publié, elle affiche la date de reset et nomme la donnée manquante.

## Changement de modèle et passation (M2-E2)

Depuis un fil ouvert, la modale « Changer de modèle » distingue deux opérations :

- même provider : `PUT /api/conversations/:id/model` met à jour modèle, effort et vitesse sans casser la session CLI ; l'UI prévient que le cache sera perdu et estime la ré-ingestion en additionnant les événements `usage` du fil ;
- autre provider : `POST /api/conversations/:id/handoff` génère le débrief
  complet sans outils, l'épingle dans le fil source, crée une conversation cible
  reliée par `continued_from`, puis lui transmet ce bilan pour initialiser sa
  propre session. Le bouton Handoff peut aussi produire le document Markdown,
  le copier, l'enregistrer ou créer une nouvelle conversation avec le même
  provider. La sidebar matérialise le lien dans les deux sens.

## Prérequis

- [Bun](https://bun.sh) ≥ 1.3, Rust ≥ 1.77 (+ deps Tauri Linux : `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`…)
- `claude` (Claude Code), `codex` (Codex CLI) et `grok` (Grok Build) installés **et authentifiés** sur leurs abonnements

## Démarrage (dev)

```bash
bun install
bunx tauri dev        # compile la coquille, lance vite + sidecar, ouvre la fenêtre
```

Ou sans fenêtre native :

```bash
bun run --cwd sidecar dev    # sidecar sur :4820
bun run --cwd ui dev         # UI sur :5173, proxy vers le sidecar
```

### Reprendre la main sur le sidecar pendant un chantier backend

```bash
bun run dev:sidecar          # sidecar sans --watch : redémarre quand TU le décides
bun run dev:sidecar:watch    # redémarrage à chaque sauvegarde (l'ancien comportement)
```

Lancé alors que l'app tourne déjà, `dev:sidecar` réclame le port 4820 : il demande
au sidecar de Tauri de s'arrêter (`POST /api/shutdown`), et Tauri ne le relance pas
puisqu'un exit 0 est considéré comme volontaire. L'UI parle donc ensuite à *ton*
sidecar, au premier plan, logs visibles.

L'intérêt du mode sans `--watch` est le contrôle du moment : chaque redémarrage tue
les tours en vol, y compris une conversation en cours de réponse. En `--watch`, une
simple sauvegarde suffit à la perdre ; sans lui, on édite autant qu'on veut et on
redémarre entre deux tours. À l'inverse, garder un vieux sidecar sur le port fait
tourner l'UI sur du code périmé, et les correctifs semblent ne jamais s'appliquer.

Données dans `~/.local/share/pupitre` (override : `PUPITRE_DATA_DIR`). Binaires CLI overridables pour tester sans quota : `PUPITRE_CLAUDE_BIN` / `PUPITRE_CODEX_BIN` (voir `sidecar/tests/fake-bins/`).

Par défaut, l'app-server Codex lancé par Pupitre conserve les plugins et MCP
utilisateur, mais borne à 5 secondes le handshake de chaque MCP classique : un
serveur indisponible ne peut donc plus retarder le premier retour de deux minutes.
La borne est appliquée au process puis répétée dans la configuration des threads
orchestrateurs afin que l'ajout du bridge `conductor` ne la remplace pas. Le
bridge reste activé par thread. Réglages disponibles :

- `PUPITRE_CODEX_MCP_POLICY=bounded` (défaut) : capacités conservées, démarrage borné ;
- `PUPITRE_CODEX_MCP_POLICY=full` : configuration Codex intacte, sans borne ajoutée ;
- `PUPITRE_CODEX_MCP_POLICY=off` : désactive plugins et MCP utilisateur pour isoler une panne ;
- `PUPITRE_CODEX_MCP_STARTUP_TIMEOUT_SEC=5` : change la borne du mode `bounded`.

L'ancien `PUPITRE_CODEX_USER_MCPS=1` reste compatible et équivaut à `full` si
la nouvelle politique n'est pas renseignée. Les mesures et la commande de probe
sont détaillées dans `docs/spikes/codex-mcp-latency.md`.

Au démarrage, le sidecar réclame son port : si un sidecar d'une session
précédente le tient encore, il lui demande de s'arrêter (`POST /api/shutdown`)
puis prend sa place — l'UI ne peut donc plus tourner sur du code périmé. Un
sidecar arrêté volontairement (exit 0) n'est pas relancé par l'app. À l'arrêt
(SIGTERM, éviction, fermeture de la fenêtre), le sidecar tue le groupe de
process complet de l'app-server Codex : ses serveurs MCP ne survivent plus en
orphelins.

## Tests

```bash
cd sidecar && bun test        # 302 tests (fixtures réelles des CLIs, fake bins)
cd sidecar && bun run typecheck
cd ui && bunx tsc --noEmit && bun run build
```

Protocole e2e : `e2e/basic-flow.md`.

## Documentation

- **Design complet** (vision, features V1, jalons M1-M4) : `docs/plans/2026-08-04-pupitre-design.md`
- **Plan d'implémentation M1** : `docs/plans/2026-08-04-pupitre-m1-implementation.md`
- Formats réels des CLIs : `sidecar/tests/fixtures/README.md`

## Périmètre

**M1 (fait)** : socle — projets, conversations streamées sur les deux providers, reprise, épinglage, images inline, annulation de tour, coquille Tauri.

**M2 (fait)** : orchestration cross-provider (Conductor), sous-tâches, quotas des deux abonnements, presets et changement de modèle.

**M3 (fait)** : Gardien, résumé de session, handoff, bouton Tester avec
preuves, vue Git et durcissement du sidecar.

**M4 (fait)** : bibliothèque de skills, suggestions et workflows, routines,
Fleet, recherche globale et palette, coûts en tokens, mémoire, reprise terminal
et aide intégrée. E2E consolidé et passe design finale réalisés sans quota réel.

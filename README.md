# Pupitre

Mission control bureau pour Linux : une app qui pilote **Claude Code** et **Codex CLI** sur tes abonnements (jamais d'API payante), avec discussions par projet, orchestration, contrôle des changements, tests guidés et historique Git. Le pupitre du chef d'orchestre : l'app dirige les CLIs sans jouer une note elle-même.

## Architecture (M4 en cours)

```
┌─────────────────────────────────────────────┐
│  Tauri 2 (Rust minimal)                     │
│  fenêtre native, spawn du sidecar en dev    │
├─────────────────────────────────────────────┤
│  Sidecar Bun/TypeScript (le cerveau)        │
│  stores SQLite · adapters claude/codex      │
│  conversations · subtasks · reviews · skills│
│  serveur HTTP+WS · Git · tests · media       │
├─────────────────────────────────────────────┤
│  Frontend React + Vite (webview)            │
│  chat · Gardien · Débrief · Git · Tester    │
│  bibliothèque · suggestions · lightbox       │
└─────────────────────────────────────────────┘
```

Les deux CLIs sont normalisés en un schéma d'événements unifié (`sidecar/src/events.ts`) ; le frontend ne connaît jamais Claude ou Codex directement. Les sessions sont celles des vrais CLIs (`claude -r`, `codex exec resume`) : reprise gratuite, et tes skills/CLAUDE.md/AGENTS.md marchent tels quels.

## Contrôle des changements (M3)

- **Gardien** analyse le diff Git avec un modèle fort, ancre ses alertes sur les
  lignes concernées et demande d'acquitter les décisions une par une. Les points
  rouges peuvent recevoir automatiquement un contre-avis du provider opposé.
- **Débrief** produit un bilan versionné depuis le dernier bilan : réalisations,
  décisions, implications et questions ouvertes. Une passation cross-provider
  transmet ce débrief à la conversation suivante.
- **Git** affiche branches, commits, HEAD et worktrees, relie les commits à leur
  conversation d'origine et conserve les alertes Gardien sur les commits visés.
- **Tester** relit le fil, propose des scopes et méthodes concrètes, puis exécute
  le choix en sous-tâche. Sorties bornées tête/fin, captures navigateur, preuves
  et verdict restent inline ; un succès acquitte atomiquement les alertes
  « absence de test » liées et rafraîchit Gardien dans tout le projet.

Les opérations longues d'une conversation partagent un verrou explicite. Au
redémarrage, les reviews, sous-tâches et scopes interrompus sont clôturés, et une
continuation de passation restée incomplète est retirée plutôt que laissée dans
la sidebar.

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

Les descriptions d'outils sont la doc que lit l'orchestrateur : modèles disponibles (`claude` : fable-5 / opus / sonnet / haiku ; `codex` : gpt-5.6-sol / gpt-5.6-luna), efforts, `speed: fast` **codex uniquement**, et la recommandation de routage (sous-tâche d'exécution → `gpt-5.6-luna`, effort low/medium, fast ; `check_quotas` avant de choisir en cas d'hésitation).

**Câblage, par tour** — piloté par la colonne de conversation `orchestrator` (INTEGER, **défaut 1**, acceptée par `POST /api/conversations`) :

- **claude** : `--mcp-config '<JSON inline>'` avec `{mcpServers:{conductor:{command, args:[<chemin absolu>], env:{PUPITRE_PORT, PUPITRE_CONVERSATION_ID}}}}`. Pas de `--strict-mcp-config` : les serveurs MCP de l'utilisateur restent actifs.
- **codex (app-server)** : le champ `config` de `thread/start` / `thread/resume` est un **override de configuration par thread** (clés de `config.toml`) — on y met `mcp_servers.conductor`. C'est ce qui résout le problème du process app-server *partagé* par tout le sidecar : chaque thread démarre ses propres serveurs MCP, donc chaque tour reçoit son propre `PUPITRE_CONVERSATION_ID` par l'environnement. Aucun besoin de passer l'id par le prompt.
- **codex exec** (chemin historique `PUPITRE_CODEX_MODE=exec`) : les mêmes valeurs en overrides `-c mcp_servers.conductor.*`.
- Filet documenté : chaque outil accepte aussi un paramètre optionnel `conversation_id` qui prime sur l'environnement, pour un hôte incapable de transmettre un environnement par tour.

Le port du sidecar est fourni au `ConversationRunner` par une fonction **obligatoire** (résolue à chaque tour, le serveur étant construit après le runner). Un tour orchestrateur qui résout un port invalide échoue immédiatement avec un `status: error` explicite, au lieu de lancer un CLI dont les délégations partiraient vers un port mort.

**Garde de profondeur** : un tour de sous-tâche ne reçoit **jamais** le câblage conductor. Ce n'est pas une convention mais une propriété de structure — `SubtaskRunner` ne construit pas le champ `conductor` de `TurnOptions` et aucun chemin ne permet de l'y ajouter. Un sub-agent ne voit donc pas les outils de délégation : pas de sous-sous-tâche, pas de récursion (testé dans `tests/conductor-wiring.test.ts`).

## Presets et réglages (M2-E1)

Les configurations de nouveau tour sont persistées dans `presets` (`provider`, modèle, effort, vitesse et orchestration). Trois presets intégrés immuables sont créés idempotemment — **Éco**, **Qualité max**, **Vitesse** — et les presets personnels disposent d'un CRUD HTTP (`/api/presets`). Chaque projet peut mémoriser son choix avec `PUT /api/projects/:id/default-preset`; supprimer un preset personnel efface aussi les défauts projet qui le référencent.

Les réglages transverses vivent dans la table key/value `settings` (`GET/PUT /api/settings`). Au premier démarrage E1, l'UI importe les anciens seuils de notification de quota depuis `localStorage`, les enregistre côté sidecar puis retire la clé historique. Les clés de déduplication des notifications restent locales à la webview.

## Changement de modèle et passation (M2-E2)

Depuis un fil ouvert, la modale « Changer de modèle » distingue deux opérations :

- même provider : `PUT /api/conversations/:id/model` met à jour modèle, effort et vitesse sans casser la session CLI ; l'UI prévient que le cache sera perdu et estime la ré-ingestion en additionnant les événements `usage` du fil ;
- autre provider : `POST /api/conversations/:id/handoff` génère un Débrief sans outils, l'épingle dans le fil source, crée une conversation cible reliée par `continued_from`, puis lui transmet ce bilan pour initialiser sa propre session. La sidebar matérialise le lien dans les deux sens.

## Prérequis

- [Bun](https://bun.sh) ≥ 1.3, Rust ≥ 1.77 (+ deps Tauri Linux : `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`…)
- `claude` (Claude Code) et `codex` (Codex CLI) installés **et authentifiés** sur leurs abonnements

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

Données dans `~/.local/share/pupitre` (override : `PUPITRE_DATA_DIR`). Binaires CLI overridables pour tester sans quota : `PUPITRE_CLAUDE_BIN` / `PUPITRE_CODEX_BIN` (voir `sidecar/tests/fake-bins/`).

Par défaut, l'app-server Codex lancé par Pupitre désactive les plugins et MCP
utilisateur : leur initialisation différée ajoutait environ deux minutes avant
le premier retour, y compris avec Luna fast. Le bridge `conductor` de Pupitre
reste activé par thread. Pour réactiver volontairement tous les MCP utilisateur,
lancer le sidecar avec `PUPITRE_CODEX_USER_MCPS=1`.

## Tests

```bash
cd sidecar && bun test        # 280 tests (fixtures réelles des CLIs, fake bins)
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

**M3 (fait)** : Gardien, contre-avis, Débrief et passation, bouton Tester avec preuves, vue Git et durcissement du sidecar.

**M4 (en cours)** : bibliothèque de skills, pont cross-provider, suggestions,
composer, workflows épinglés et routines terminés ; fleet view, recherche
globale, palette, coûts, mémoire et aide intégrée restent à construire.

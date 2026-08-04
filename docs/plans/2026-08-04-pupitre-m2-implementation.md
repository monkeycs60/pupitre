# Pupitre M2 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development.
> **Contrainte d'exécution (Clement)** : sub-agents d'implémentation = **Claude Opus 5, effort medium**, via `claude -p --model opus --effort medium` en headless. Reviews milestone par agents Claude dédiés, commits par l'orchestrateur.

**Goal:** M2 = corriger les deux irritants réels constatés à l'usage (latence de démarrage codex, faux streaming codex), puis livrer l'orchestration cross-provider (Conductor), les quotas visibles des deux abonnements, les presets et le switch de modèle propre.

**Contexte requis avant toute tâche** : lire `README.md`, `docs/plans/2026-08-04-pupitre-design.md` (§4, §5, §8), le code de `sidecar/src/` (petit), et `sidecar/tests/fixtures/README.md`. Les conventions M1 s'appliquent : TDD, fixtures réelles qui font foi, fake bins pour ne pas consommer de quota, `bun test` + `bunx tsc --noEmit` verts à chaque tâche, PAS de commit par les sub-agents.

**État de départ** : 61 tests verts, tag M1 = commit `66293b3`.

---

## Phase A — Fiabilité du flux (les 2 fixes de la review finale)

### Task A1 : Raccord replay/WS dédupé par id d'événement

Le hook UI fetch le replay PUIS ouvre le WS : fenêtre de perte (un `status done` perdu verrouille le composer). Fix :
- Sidecar : `listEvents` renvoie `{id, ...event}` (id = rowid AUTOINCREMENT) ; le broadcast WS embarque le même id (appendEvent retourne l'id inséré ; `EventBus.broadcast` le transmet).
- UI (`useConversationEvents`) : ouvrir le WS D'ABORD (bufferiser les messages), puis fetch le replay, puis merger replay + buffer dédupés par id, puis passer en mode live.
- Tests : sidecar (id croissants dans replay et WS) ; UI logique de merge extraite dans une fonction pure `mergeReplayAndBuffer(replay, buffer)` testable sans DOM (la tester dans `sidecar/tests` n'a pas de sens — créer `ui/src/mergeEvents.ts` + le tester via un script bun dans `sidecar/tests/ui-merge.test.ts` qui importe le fichier).

### Task A2 : Reconnexion WS + état visible

- UI : handlers `close`/`error` sur le socket → bandeau « connexion perdue, reconnexion… » + retry avec backoff (1s, 2s, 5s, plafonné) ; à la reconnexion : refetch replay complet (dédup par id de A1 réutilisée) puis live.
- try/catch sur le JSON.parse des messages WS.
- Test : fonction de backoff pure testée ; test manuel documenté (kill du sidecar pendant un tour → bandeau, relance → resync).

**Milestone commit** après A2.

## Phase B — CodexAdapter v2 : app-server (latence + vrai streaming)

### Task B1 : Spike protocole app-server (fait par l'orchestrateur, pas un sub-agent)

Enregistrer une fixture réelle du protocole `codex app-server` (JSON-RPC sur stdio) : initialize, création de conversation, envoi d'un message, réception des événements (deltas de texte ? items ? usage ? **rate limits ?**), reprise d'une conversation existante, arrêt propre. Documenter dans `sidecar/tests/fixtures/README.md` (+ fixture `codex-app-server-basic.jsonl`). Décision à l'issue du spike : si le protocole s'avère impraticable (non documenté + instable), fallback = garder exec et ajouter une option par projet « config utilisateur allégée » (`--ignore-user-config` + `-c mcp_servers={}` à valider) pour tuer la latence MCP ; le vrai streaming attendra. Le plan continue en supposant app-server praticable.

### Task B2 : CodexAppServerClient

- `sidecar/src/adapters/codex-app-server.ts` : gère UN process `codex app-server` persistant (lazy start, restart si mort), multiplexe les conversations (map conversationId Pupitre ↔ conversationId codex), API : `startTurn(opts, emit)` compatible avec la signature `runCodexTurn` actuelle. Émet de vrais `text-delta` + `tool-start/end` + `usage` + le nouvel event `rate-limit` (voir C1).
- Le champ conversations.cli_session_id reste la clé de reprise (l'app-server sait resume par id de session codex — vérifié au spike).
- Fake : `tests/fake-bins/fake-codex-app-server` rejouant la fixture ; tests : deltas streamés dans l'ordre, reprise, crash du process → status error + restart au tour suivant, effort/speed/images toujours passés.
- `runner.ts` : provider codex → app-server client par défaut ; `PUPITRE_CODEX_MODE=exec` pour retomber sur l'ancien chemin (gardé).

**Milestone review** après B2 (c'est le morceau le plus risqué du M2).

## Phase C — Quotas des deux abonnements

### Task C1 : QuotaTracker sidecar

- Nouvel AppEvent `{type:"rate-limit", provider, payload}` : le parser claude mappe le `rate_limit_event` du flux stream-json (documenté dans fixtures/README.md) ; le client app-server codex mappe son équivalent (découvert au spike B1 ; si absent, estimation locale par cumul d'usage).
- `sidecar/src/quotas.ts` : QuotaTracker — conserve le dernier état connu par provider (fenêtres, %, reset time), persisté dans une table `quota_state` (survit au restart), mis à jour au fil des events. `GET /api/quotas` + broadcast WS global `/ws?channel=quotas`.
- Tests : injection d'events rate-limit → état exposé correct.

### Task C2 : UI quotas

- Barre de statut permanente (bas de la sidebar) : deux mini-jauges Claude (5h + weekly) et ChatGPT, compte à rebours au survol, état « inconnu » propre tant qu'aucun event reçu.
- Chips sur le sélecteur de modèle (formulaire nouvelle conversation) : « Opus · 62% · reset 14h30 ».
- Pulse « use it or lose it » : beaucoup de quota + moins d'1h avant reset → animation discrète sur les modèles chers du provider concerné.
- Notification native (plugin Tauri notification, `bunx tauri add notification`) aux seuils : dernière heure de fenêtre, 80% weekly. Seuils dans un `settings` simple (table key/value + GET/PUT /api/settings).

## Phase D — Orchestration : le Conductor

### Task D1 : Moteur de sous-tâches sidecar

- Table `subtasks` (id, conversation_id parent, provider, model, effort, speed, prompt, status, created_at) + leurs events dans la table `events` (conversation_id = subtask id, préfixé ou colonne kind — choisir le plus simple qui préserve le replay).
- `POST /api/subtasks` (interne, appelé par le bridge MCP) : lance un tour headless via les adapters dans le cwd du projet parent, en parallèle du tour parent (le verrou par conversation ne s'applique pas aux subtasks). `GET /api/subtasks/:id` (statut + résultat final = concat des text-final).
- AppEvent parent : `{type:"subtask-ref", subtaskId, provider, model, label}` appendé à la conversation parente au lancement (l'UI s'en sert pour afficher la carte).
- Tests avec fake bins : delegate simple, deux subtasks en parallèle, échec d'une subtask.

### Task D2 : Bridge MCP « conductor »

- `sidecar/src/conductor-mcp.ts` : petit serveur MCP stdio (SDK `@modelcontextprotocol/sdk`) lancé PAR les CLIs, qui parle au sidecar en HTTP local. Outils : `delegate({provider, model, effort?, speed?, prompt, label?})` → crée la subtask, attend la fin, retourne le résultat ; `delegate_parallel({tasks:[...]})` → pareil en parallèle ; `check_quotas()` → snapshot du QuotaTracker (pour un routage volontaire par l'orchestrateur, pas d'automagie).
- Câblage : claude → `--mcp-config` inline pointant sur `bun sidecar/src/conductor-mcp.ts` ; codex → `-c mcp_servers.conductor.command=...`. Activé par un flag de conversation `orchestrator: true` (défaut ON pour les nouvelles conversations, toggle dans le formulaire).
- Tests : le bridge en process réel contre un sidecar de test (fake bins), delegate aller-retour complet.

### Task D3 : UI cartes de sub-agents

- `subtask-ref` dans le fil → carte inline dépliable : badge provider·model·effort(+rapide), statut live (events de la subtask via `/ws?conversation=<subtaskId>`), durée, tokens, transcript complet en dépliant (réutilise EventView), screenshots inline inclus.
- Fan-out : plusieurs cartes en parallèle sous le message de l'orchestrateur.

**Milestone review** après D3.

## Phase E — Presets & switch

### Task E1 : Presets

- Table `presets` (name, provider, model, effort, speed, orchestrator) + preset par défaut par projet (colonne sur projects). CRUD API + sélecteur dans le formulaire de nouvelle conversation (« Éco », « Qualité max », « Vitesse » seedés en défaut) + « enregistrer comme preset » depuis la config courante.

### Task E2 : Switch de modèle propre

- Bouton « changer de modèle » sur une conversation → modale : (a) même provider : update conv (model/effort/speed) + avertissement cache perdu avec estimation de re-ingestion (somme des tokens d'usage de la conversation) ; (b) cross-provider : « handoff » — un tour système au modèle sortant « résume l'état pour passation » (prompt fixe), création d'une nouvelle conversation liée (colonne `continued_from`) seedée avec ce résumé, lien visuel entre les deux dans la sidebar.
- Tests : update même provider (adapter reçoit le nouveau modèle au tour suivant), handoff (nouvelle conversation seedée, lien).

## Phase F — Clôture

### Task F1 : E2E M2 + review finale

- Étendre `e2e/basic-flow.md` : reconnexion WS, streaming codex réel (deltas visibles), delegate réel (orchestrateur claude → subtask codex luna fast, une fois, quota minimal), quotas affichés après un tour réel de chaque provider.
- Review finale par code-reviewer, fixes, tag M2.

### Task F2 : Passe design UI (demande explicite de Clement : « l'UI est vraiment dégueulasse »)

- Charger le skill `frontend-design` et refondre le CSS/la structure visuelle : hiérarchie typographique, espacements, sidebar, cartes, jauges de quota, états vides, cohérence sombre. Pas de changement de comportement — uniquement l'apparence. Validation par screenshots avant/après (navigateur piloté).

---

## Risques

1. **Protocole app-server non documenté** (B1) : le spike tranche avant d'investir ; fallback défini.
2. **Événements rate-limit codex** : existence à confirmer au spike ; fallback estimation locale.
3. **MCP bridge double-spawn** : chaque CLI lance SON process conductor-mcp (stdio) — sans état local, tout l'état vit dans le sidecar via HTTP : OK par construction.
4. **Deltas codex + dédup id (A1)** : l'ordre des tâches (A avant B) garantit que le streaming v2 arrive sur un transport fiable.

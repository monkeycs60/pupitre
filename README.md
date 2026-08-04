# Pupitre

Mission control bureau pour Linux : une app qui pilote **Claude Code** et **Codex CLI** sur tes abonnements (jamais d'API payante), avec discussions par projet, streaming, reprise de session, épinglage et images inline. Le pupitre du chef d'orchestre : l'app dirige les CLIs sans jouer une note elle-même.

## Architecture (M1)

```
┌─────────────────────────────────────────────┐
│  Tauri 2 (Rust minimal)                     │
│  fenêtre native, spawn du sidecar en dev    │
├─────────────────────────────────────────────┤
│  Sidecar Bun/TypeScript (le cerveau)        │
│  stores SQLite · adapters claude/codex      │
│  runner (1 tour = 1 process CLI, resume)    │
│  serveur HTTP+WS · media                    │
├─────────────────────────────────────────────┤
│  Frontend React + Vite (webview)            │
│  sidebar projets · chat streaming ·         │
│  tool cards · lightbox · composer           │
└─────────────────────────────────────────────┘
```

Les deux CLIs sont normalisés en un schéma d'événements unifié (`sidecar/src/events.ts`) ; le frontend ne connaît jamais Claude ou Codex directement. Les sessions sont celles des vrais CLIs (`claude -r`, `codex exec resume`) : reprise gratuite, et tes skills/CLAUDE.md/AGENTS.md marchent tels quels.

## Sous-tâches déléguées (M2-D1)

Une conversation peut déléguer du travail à un autre modèle (le Conductor de la phase D). Le moteur vit dans `sidecar/src/subtasks.ts` :

- `POST /api/subtasks {conversationId, provider, model, effort?, speed?, prompt, label?}` → `201 {id}`, tour lancé en arrière-plan dans le cwd du projet parent, **sans prendre le verrou de conversation** (une sous-tâche tourne délibérément en parallèle du tour parent qui l'a demandée).
- `GET /api/subtasks/:id` → `{status, resultText, subtask}` — `resultText` = concaténation des `text-final`.
- `GET /api/subtasks/:id/events` → replay, et `GET /api/conversations/:id/subtasks` → les sous-tâches d'une conversation.
- Les événements d'une sous-tâche sont stockés dans la table `events` sous **son propre id** : le replay HTTP et le canal `/ws?conversation=<subtaskId>` fonctionnent à l'identique d'une conversation.
- Au lancement, un event `subtask-ref` est appendé à la **conversation parente** : c'est ce qui permet à l'UI d'afficher la carte de sub-agent.

**Limite de concurrence : 4 sous-tâches simultanées par conversation parente** (`MAX_CONCURRENT_SUBTASKS`). Au-delà, l'API répond `429` et c'est à l'appelant (le bridge MCP de D2) de séquencer ses délégations. La limite est par conversation, pas globale : deux conversations peuvent orchestrer en parallèle sans se gêner. Elle protège du fan-out incontrôlé — autant de process CLI, de quota consommé et d'écritures concurrentes dans le même working directory qu'il y a d'appels.

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

## Tests

```bash
cd sidecar && bun test        # 49 tests (fixtures réelles des CLIs, fake bins)
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

**Suite** : M2 orchestration cross-provider (Conductor) + quotas des deux abonnements · M3 Gardien (review à risques) + Débrief + bouton Tester + vue Git · M4 bibliothèque de skills, workflows épinglés, routines, fleet view.

# HANDOFF M2 — état au 2026-08-04 (passation Fable → Codex)

Tu reprends l'exécution du plan `docs/plans/2026-08-04-pupitre-m2-implementation.md`. Lis aussi `README.md` et le design `docs/plans/2026-08-04-pupitre-design.md` (§4, §5, §8). **Conventions non négociables** : TDD, les fixtures de `sidecar/tests/fixtures/` font foi sur les formats, fake bins pour tester sans quota, jamais d'API payante (CLIs sur abonnements), vérifs avant tout commit : `cd sidecar && bun test && bunx tsc --noEmit` ET `cd ui && bunx tsc --noEmit && bun run build`.

## État : fait et commité

| Phase | Contenu | Commits clés |
|---|---|---|
| M1 + M1.1 | Socle complet (voir README) + effort sélectionnable + toggle Vitesse fast codex | jusqu'à `66293b3` |
| M2-A | Events identifiés, merge replay/WS dédupé par id, reconnexion WS backoff + bandeau | `949f5af`, `78ce74a` |
| M2-B | Fixture protocole app-server + `CodexAppServerClient` (process persistant, vrais deltas, rate-limits, resume, timeouts, multiplexing testé) — **validé en réel** | `3d8f6b1`, `cc3bf30`, `a235eb0` |
| M2-C | QuotaTracker (les 2 providers, persisté, GET /api/quotas + WS channel quotas) + UI quotas (jauges, chips par modèle, pulse use-it-or-lose-it, notifs seuils en localStorage) | `8ed3fdd`, `7dc7795` |
| M2-D1 | Moteur de sous-tâches (table subtasks, POST /api/subtasks parallèle au tour parent, subtask-ref, limite 4/conversation, 429) — doc dans README | `cbe7495` |
| M2-D3 | UI cartes de sub-agents (SubtaskCard, EventStream factorisé, fan-out, bouton annuler, indicateur sidebar) | `a90f282` |

**127+ tests verts** au dernier passage complet. Reviews milestone déjà faites (adapters M1, backend M1, A+B M2) : tous les Critical/Important corrigés.

## ⚠️ En vol au moment de la passation

**M2-D2 (bridge MCP conductor)** : ✅ finalement livré, vérifié (140 tests verts) et commité (`e005277`) juste avant la passation — plus rien en vol. Deux restes signalés par l'agent D2 : le **toggle orchestrator dans le formulaire UI** (câblage front simple, la colonne est exposée par GET/POST conversations) et brancher le **bouton ✕ des cartes D3 sur la route cancel** (existante). Points de spec pour référence :
- Outils MCP : `delegate`, `delegate_parallel` (max 4, gère le 429), `check_quotas` ; descriptions d'outils soignées avec la reco « exécution → gpt-5.6-luna effort low/medium speed fast ».
- Câblage par tour si `conversations.orchestrator` (nouvelle colonne, défaut 1) : claude via `--mcp-config` inline ; codex : à trancher selon ce que le process app-server partagé permet par thread (le rapport de l'agent D2 doit documenter son choix).
- **Garde structurelle : les tours de subtasks ne reçoivent jamais le câblage conductor** (pas de délégation récursive). Test obligatoire.
- Bonus attendu : `POST /api/subtasks/:id/cancel` (AbortController) — **la carte UI de D3 appelle déjà cette route**, elle doit exister.

## Reste à faire (dans l'ordre)

1. **Finir/committer D2** (ci-dessus) + jonction avec D3 (le bouton ✕ des cartes → route cancel).
2. **Validation réelle de l'orchestration** (~2 centimes) : sidecar réel, conversation claude sonnet orchestrator, prompt « délègue à gpt-5.6-luna la lecture de demo.txt via l'outil delegate » → vérifier subtask-ref, carte, resultText revenu dans le tour parent.
3. **Review milestone phase D** (agent code-reviewer sur D1+D2+D3, BASE=`7dc7795`) + fixes.
4. **E1 Presets** : table presets (name, provider, model, effort, speed, orchestrator) + défaut par projet + UI (« Éco », « Qualité max », « Vitesse » seedés) + migrer les seuils de quota de localStorage vers la table settings (préparée mais non faite en C2).
5. **E2 Switch de modèle propre** : modale — même provider = update conv + warning cache (estimation = somme usage) ; cross-provider = handoff (tour de résumé de passation, nouvelle conversation `continued_from`, lien sidebar).
6. **F1 E2E + review finale + tag M2** : étendre e2e/basic-flow.md (reconnexion WS — protocole manuel déjà écrit dedans, streaming codex réel, delegate réel, quotas), review finale, tag git `m2`.
7. **F2 Passe design UI** (demande explicite de Clement : « l'UI est vraiment dégueulasse ») : charger le skill frontend-design, refonte visuelle SANS changement de comportement, validation par screenshots avant/après au navigateur. Suggestions déjà notées : clés React stables dans Chat.tsx (ids d'events dispo), compte à rebours sur le bandeau de reconnexion, fraîcheur (`updatedAt`) sur la barre de quotas, `<details>` prompt dans les cartes de subtask, « + N tokens délégués » au pied des tours orchestrés.

## Backlog M2 restant (fin du plan M2, section backlog du plan M1)

Watchdog d'inactivité app-server, fixture paramétrable du fake app-server, transaction appendEvent, coalescing text-delta, sweep en SQL, limite upload media + importBytes, câblage prod Tauri (origin `tauri://localhost`, CSP, sidecar compilé), estimation usedPercent claude (déconseillée — voir rapport C1), fast mode claude headless (à surveiller côté Anthropic).

## Décisions déjà tranchées (ne pas rouvrir)

- `resetsAt` en ISO ; `readRateLimits()` non-spawnant (pas de boot app-server juste pour les jauges).
- Collision threadId dans le client app-server = erreur (pas de file d'attente).
- Approbations app-server : `decision:"accept"` (enum des types générés, pas "approved").
- Sélecteur de modèles en boutons radio avec chips/pulse (pas de retour au select).
- Vitesse fast = codex uniquement (claude n'a pas de fast headless) ; sub-agents ne délèguent pas.
- Un backup de la DB réelle existe : `~/.local/share/pupitre/pupitre.db.bak-avant-m2d1`.

## Infos pratiques

- Remote git configuré ; commits locaux en avance — pousser quand Clement le demande.
- Lancer l'app : `bunx tauri dev`. Sidecar seul : `bun run --cwd sidecar dev` (port 4820). Tester sans quota : `PUPITRE_CLAUDE_BIN`/`PUPITRE_CODEX_BIN` → `sidecar/tests/fake-bins/`.
- Ports de test : toujours vérifier qu'aucun vieux sidecar ne tient 4820 (`fuser -k 4820/tcp`) — un test M2 a déjà été faussé par ça.
- Protocole app-server : types générables par `codex app-server generate-ts --out <dir>` ; constats du spike dans `sidecar/tests/fixtures/README.md`.

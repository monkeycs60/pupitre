# E2E M1 — protocole et résultats (exécuté le 2026-08-04)

Protocole de la Task 17 du plan. Exécution mixte : navigateur piloté (Chrome DevTools MCP) pour le parcours UI, API directe pour les compléments.

## Environnement

```bash
PUPITRE_DATA_DIR=/tmp/pupitre-e2e-data \
PUPITRE_CLAUDE_BIN=$PWD/sidecar/tests/fake-bins/fake-claude \
PUPITRE_CODEX_BIN=$PWD/sidecar/tests/fake-bins/fake-codex \
bun run --cwd sidecar dev
bun run --cwd ui dev
```

## Résultats

| # | Scénario | Résultat |
|---|---|---|
| 1 | Création projet via formulaire UI (`/tmp/pupitre-demo-project`) | ✅ apparaît dans la sidebar, sélectionné |
| 2 | Conversation claude (fake) : streaming, tool card `🔧 Bash` dépliable, usage `18 → 404 tokens` | ✅ tout rendu inline, 0 erreur console |
| 3 | Second message → reprise de session | ✅ tour 2 complet ; `cli_session_id` persisté en DB (vérifié via API) — le tour 2 part en `claude -r <id>` (couvert aussi par les tests unitaires d'args) |
| 4 | Reload de la page → replay | ✅ les deux tours réapparaissent depuis SQLite |
| 5 | Conversation codex (fake, `gpt-5.6-luna`) via API | ✅ session (thread_id), text-final, 2 tool-start, usage, done |
| 6 | Épinglage conversation (`POST /pin` → 204) | ✅ remonte en tête de liste |
| 7 | **Test réel** (sans fake bins) : conversation claude haiku « Lis demo.txt » | ✅ session réelle, `tool-start Read`, réponse `**hello**` (contenu réel du fichier), usage, done |
| 8 | Coquille Tauri (`bunx tauri dev`) | ✅ app native compilée et lancée, sidecar spawné par le hook Rust, tué au kill de l'app |
| 9 | **Test réel codex** (`gpt-5.6-sol`) : tour 1 via sidecar | ✅ session (thread_id), réponse `hello` (contenu réel de demo.txt), done |
| 10 | **Test réel codex resume** via sidecar | ⚠️→✅ échec initial (`resume` ne supporte ni `-C` ni `-s` — risque n°2 du plan confirmé), adapter corrigé (cwd via spawn, sandbox via `-c sandbox_mode`), puis tour 2 réel OK — la réponse `demo.txt` à « quel fichier as-tu lu ? » prouve la vraie reprise de contexte |

Screenshot UI : conservé dans le scratchpad de la session d'implémentation (`pupitre-ui-m1.png`).

## M2-A2 — reconnexion WebSocket (test manuel)

Vérifie le bandeau de reconnexion et le resync du replay après une coupure du sidecar
en plein tour. Le fake claude suffit (aucun quota consommé).

| Étape | Action | Attendu |
|---|---|---|
| 1 | Lancer sidecar + ui (env vars ci-dessus), ouvrir une conversation et envoyer un message long | streaming en cours, pas de bandeau |
| 2 | Pendant le streaming, tuer le sidecar (`Ctrl-C` ou `pkill -f "sidecar.*dev"`) | le bandeau « reconnexion… » apparaît ; les événements déjà reçus restent affichés |
| 3 | Laisser le bandeau ~15 s | les tentatives s'espacent (backoff exponentiel), aucune boucle serrée dans l'onglet Réseau |
| 4 | Relancer le sidecar (mêmes env vars, même `PUPITRE_DATA_DIR`) | le bandeau disparaît en quelques secondes |
| 5 | Observer la conversation | resync : le replay complet est refetché et fusionné par id — aucun doublon, aucun trou ; le tour interrompu se termine en `status: error` (le process CLI est mort avec le sidecar) |
| 6 | Envoyer un nouveau message | tour normal sur la même conversation (reprise via `cli_session_id`) |

Points de contrôle : 0 erreur console autre que l'échec WS attendu à l'étape 2, et
`GET /conversations/:id/events` appelé une seule fois par reconnexion réussie.

## Rejouer le protocole

1. Lancer les deux serveurs avec les env vars ci-dessus.
2. Ouvrir http://localhost:5173, dérouler les scénarios 1-6.
3. Pour le test réel : relancer le sidecar sans les overrides `PUPITRE_*_BIN` (consomme ~1 centime de quota Claude).
4. Pour Tauri : `bunx tauri dev` à la racine (la coquille lance elle-même sidecar + vite).

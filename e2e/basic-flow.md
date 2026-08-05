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

## E2E M2 — streaming, orchestration, quotas et changement de modèle

Exécuté le 2026-08-04. Les parcours déterministes utilisent les fake bins ; les
deux validations provider signalées « réel » ont été jouées sur les abonnements
CLI, sans API payante.

| # | Scénario | Résultat |
|---|---|---|
| 11 | Streaming Codex réel via `codex app-server` (`gpt-5.6-luna`) | ✅ session `threadId`, deltas texte, outils, usage et statut terminal reçus ; reprise du même thread validée |
| 12 | Quotas après un tour provider réel | ✅ notification native Codex normalisée et persistée ; `GET /api/quotas`, flux WS, jauge sidebar et chips modèle cohérents avec la fenêtre publiée (primary hebdomadaire dans la fixture réelle) |
| 13 | Orchestration réelle Claude Sonnet → Codex `gpt-5.6-luna` | ✅ l'outil MCP `delegate` lit `demo.txt`, crée le `subtask-ref`, la carte suit le flux puis affiche le résultat `PUPITRE_M2_DELEGATION_OK`, revenu aussi au tour parent ; subtask `0a429e84-4c05-41cd-996e-20360771000a` |
| 14 | Presets M2 avec fake bins | ✅ les trois presets intégrés sont proposés, un preset personnalisé peut être sauvé/supprimé et le défaut projet est réappliqué à une nouvelle conversation |
| 15 | Switch dans le même provider | ✅ la modale affiche l'estimation de cache (somme des usages), met à jour le modèle et le tour suivant utilise ce modèle sur la même conversation |
| 16 | Handoff cross-provider | ✅ résumé fixe généré sur la conversation source, nouvelle conversation seedée et initialisée chez le provider cible, liens « suite de / continuée par » visibles dans la sidebar |
| 17 | Annulation d'une carte déléguée | ✅ `POST /api/subtasks/:id/cancel`, statut erreur « annulé », capacité de délégation libérée |

### Rejouer les scénarios M2 sans consommer de quota

Utiliser le même environnement que plus haut, en remplaçant le fake Codex CLI
historique par le faux app-server :

```bash
PUPITRE_DATA_DIR=/tmp/pupitre-e2e-m2-data \
PUPITRE_CLAUDE_BIN=$PWD/sidecar/tests/fake-bins/fake-claude \
PUPITRE_CODEX_BIN=$PWD/sidecar/tests/fake-bins/fake-codex-app-server \
bun run --cwd sidecar dev
bun run --cwd ui dev
```

1. Créer un projet et deux conversations, une par provider.
2. Envoyer deux messages dans la conversation Codex ; contrôler le streaming,
   la reprise (`cli_session_id`) et l'apparition du quota après le premier tour.
3. Créer puis sélectionner un preset personnalisé, le définir par défaut et
   ouvrir une nouvelle conversation ; les paramètres doivent être restaurés.
4. Dans une conversation existante, changer de modèle du même provider ; la
   modale doit conserver la conversation et annoncer le coût de cache estimé.
5. Choisir un modèle de l'autre provider ; la modale doit créer une passation et
   la sidebar doit relier les deux conversations.

### Rejouer l'orchestration réelle

Cette étape consomme du quota CLI provider. Lancer le sidecar sans overrides,
créer une conversation Claude Sonnet avec l'orchestration active, puis envoyer :

> Délègue à gpt-5.6-luna la lecture de demo.txt via l'outil delegate.

Contrôler dans l'ordre : appel `delegate`, événement `subtask-ref`, carte Codex
en cours puis terminée, contenu réel du fichier dans `resultText`, et reprise de
ce résultat dans la réponse finale du parent. Ne pas relancer ce test lorsque le
quota Claude de la session est épuisé ; le résultat réel ci-dessus fait foi.

## F2 — validation visuelle

Passe réalisée au viewport 1440 × 1000 avec les mêmes données avant/après.

- Avant : [`pupitre-m2-before-f2.png`](./pupitre-m2-before-f2.png)
- Après, conversation : [`pupitre-m2-after-f2.png`](./pupitre-m2-after-f2.png)
- Après, création : [`pupitre-m2-after-f2-new-conversation.png`](./pupitre-m2-after-f2-new-conversation.png)
- Après, reconnexion : [`pupitre-m2-after-f2-reconnecting.png`](./pupitre-m2-after-f2-reconnecting.png)

Contrôles : navigation et fil lisibles, presets/modèles accessibles, compteur de
reconnexion visible puis retiré après resync, fraîcheur des quotas affichée, et
aucune erreur console après reprise. La capture de reconnexion a été obtenue en
coupant uniquement le sidecar temporaire puis en le relançant sur la même base.

## E2E M3 — Gardien, Débrief, Git et Tester

Exécuté le 2026-08-05 sans consommer de quota provider. Un smoke a été piloté
dans le vrai frontend avec `agent-browser`; les cas d'erreur, de concurrence et
de données structurées sont complétés par les tests d'intégration Bun. Les fake
bins M3 répondent aux prompts Gardien, Débrief et Tester de façon déterministe.

| # | Scénario | Validation | Résultat |
|---|---|---|---|
| 18 | Création projet + conversation Codex | Navigateur | ✅ formulaire, conversation, streaming fake et cartes outils rendus sans appel provider réel |
| 19 | Vue Git | Navigateur + intégration | ✅ branches, commits et comparaison visibles ; worktrees, provenance, borne 2 Mio et parent HEAD couverts en intégration |
| 20 | Review Gardien du travail courant | Navigateur + intégration | ✅ défaut `CONVERSATION → WORKTREE`, diff thermique affiché et review propre ; portée multi-commits, staged/unstaged/nouveaux fichiers, ancrage et lecture bornée couverts en intégration |
| 21 | Acquittement et contre-avis | Intégration | ✅ décisions ciblées, mode bloquant, provider opposé et option automatique rouge ; ce sous-parcours n'a pas été cliqué dans le smoke faute de flag volontaire |
| 22 | Bouton Tester | Navigateur + intégration | ✅ inventaire, choix et exécution du scope jusqu'au statut `RÉUSSI` dans le fil ; preuves tête/fin, captures et acquittement atomique couverts en intégration |
| 23 | Débrief et handoff | Navigateur + intégration | ✅ Débrief généré et rendu dans le fil ; seed cross-provider, rollback et nettoyage au redémarrage d'une continuation incomplète couverts en intégration |
| 24 | Reprise après interruption | Intégration | ✅ reviews et scopes `running` orphelins sont clôturés ; un Débrief incomplet ne crée aucune ligne persistée ; les continuations de handoff en attente sont supprimées au boot |

Capture du smoke : [`pupitre-m3-gardien.png`](./pupitre-m3-gardien.png).

Validation rejouée avant chaque commit M3 :

```bash
cd sidecar && bun test && bunx tsc --noEmit
cd ui && bunx tsc --noEmit && bun run build
```

Résultat de clôture : **263 tests sidecar passent**, typechecks sidecar/UI verts et
build Vite réussi. Aucun test Claude réel n'a été relancé : la session Claude de
l'utilisateur était à court de crédits ; les fixtures et fake bins font foi pour
ce jalon.

### Rejouer les parcours M3 sans quota

Utiliser l'environnement fake M2 ci-dessus, puis :

1. Créer un projet pointant vers un dépôt Git avec au moins un commit, modifier
   un fichier et ouvrir une conversation rattachée au projet.
2. Lancer « Review Gardien », ouvrir le diff thermique, acquitter un point puis
   demander un contre-avis. Vérifier qu'aucune validation globale n'est proposée.
3. Lancer « Reprendre le contrôle », questionner le débrief puis effectuer une
   passation vers l'autre provider ; la nouvelle conversation doit citer le bilan.
4. Ouvrir l'onglet Git, sélectionner deux références et afficher leur diff ; les
   commits liés à la conversation et les alertes Gardien restent visibles.
5. Cliquer « Tester », choisir un scope et l'exécuter ; le statut, les sorties,
   les captures et le verdict doivent mettre à jour la même carte dans le fil.
   Quitter ensuite la conversation pendant une exécution : à son terme, le badge
   et la vue Gardien doivent refléter l'acquittement sans rouvrir le fil source.

Les équivalents déterministes se trouvent dans `tests/reviews.test.ts`,
`tests/debriefs.test.ts`, `tests/git.test.ts`, `tests/testing.test.ts` et
`tests/server.test.ts`.

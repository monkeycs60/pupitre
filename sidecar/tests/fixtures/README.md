# Fixtures réelles — référence des formats

**Ces fichiers font foi** pour les parsers (`claude-parser.ts`, `codex-parser.ts`). Si une mise à jour de CLI change le format : ré-enregistrer, mettre à jour ce README, adapter les parsers.

Enregistrées le 2026-08-04 avec :
- `claude` 2.1.221 (Claude Code)
- `codex-cli` 0.144.5

`review-scan-codex.jsonl` est la capture d'un vrai scan Gardien avec
`gpt-5.6-sol`, effort `high`, sandbox `read-only`, sur le diff minimal
`console.log("configuration prête")` → `console.log(process.env.SECRET)`.

## claude-basic.jsonl

Commande (depuis un dossier vide `/tmp/pupitre-fixture`) :
```bash
claude -p --output-format stream-json --include-partial-messages --verbose \
  --model haiku "Réponds exactement: BONJOUR PUPITRE. Puis liste les fichiers du dossier courant."
```

Champs observés (76 lignes) :
- Session : `{"type":"system","subtype":"init",...,"session_id":"...","model":"..."}`. Attention : de nombreux autres events `system` existent (`subtype":"hook_started"` etc.) — ne matcher que `init`.
- Deltas streaming : `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}`. Existe aussi `thinking_delta`, `input_json_delta`, `signature_delta` — à ignorer en M1.
- Messages consolidés : `{"type":"assistant","message":{"content":[{"type":"text"|"tool_use"|"thinking",...}]}}` (ignorer les blocks `thinking`).
- Résultats d'outils : `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","content":...}]}}`.
- Fin : `{"type":"result","subtype":"success",...,"usage":{"input_tokens":...,"output_tokens":...}}`.
- **Bonus pour M2 (QuotaTracker)** : un event `rate_limit_event` apparaît dans le flux — introspection de quota native, à exploiter plus tard.

## codex-basic.jsonl

Commande :
```bash
codex exec --json --skip-git-repo-check -s read-only -m gpt-5.6-luna \
  "Réponds exactement: BONJOUR PUPITRE. Puis liste les fichiers du dossier courant."
```

Champs observés (10 lignes) :
- Session : `{"type":"thread.started","thread_id":"<uuid>"}` → c'est l'id pour `codex exec resume <id>`.
- Turn : `{"type":"turn.started"}` … `{"type":"turn.completed","usage":{"input_tokens":...,"cached_input_tokens":...,"output_tokens":...,"reasoning_output_tokens":...}}`.
- Items : `{"type":"item.started"|"item.completed","item":{"id":"item_N","type":"agent_message"|"command_execution"|"error",...}}`.
  - `agent_message` : champ `text`.
  - `command_execution` : champs `command`, `aggregated_output`, `exit_code`, `status`.
  - `error` : bénin (ex : warning budget skills) — à mapper en no-op ou log, pas en échec.
- `gpt-5.6-luna` est un id de modèle valide. `codex exec` exige un répertoire trusted (repo git) ou `--skip-git-repo-check`, et **stdin doit être fermé** (`</dev/null`) sinon il attend l'EOF.

## codex-app-server-basic.jsonl (spike M2-B1, 2026-08-04)

Trafic JSON-RPC réel (newline-delimited sur stdio, champ `dir` = out/in ajouté par le spike) de `codex app-server`. Constats :
- Handshake : `initialize` (clientInfo) → notification `initialized` → `thread/start` {model, cwd, approvalPolicy:"never"} → réponse avec `threadId` → `turn/start` {threadId, input:[{type:"text",text}]}.
- **Vrais deltas** : notifications `item/agentMessage/delta` (23 dans la fixture) — le streaming token par token que `exec --json` n'a pas.
- Items : `item/started`/`item/completed` ; approbations via requêtes serveur `item/*/requestApproval` auxquelles il faut répondre.
- **Quotas natifs** : `account/rateLimits/updated` (spontané) et `account/rateLimits/read` (pollable) → `{rateLimits:{primary:{usedPercent, windowDurationMins, resetsAt},…}}`. `windowDurationMins:10080` = fenêtre 7 jours.
- Usage : `thread/tokenUsage/updated`. Fin de tour : `turn/completed`/`turn/failed`. Reprise : `thread/resume` {threadId}.
- `thread/start` accepte aussi `serviceTier` (fast mode natif).
- Protocole auto-documenté : `codex app-server generate-ts --out <dir>` (types v2 dans `v2/`).

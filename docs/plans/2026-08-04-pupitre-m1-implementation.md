# Pupitre M1 (Socle) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **Contrainte d'exécution (demande de Clement)** : quand des sous-tâches sont déléguées à des sub-agents de dev, utiliser **GPT-5.6 Sol high via Codex CLI** (`codex exec -m gpt-5.6-sol -c model_reasoning_effort="high"`), pas Fable.

**Goal:** Le socle de Pupitre : app Tauri 2 + sidecar Bun + UI React qui permet de créer des projets (dossiers de code), d'y mener des conversations streamées avec Claude Code ou Codex CLI (sur abonnements), de reprendre une session, d'épingler, et de voir les images inline.

**Architecture:** Un sidecar Bun/TypeScript expose HTTP+WebSocket sur localhost ; il pilote les CLIs en headless (un process par tour utilisateur : premier tour crée la session CLI, tours suivants la resument) et normalise leurs JSONL en un schéma d'événements unifié persisté en SQLite. Le frontend React (Vite) consomme uniquement ce schéma. La coquille Tauri (Rust minimal) spawne le sidecar et affiche la webview.

**Tech Stack:** Bun 1.3 (serveur, `bun:sqlite`, `bun:test`), TypeScript, React 18 + Vite, react-markdown, Tauri 2 (plugins shell/dialog), CLIs : `claude` 2.x (`-p --output-format stream-json --include-partial-messages`, `-r <session_id>`), `codex` 0.144 (`exec --json`, `exec resume <id>`, `-i <img>`, `-C <dir>`, `-m <model>`).

**Modèle par tour (décision clé):** on ne garde PAS un process CLI vivant par conversation. Chaque tour utilisateur = une invocation CLI qui se termine (`claude -p` puis `claude -p -r <id>` ; `codex exec` puis `codex exec resume <id>`). La reprise d'une conversation (aujourd'hui ou dans une semaine) est donc le même code que le tour n°2. Les sessions sont persistées par les CLIs eux-mêmes.

**Non-goals M1** (viennent en M2/M3) : orchestration/Conductor, quotas, Gardien, Débrief, Tester, bibliothèque de skills, approbations interactives (M1 tourne en `--permission-mode acceptEdits` / `-s workspace-write`), tray/autostart, packaging.

---

## Conventions globales

- Racine repo : `~/Desktop/pupitre`. Workspaces Bun : `sidecar/`, `ui/`. Tauri : `src-tauri/`.
- Données : `$PUPITRE_DATA_DIR` (défaut `~/.local/share/pupitre`) → `pupitre.db`, `media/`.
- Binaires CLI overridables pour les tests : `$PUPITRE_CLAUDE_BIN` (défaut `claude`), `$PUPITRE_CODEX_BIN` (défaut `codex`).
- Port sidecar : `4820` (`$PUPITRE_PORT`).
- Tests : `bun test` depuis `sidecar/`. Chaque test crée un DATA_DIR temporaire.
- Commits fréquents, messages `feat:/test:/chore:`, co-author `Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Scaffold du workspace

**Files:**
- Create: `package.json`, `sidecar/package.json`, `sidecar/tsconfig.json`, `.gitignore`, `sidecar/src/index.ts`, `sidecar/tests/smoke.test.ts`

**Step 1: Fichiers racine**

`package.json` :
```json
{
  "name": "pupitre",
  "private": true,
  "workspaces": ["sidecar", "ui"]
}
```

`.gitignore` :
```
node_modules/
dist/
src-tauri/target/
*.log
```

**Step 2: Package sidecar**

`sidecar/package.json` :
```json
{
  "name": "@pupitre/sidecar",
  "private": true,
  "type": "module",
  "scripts": { "dev": "bun run --watch src/index.ts", "test": "bun test" }
}
```

`sidecar/tsconfig.json` :
```json
{
  "compilerOptions": {
    "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "types": ["bun-types"], "noEmit": true
  }
}
```

`sidecar/src/index.ts` :
```ts
console.log("pupitre sidecar: bootstrap ok");
```

**Step 3: Test fumigène**

`sidecar/tests/smoke.test.ts` :
```ts
import { test, expect } from "bun:test";

test("bun:test fonctionne", () => {
  expect(1 + 1).toBe(2);
});
```

**Step 4: Vérifier**

Run: `cd ~/Desktop/pupitre && bun install && cd sidecar && bun test`
Expected: `1 pass`

**Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold workspace bun (sidecar)"
```

---

### Task 2: Enregistrer des fixtures réelles des deux CLIs

Les parsers seront écrits contre des transcripts RÉELS, pas contre une doc. C'est la tâche la plus importante du plan : si le format observé diffère des exemples des Tasks 6/8, **les fixtures font foi** et on adapte le code, pas l'inverse.

**Files:**
- Create: `sidecar/tests/fixtures/claude-basic.jsonl`, `sidecar/tests/fixtures/codex-basic.jsonl`, `sidecar/tests/fixtures/README.md`

**Step 1: Fixture Claude (coûte ~1 centime de quota, une fois)**

```bash
mkdir -p /tmp/pupitre-fixture && cd /tmp/pupitre-fixture
claude -p --output-format stream-json --include-partial-messages --verbose \
  --model haiku "Réponds exactement: BONJOUR PUPITRE. Puis liste les fichiers du dossier courant." \
  > ~/Desktop/pupitre/sidecar/tests/fixtures/claude-basic.jsonl
```

Vérifier : `head -c 500 ~/Desktop/pupitre/sidecar/tests/fixtures/claude-basic.jsonl` doit montrer un event `{"type":"system","subtype":"init",...,"session_id":"..."}`.

**Step 2: Fixture Codex**

```bash
cd /tmp/pupitre-fixture
codex exec --json -s read-only -m gpt-5.6-luna \
  "Réponds exactement: BONJOUR PUPITRE. Puis liste les fichiers du dossier courant." \
  > ~/Desktop/pupitre/sidecar/tests/fixtures/codex-basic.jsonl
```

Vérifier que le JSONL contient un identifiant de session/thread (chercher `grep -oE '"(thread_id|session_id|conversation_id)"' codex-basic.jsonl | sort -u`) et un event final avec l'usage de tokens. Si `-m gpt-5.6-luna` est refusé, lancer `codex exec --json "..."` sans `-m` et noter le modèle par défaut dans le README des fixtures.

**Step 3: Documenter**

`sidecar/tests/fixtures/README.md` : noter la version des CLIs (`claude --version`, `codex --version`), la commande exacte utilisée, et les noms de champs observés pour : id de session, texte assistant, delta de streaming, tool call, usage. **Ces noms de champs sont la référence pour les Tasks 6 et 8.**

**Step 4: Commit**

```bash
git add sidecar/tests/fixtures && git commit -m "test: fixtures réelles claude stream-json + codex exec --json"
```

---

### Task 3: Schéma d'événements unifié

**Files:**
- Create: `sidecar/src/events.ts`, `sidecar/tests/events.test.ts`

**Step 1: Test d'abord**

`sidecar/tests/events.test.ts` :
```ts
import { test, expect } from "bun:test";
import { parseJsonlLine } from "../src/events";

test("parseJsonlLine parse une ligne valide", () => {
  expect(parseJsonlLine('{"type":"x","a":1}')).toEqual({ type: "x", a: 1 });
});

test("parseJsonlLine renvoie null sur ligne vide ou invalide", () => {
  expect(parseJsonlLine("")).toBeNull();
  expect(parseJsonlLine("not json")).toBeNull();
});
```

**Step 2: Vérifier l'échec** — `bun test tests/events.test.ts` → FAIL (module absent).

**Step 3: Implémenter**

`sidecar/src/events.ts` :
```ts
// Schéma unifié : la SEULE surface que le frontend et le stockage connaissent.
export type AppEvent =
  | { type: "session"; provider: Provider; cliSessionId: string; model: string }
  | { type: "user-message"; text: string; images: string[] } // images = chemins media relatifs
  | { type: "text-delta"; text: string }
  | { type: "text-final"; text: string }
  | { type: "tool-start"; toolId: string; toolName: string; input: unknown }
  | { type: "tool-end"; toolId: string; output: string; images: string[] }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "status"; state: "running" | "done" | "error"; error?: string };

export type Provider = "claude" | "codex";

export function parseJsonlLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const v = JSON.parse(trimmed);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
```

**Step 4: Vérifier** — `bun test tests/events.test.ts` → PASS.

**Step 5: Commit** — `git add -A && git commit -m "feat: schéma d'événements unifié + parse JSONL"`

---

### Task 4: DB SQLite + ProjectStore

**Files:**
- Create: `sidecar/src/db.ts`, `sidecar/src/stores/projects.ts`, `sidecar/tests/projects.test.ts`

**Step 1: Test d'abord**

`sidecar/tests/projects.test.ts` :
```ts
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";

let store: ProjectStore;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-test-"));
  store = new ProjectStore(openDb(dir));
});

test("crée et liste un projet", () => {
  const p = store.create({ name: "spoilguard", path: "/home/clement/Desktop/spoilguard" });
  expect(p.id).toBeString();
  expect(store.list()).toHaveLength(1);
  expect(store.list()[0].name).toBe("spoilguard");
});

test("refuse un path en doublon", () => {
  store.create({ name: "a", path: "/tmp/x" });
  expect(() => store.create({ name: "b", path: "/tmp/x" })).toThrow();
});

test("épingle et désépingle", () => {
  const p = store.create({ name: "a", path: "/tmp/y" });
  store.setPinned(p.id, true);
  expect(store.list()[0].pinned).toBe(true);
});
```

**Step 2: Vérifier l'échec** — `bun test tests/projects.test.ts` → FAIL.

**Step 3: Implémenter**

`sidecar/src/db.ts` :
```ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function dataDir(): string {
  return process.env.PUPITRE_DATA_DIR ?? join(homedir(), ".local/share/pupitre");
}

export function openDb(dir: string = dataDir()): Database {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "media"), { recursive: true });
  const db = new Database(join(dir, "pupitre.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
      pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      cli_session_id TEXT, pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_conv ON events(conversation_id, id);
  `);
  return db;
}
```

`sidecar/src/stores/projects.ts` :
```ts
import type { Database } from "bun:sqlite";

export interface Project {
  id: string; name: string; path: string;
  permission_mode: string; pinned: boolean; created_at: string;
}

export class ProjectStore {
  constructor(private db: Database) {}

  create(input: { name: string; path: string }): Project {
    const id = crypto.randomUUID();
    this.db.query(
      "INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)"
    ).run(id, input.name, input.path, new Date().toISOString());
    return this.get(id)!;
  }

  get(id: string): Project | null {
    const row = this.db.query("SELECT * FROM projects WHERE id = ?").get(id) as any;
    return row ? { ...row, pinned: !!row.pinned } : null;
  }

  list(): Project[] {
    const rows = this.db.query(
      "SELECT * FROM projects ORDER BY pinned DESC, created_at DESC"
    ).all() as any[];
    return rows.map((r) => ({ ...r, pinned: !!r.pinned }));
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.query("UPDATE projects SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }
}
```

**Step 4: Vérifier** — `bun test tests/projects.test.ts` → 3 pass.

**Step 5: Commit** — `git commit -am "feat: sqlite + ProjectStore"`

---

### Task 5: ConversationStore + EventStore

**Files:**
- Create: `sidecar/src/stores/conversations.ts`, `sidecar/tests/conversations.test.ts`

**Step 1: Test d'abord**

`sidecar/tests/conversations.test.ts` :
```ts
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";

let convs: ConversationStore;
let projectId: string;
beforeEach(() => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-test-")));
  projectId = new ProjectStore(db).create({ name: "p", path: "/tmp/p" }).id;
  convs = new ConversationStore(db);
});

test("crée une conversation avec titre dérivé du premier message", () => {
  const c = convs.create({ projectId, provider: "claude", model: "opus", firstMessage: "Corrige le bug du lightbox sur mobile s'il te plaît" });
  expect(c.title).toBe("Corrige le bug du lightbox sur mobile s'il te p…");
  expect(c.cli_session_id).toBeNull();
});

test("appendEvent + listEvents rejouent dans l'ordre", () => {
  const c = convs.create({ projectId, provider: "claude", model: "opus", firstMessage: "x" });
  convs.appendEvent(c.id, { type: "text-delta", text: "a" });
  convs.appendEvent(c.id, { type: "text-delta", text: "b" });
  expect(convs.listEvents(c.id).map((e: any) => e.text)).toEqual(["a", "b"]);
});

test("setCliSessionId persiste pour la reprise", () => {
  const c = convs.create({ projectId, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x" });
  convs.setCliSessionId(c.id, "abc-123");
  expect(convs.get(c.id)!.cli_session_id).toBe("abc-123");
});
```

**Step 2: Vérifier l'échec** — FAIL.

**Step 3: Implémenter**

`sidecar/src/stores/conversations.ts` :
```ts
import type { Database } from "bun:sqlite";
import type { AppEvent, Provider } from "../events";

export interface Conversation {
  id: string; project_id: string; title: string; provider: Provider;
  model: string; cli_session_id: string | null; pinned: boolean;
  created_at: string; updated_at: string;
}

const TITLE_MAX = 47;

export class ConversationStore {
  constructor(private db: Database) {}

  create(input: { projectId: string; provider: Provider; model: string; firstMessage: string }): Conversation {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = input.firstMessage.length > TITLE_MAX
      ? input.firstMessage.slice(0, TITLE_MAX) + "…"
      : input.firstMessage;
    this.db.query(
      `INSERT INTO conversations (id, project_id, title, provider, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.projectId, title, input.provider, input.model, now, now);
    return this.get(id)!;
  }

  get(id: string): Conversation | null {
    const row = this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as any;
    return row ? { ...row, pinned: !!row.pinned } : null;
  }

  listByProject(projectId: string): Conversation[] {
    const rows = this.db.query(
      "SELECT * FROM conversations WHERE project_id = ? ORDER BY pinned DESC, updated_at DESC"
    ).all(projectId) as any[];
    return rows.map((r) => ({ ...r, pinned: !!r.pinned }));
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.query("UPDATE conversations SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }

  setCliSessionId(id: string, cliSessionId: string): void {
    this.db.query("UPDATE conversations SET cli_session_id = ?, updated_at = ? WHERE id = ?")
      .run(cliSessionId, new Date().toISOString(), id);
  }

  appendEvent(conversationId: string, event: AppEvent): void {
    this.db.query("INSERT INTO events (conversation_id, payload, created_at) VALUES (?, ?, ?)")
      .run(conversationId, JSON.stringify(event), new Date().toISOString());
    this.db.query("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), conversationId);
  }

  listEvents(conversationId: string): AppEvent[] {
    const rows = this.db.query(
      "SELECT payload FROM events WHERE conversation_id = ? ORDER BY id"
    ).all(conversationId) as any[];
    return rows.map((r) => JSON.parse(r.payload));
  }
}
```

**Step 4: Vérifier** — 3 pass. (Ajuster l'assertion du titre si le compte de caractères diffère : la règle est `slice(0, 47) + "…"`.)

**Step 5: Commit** — `git commit -am "feat: ConversationStore + EventStore avec replay ordonné"`

---

### Task 6: ClaudeAdapter — parser stream-json → AppEvent

⚠️ Les noms de champs ci-dessous correspondent au format stream-json connu de Claude Code 2.x. **Vérifier chaque nom contre `tests/fixtures/claude-basic.jsonl` (Task 2) avant d'écrire le code ; la fixture fait foi.**

**Files:**
- Create: `sidecar/src/adapters/claude-parser.ts`, `sidecar/tests/claude-parser.test.ts`

**Step 1: Test d'abord — piloté par la fixture réelle**

`sidecar/tests/claude-parser.test.ts` :
```ts
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeLine } from "../src/adapters/claude-parser";
import type { AppEvent } from "../src/events";

function eventsFromFixture(): AppEvent[] {
  const raw = readFileSync(join(import.meta.dir, "fixtures/claude-basic.jsonl"), "utf8");
  return raw.split("\n").flatMap((line) => parseClaudeLine(line));
}

test("émet un event session avec le session_id de la fixture", () => {
  const session = eventsFromFixture().find((e) => e.type === "session");
  expect(session).toBeDefined();
  expect((session as any).cliSessionId.length).toBeGreaterThan(10);
  expect((session as any).provider).toBe("claude");
});

test("émet du texte contenant BONJOUR PUPITRE", () => {
  const text = eventsFromFixture()
    .filter((e) => e.type === "text-final")
    .map((e: any) => e.text).join("");
  expect(text).toContain("BONJOUR PUPITRE");
});

test("émet au moins un tool-start (le ls de la fixture) et l'usage final", () => {
  const evts = eventsFromFixture();
  expect(evts.some((e) => e.type === "tool-start")).toBe(true);
  const usage = evts.find((e) => e.type === "usage") as any;
  expect(usage.outputTokens).toBeGreaterThan(0);
  const status = evts.filter((e) => e.type === "status").at(-1) as any;
  expect(status.state).toBe("done");
});
```

**Step 2: Vérifier l'échec** — FAIL.

**Step 3: Implémenter**

`sidecar/src/adapters/claude-parser.ts` (à ajuster contre la fixture) :
```ts
import { parseJsonlLine, type AppEvent } from "../events";

// Une ligne stream-json Claude peut produire 0..n AppEvents.
export function parseClaudeLine(line: string): AppEvent[] {
  const obj = parseJsonlLine(line);
  if (!obj) return [];
  const out: AppEvent[] = [];

  switch (obj.type) {
    case "system": {
      if (obj.subtype === "init" && typeof obj.session_id === "string") {
        out.push({
          type: "session", provider: "claude",
          cliSessionId: obj.session_id, model: String(obj.model ?? ""),
        });
      }
      break;
    }
    case "stream_event": {
      // --include-partial-messages : SSE Anthropic brut dans obj.event
      const ev = obj.event as any;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        out.push({ type: "text-delta", text: ev.delta.text });
      }
      break;
    }
    case "assistant": {
      const content = (obj.message as any)?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          out.push({ type: "text-final", text: block.text });
        } else if (block.type === "tool_use") {
          out.push({ type: "tool-start", toolId: block.id, toolName: block.name, input: block.input });
        }
      }
      break;
    }
    case "user": {
      const content = (obj.message as any)?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_result") {
          out.push({
            type: "tool-end", toolId: block.tool_use_id,
            output: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
            images: [],
          });
        }
      }
      break;
    }
    case "result": {
      const usage = obj.usage as any;
      if (usage) {
        out.push({
          type: "usage",
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
        });
      }
      out.push(
        obj.subtype === "success"
          ? { type: "status", state: "done" }
          : { type: "status", state: "error", error: String(obj.subtype) }
      );
      break;
    }
  }
  return out;
}
```

**Step 4: Vérifier** — `bun test tests/claude-parser.test.ts` → PASS. Si un test échoue, inspecter la fixture (`grep '"type"' fixtures/claude-basic.jsonl | sort | uniq -c`) et corriger le parser, pas le test.

**Step 5: Commit** — `git commit -am "feat: parser claude stream-json vers événements unifiés (fixture-driven)"`

---

### Task 7: ClaudeAdapter — runner (spawn + resume)

**Files:**
- Create: `sidecar/src/adapters/types.ts`, `sidecar/src/adapters/claude.ts`, `sidecar/tests/fake-bins/fake-claude`, `sidecar/tests/claude-adapter.test.ts`

**Step 1: Faux binaire pour tester sans quota**

`sidecar/tests/fake-bins/fake-claude` (puis `chmod +x`) :
```bash
#!/usr/bin/env bash
# Rejoue la fixture ; enregistre les args reçus pour les assertions.
echo "$@" > "${FAKE_CLAUDE_ARGS_FILE:-/dev/null}"
cat "$(dirname "$0")/../fixtures/claude-basic.jsonl"
```

**Step 2: Test d'abord**

`sidecar/tests/claude-adapter.test.ts` :
```ts
import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runClaudeTurn } from "../src/adapters/claude";
import type { AppEvent } from "../src/events";

const FAKE = join(import.meta.dir, "fake-bins/fake-claude");

async function collect(opts: Parameters<typeof runClaudeTurn>[0]): Promise<AppEvent[]> {
  const events: AppEvent[] = [];
  await runClaudeTurn(opts, (e) => events.push(e));
  return events;
}

test("premier tour : pas de -r, événements émis, status done", async () => {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-")), "args");
  process.env.PUPITRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  const events = await collect({ cwd: "/tmp", model: "opus", prompt: "salut", cliSessionId: null, permissionMode: "acceptEdits", images: [] });
  const args = readFileSync(argsFile, "utf8");
  expect(args).not.toContain("-r ");
  expect(args).toContain("--output-format stream-json");
  expect(events.some((e) => e.type === "session")).toBe(true);
  expect((events.at(-1) as any).state).toBe("done");
});

test("tour suivant : ajoute -r <sessionId>", async () => {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-")), "args");
  process.env.PUPITRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  await collect({ cwd: "/tmp", model: "opus", prompt: "suite", cliSessionId: "abc-123", permissionMode: "acceptEdits", images: [] });
  expect(readFileSync(argsFile, "utf8")).toContain("-r abc-123");
});

test("binaire introuvable → status error, pas d'exception", async () => {
  process.env.PUPITRE_CLAUDE_BIN = "/nonexistent/claude";
  const events = await collect({ cwd: "/tmp", model: "opus", prompt: "x", cliSessionId: null, permissionMode: "acceptEdits", images: [] });
  expect((events.at(-1) as any).state).toBe("error");
});
```

**Step 3: Vérifier l'échec** — FAIL.

**Step 4: Implémenter**

`sidecar/src/adapters/types.ts` :
```ts
import type { AppEvent } from "../events";

export interface TurnOptions {
  cwd: string;
  model: string;
  prompt: string;
  cliSessionId: string | null; // null = premier tour
  permissionMode: string;
  images: string[]; // chemins absolus d'images jointes par l'utilisateur
}

export type EmitFn = (event: AppEvent) => void;
```

`sidecar/src/adapters/claude.ts` :
```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseClaudeLine } from "./claude-parser";
import type { TurnOptions, EmitFn } from "./types";

export function runClaudeTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
  return new Promise((resolve) => {
    const bin = process.env.PUPITRE_CLAUDE_BIN ?? "claude";
    // M1 : les images utilisateur sont référencées par chemin dans le prompt.
    // (Claude Code lit les fichiers image du disque via son outil Read.)
    const prompt = opts.images.length
      ? `${opts.prompt}\n\n[Images jointes: ${opts.images.join(", ")}]`
      : opts.prompt;
    const args = [
      "-p", "--output-format", "stream-json", "--include-partial-messages",
      "--verbose", "--model", opts.model, "--permission-mode", opts.permissionMode,
    ];
    if (opts.cliSessionId) args.push("-r", opts.cliSessionId);
    args.push(prompt);

    emit({ type: "status", state: "running" });
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let sawTerminal = false;

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      for (const event of parseClaudeLine(line)) {
        if (event.type === "status") sawTerminal = true;
        emit(event);
      }
    });

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      emit({ type: "status", state: "error", error: String(err) });
      resolve();
    });
    child.on("close", (code) => {
      if (!sawTerminal) {
        emit(code === 0
          ? { type: "status", state: "done" }
          : { type: "status", state: "error", error: stderr.slice(-2000) || `exit ${code}` });
      }
      resolve();
    });
  });
}
```

**Step 5: Vérifier** — 3 pass. **Step 6: Commit** — `git commit -am "feat: ClaudeAdapter runner avec resume et fake bin de test"`

---

### Task 8: CodexAdapter — parser + runner

Même patron que Tasks 6-7. ⚠️ **La fixture `codex-basic.jsonl` fait foi** pour les noms d'événements (`thread.started`/`session_configured`, `item.completed`, `turn.completed`…) — les inspecter avant d'écrire le parser.

**Files:**
- Create: `sidecar/src/adapters/codex-parser.ts`, `sidecar/src/adapters/codex.ts`, `sidecar/tests/fake-bins/fake-codex`, `sidecar/tests/codex-parser.test.ts`, `sidecar/tests/codex-adapter.test.ts`

**Step 1: Tests parser (mêmes assertions que Task 6, adaptées)** : event `session` avec id extrait de la fixture (`provider: "codex"`), texte contenant `BONJOUR PUPITRE`, un `tool-start` (commande shell exécutée), `usage` > 0, dernier `status` = `done`.

**Step 2: Implémenter `codex-parser.ts`** sur le modèle de `claude-parser.ts` : mapper l'event de démarrage de session → `session` ; les items de type message agent → `text-final` (et deltas si la fixture en contient) ; les items d'exécution de commande → `tool-start`/`tool-end` (toolName `"shell"`, l'output tronqué à 10 000 caractères) ; l'event de fin de turn → `usage` + `status done`.

**Step 3: `fake-codex`** : même script bash que `fake-claude`, rejouant `codex-basic.jsonl`, args enregistrés dans `$FAKE_CODEX_ARGS_FILE`.

**Step 4: Tests runner** (`codex-adapter.test.ts`) :
- premier tour → args contiennent `exec --json -C <cwd> -m <model>` et PAS `resume` ;
- tour suivant (`cliSessionId: "abc-123"`) → args contiennent `exec resume abc-123` (⚠️ vérifier avec `codex exec resume --help` si `--json`/`-C` restent valides sur le subcommand ; ajuster l'ordre des args en conséquence) ;
- images jointes → args contiennent `-i <path>` pour chaque image ;
- binaire introuvable → `status error`.

**Step 5: Implémenter `codex.ts`** :
```ts
// construction des args :
const base = opts.cliSessionId
  ? ["exec", "resume", opts.cliSessionId]
  : ["exec"];
const args = [...base, "--json", "-C", opts.cwd, "-m", opts.model,
  "-s", "workspace-write",
  ...opts.images.flatMap((img) => ["-i", img]),
  opts.prompt];
```
Le reste (spawn, readline, sawTerminal, gestion d'erreur) est identique à `claude.ts` — factoriser le squelette commun dans `sidecar/src/adapters/spawn-jsonl.ts` si la duplication dépasse ~30 lignes (DRY, mais seulement une fois les deux qui marchent).

**Step 6: Vérifier** — tous les tests passent. **Commit** — `git commit -am "feat: CodexAdapter parser + runner (exec --json / exec resume)"`

---

### Task 9: MediaStore — images sur disque

**Files:**
- Create: `sidecar/src/media.ts`, `sidecar/tests/media.test.ts`

**Step 1: Test d'abord**

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaStore } from "../src/media";

test("importe un fichier image et renvoie un nom servable", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pupitre-"));
  const src = join(dataDir, "shot.png");
  writeFileSync(src, "fake-png-bytes");
  const store = new MediaStore(dataDir);
  const name = store.importFile(src);
  expect(name).toMatch(/^[0-9a-f-]+\.png$/);
  expect(existsSync(store.absolutePath(name))).toBe(true);
});

test("importFromBase64 écrit le fichier décodé", () => {
  const store = new MediaStore(mkdtempSync(join(tmpdir(), "pupitre-")));
  const name = store.importFromBase64(Buffer.from("hello").toString("base64"), "png");
  expect(Bun.file(store.absolutePath(name)).size).toBe(5);
});
```

**Step 2: Échec vérifié, puis implémenter**

`sidecar/src/media.ts` :
```ts
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

export class MediaStore {
  private dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "media");
    mkdirSync(this.dir, { recursive: true });
  }
  importFile(absPath: string): string {
    const name = crypto.randomUUID() + (extname(absPath) || ".png");
    copyFileSync(absPath, join(this.dir, name));
    return name;
  }
  importFromBase64(b64: string, ext: string): string {
    const name = `${crypto.randomUUID()}.${ext}`;
    writeFileSync(join(this.dir, name), Buffer.from(b64, "base64"));
    return name;
  }
  absolutePath(name: string): string {
    if (name.includes("/") || name.includes("..")) throw new Error("nom media invalide");
    return join(this.dir, name);
  }
}
```

**Step 3: PASS, commit** — `git commit -am "feat: MediaStore images"`

---

### Task 10: ConversationRunner — cycle de vie d'un tour

**Files:**
- Create: `sidecar/src/runner.ts`, `sidecar/tests/runner.test.ts`

**Step 1: Test d'abord** (avec les fake bins)

```ts
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";
import { MediaStore } from "../src/media";
import { ConversationRunner } from "../src/runner";
import type { AppEvent } from "../src/events";

let runner: ConversationRunner;
let convs: ConversationStore;
let projectId: string;
let broadcast: AppEvent[];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-"));
  const db = openDb(dir);
  projectId = new ProjectStore(db).create({ name: "p", path: "/tmp" }).id;
  convs = new ConversationStore(db);
  broadcast = [];
  process.env.PUPITRE_CLAUDE_BIN = join(import.meta.dir, "fake-bins/fake-claude");
  runner = new ConversationRunner(convs, new ProjectStore(db), new MediaStore(dir),
    (convId, e) => broadcast.push(e));
});

test("un tour persiste user-message + événements, capture le session id, diffuse en live", async () => {
  const c = convs.create({ projectId, provider: "claude", model: "haiku", firstMessage: "salut" });
  await runner.runTurn(c.id, "salut", []);
  const stored = convs.listEvents(c.id);
  expect(stored[0]).toMatchObject({ type: "user-message", text: "salut" });
  expect(stored.some((e) => e.type === "session")).toBe(true);
  expect(convs.get(c.id)!.cli_session_id).not.toBeNull();
  expect(broadcast.length).toBeGreaterThan(2); // le live a diffusé au fil de l'eau
});

test("deux tours simultanés sur la même conversation → le second est refusé", async () => {
  const c = convs.create({ projectId, provider: "claude", model: "haiku", firstMessage: "x" });
  const p1 = runner.runTurn(c.id, "a", []);
  await expect(runner.runTurn(c.id, "b", [])).rejects.toThrow("déjà en cours");
  await p1;
});
```

**Step 2: Échec vérifié, puis implémenter**

`sidecar/src/runner.ts` :
```ts
import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import type { MediaStore } from "./media";
import type { AppEvent } from "./events";
import { runClaudeTurn } from "./adapters/claude";
import { runCodexTurn } from "./adapters/codex";

type BroadcastFn = (conversationId: string, event: AppEvent) => void;

export class ConversationRunner {
  private active = new Set<string>();

  constructor(
    private convs: ConversationStore,
    private projects: ProjectStore,
    private media: MediaStore,
    private broadcast: BroadcastFn,
  ) {}

  isRunning(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  async runTurn(conversationId: string, prompt: string, imageNames: string[]): Promise<void> {
    if (this.active.has(conversationId)) throw new Error("un tour est déjà en cours");
    const conv = this.convs.get(conversationId);
    if (!conv) throw new Error("conversation inconnue");
    const project = this.projects.get(conv.project_id)!;
    this.active.add(conversationId);

    const emit = (event: AppEvent) => {
      if (event.type === "session") this.convs.setCliSessionId(conversationId, event.cliSessionId);
      this.convs.appendEvent(conversationId, event);
      this.broadcast(conversationId, event);
    };

    try {
      emit({ type: "user-message", text: prompt, images: imageNames });
      const opts = {
        cwd: project.path, model: conv.model, prompt,
        cliSessionId: conv.cli_session_id,
        permissionMode: project.permission_mode,
        images: imageNames.map((n) => this.media.absolutePath(n)),
      };
      if (conv.provider === "claude") await runClaudeTurn(opts, emit);
      else await runCodexTurn(opts, emit);
    } finally {
      this.active.delete(conversationId);
    }
  }
}
```

**Step 3: PASS, commit** — `git commit -am "feat: ConversationRunner (tour = un process CLI, resume auto)"`

---

### Task 11: Serveur HTTP + WebSocket

**Files:**
- Create: `sidecar/src/server.ts`, Modify: `sidecar/src/index.ts`, Create: `sidecar/tests/server.test.ts`

**API :**

| Méthode | Route | Corps → Réponse |
|---|---|---|
| GET | `/api/health` | → `{ok:true}` |
| GET | `/api/projects` | → `Project[]` |
| POST | `/api/projects` | `{name,path}` → `Project` (400 si path inexistant sur disque) |
| POST | `/api/projects/:id/pin` | `{pinned}` → 204 |
| GET | `/api/projects/:id/conversations` | → `Conversation[]` |
| POST | `/api/conversations` | `{projectId,provider,model,message,images?}` → `Conversation` (crée PUIS lance le 1er tour en async) |
| POST | `/api/conversations/:id/messages` | `{message,images?}` → 202 (409 si tour en cours) |
| POST | `/api/conversations/:id/pin` | `{pinned}` → 204 |
| GET | `/api/conversations/:id/events` | → `AppEvent[]` (replay complet) |
| POST | `/api/media` | body binaire image → `{name}` |
| GET | `/media/:name` | → bytes de l'image |
| WS | `/ws?conversation=<id>` | reçoit chaque AppEvent JSON en live |

**Step 1: Tests d'abord** (`server.test.ts`, via `fetch` sur un serveur démarré sur port 0) : création projet (+ 400 sur path inexistant), création conversation avec fake bin → attendre le status done via WS, replay `GET /events` non vide et commençant par `user-message`, 409 si message pendant un tour, upload media puis GET media redonne les bytes.

**Step 2: Implémenter** avec `Bun.serve` (routes manuelles sur `URL.pathname`, `server.upgrade` pour le WS, un `Map<conversationId, Set<WebSocket>>` pour le broadcast). `index.ts` assemble : `openDb()` → stores → `MediaStore` → `ConversationRunner` (broadcast = envoyer aux sockets abonnés) → `Bun.serve({port: env.PUPITRE_PORT ?? 4820})`, et loggue `pupitre sidecar prêt sur http://localhost:4820`.

**Step 3: PASS, commit** — `git commit -am "feat: serveur HTTP+WS du sidecar"`

---

### Task 12: UI — scaffold Vite React + client API

**Files:**
- Create: `ui/` via `bun create vite ui --template react-ts`, puis `ui/src/api.ts`, `ui/src/useConversationEvents.ts`

**Step 1: Scaffold**

```bash
cd ~/Desktop/pupitre && bun create vite ui --template react-ts
cd ui && bun install && bun add react-markdown
```

Dans `ui/vite.config.ts`, ajouter le proxy dev :
```ts
server: { proxy: { "/api": "http://localhost:4820", "/media": "http://localhost:4820", "/ws": { target: "ws://localhost:4820", ws: true } } }
```

**Step 2: Client API** (`ui/src/api.ts`) : fonctions `fetch` typées pour chaque route de la Task 11 (types `Project`, `Conversation`, `AppEvent` copiés dans `ui/src/types.ts` — M1 assume la duplication, un package partagé viendra quand ça bougera).

**Step 3: Hook live** (`ui/src/useConversationEvents.ts`) :
```ts
// Charge le replay via GET /events puis s'abonne au WS ;
// déduplique le raccord replay/live par simple longueur (le WS n'envoie que du nouveau).
export function useConversationEvents(conversationId: string | null): AppEvent[]
```
États internes : `events: AppEvent[]`. Au changement d'id : reset, fetch replay, ouvrir `new WebSocket(`ws://${location.host}/ws?conversation=${id}`)`, append chaque message. Cleanup : fermer le socket.

**Step 4: Vérifier** — `bun run dev` (ui) + `bun run dev` (sidecar) → la page Vite par défaut s'affiche sans erreur console.

**Step 5: Commit** — `git commit -am "feat: scaffold UI vite react + client api + hook événements live"`

---

### Task 13: UI — sidebar projets & conversations

**Files:**
- Create: `ui/src/App.tsx` (réécrit), `ui/src/Sidebar.tsx`

**Comportement :**
- Colonne gauche : liste des projets (épinglés en premier, icône 📌 toggle au clic droit ou bouton), bouton « + Projet » → mini-formulaire nom + chemin (input texte en M1 ; le folder-picker natif arrive avec Tauri en Task 16).
- Sous le projet sélectionné : ses conversations (épinglées en premier, 📌 toggle), bouton « + Conversation ».
- Sélectionner une conversation → la vue chat (Task 14) à droite. État `selectedProject` / `selectedConversation` dans `App.tsx` (useState, pas de router en M1).

**Vérifier** : créer un projet pointant sur un vrai dossier, le voir listé, l'épingler → remonte en tête après refresh.

**Commit** — `git commit -am "feat: sidebar projets + conversations avec épinglage"`

---

### Task 14: UI — vue chat (streaming, tool cards, images inline + lightbox)

**Files:**
- Create: `ui/src/Chat.tsx`, `ui/src/EventView.tsx`, `ui/src/Lightbox.tsx`

**Rendu du flux d'événements** (le cœur visuel de M1) :
- Regrouper la séquence brute en « blocs » : un `user-message` = bulle utilisateur (avec miniatures de ses images) ; les `text-delta` consécutifs s'accumulent dans la bulle assistante courante jusqu'au `text-final` (qui la remplace — source de vérité) ; `tool-start`/`tool-end` = carte repliée « 🔧 toolName » dépliable (input + output en `<pre>`, max-height scrollable).
- **Images inline** : tout event portant `images: [...]` rend des `<img src={/media/${name}}>` (max-width 100%) cliquables → `Lightbox` plein écran (overlay, clic ou Échap pour fermer).
- Markdown : bulles assistantes rendues avec `react-markdown`.
- `status running` → indicateur « ● en cours » ; `status error` → bandeau rouge avec le message ; `usage` → discret en pied de tour (« 1 234 → 567 tokens »).
- Autoscroll en bas tant que l'utilisateur n'a pas scrollé vers le haut.

**Vérifier** (test manuel avec fake bin) : `PUPITRE_CLAUDE_BIN=.../fake-claude bun run dev` → créer une conversation → le texte de la fixture apparaît, la carte tool se déplie, le statut passe à done.

**Commit** — `git commit -am "feat: vue chat avec streaming, tool cards, images inline + lightbox"`

---

### Task 15: UI — composer (envoi, sélecteur provider/modèle, collage d'images)

**Files:**
- Create: `ui/src/Composer.tsx`, Modify: `ui/src/Chat.tsx`

**Comportement :**
- Textarea (Entrée = envoyer, Shift+Entrée = retour ligne), désactivée avec « tour en cours… » quand le dernier status est `running`.
- À la création d'une conversation : sélecteur provider/modèle — options M1 en constantes : `claude: ["fable-5", "opus", "sonnet", "haiku"]`, `codex: ["gpt-5.6-sol", "gpt-5.6-luna"]` (vérifier les ids codex acceptés avec `codex exec -m <id>` ; corriger les constantes si besoin). Provider+modèle sont figés ensuite (le switch propre, c'est M2).
- **Collage d'image** : handler `onPaste` → si `clipboardData.items` contient une image, POST `/api/media`, miniature affichée dans le composer, noms passés dans `images` à l'envoi.
- 409 du serveur → toast « un tour est déjà en cours ».

**Vérifier** : envoyer un message avec image collée via fake bin → la bulle user montre la miniature, lightbox OK.

**Commit** — `git commit -am "feat: composer avec sélection modèle et collage d'images"`

---

### Task 16: Coquille Tauri 2

**Files:**
- Create: `src-tauri/` via CLI, Modify: `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, `ui/src/Sidebar.tsx` (folder picker)

**Step 1: Init**

```bash
cd ~/Desktop/pupitre
cargo install tauri-cli --version "^2" --locked   # si pas déjà installé
cargo tauri init --app-name Pupitre --window-title Pupitre \
  --dev-url http://localhost:5173 --frontend-dist ../ui/dist \
  --before-dev-command "bun run --cwd ui dev" --before-build-command "bun run --cwd ui build"
```

**Step 2: Spawn du sidecar au démarrage**

Dans `src-tauri/src/lib.rs`, hook `setup` : spawner `bun run --cwd <repo>/sidecar src/index.ts` en dev (chemin résolu depuis `CARGO_MANIFEST_DIR`), tuer le child au `on_window_event::Destroyed`. En M1 le packaging du sidecar en binaire embarqué (`bun build --compile` + externalBin) est hors périmètre — documenter ce choix en commentaire.

**Step 3: Folder picker natif**

```bash
cargo tauri add dialog
cd ui && bun add @tauri-apps/plugin-dialog
```
Dans `Sidebar.tsx` : si `window.__TAURI__` existe, le bouton « + Projet » ouvre `open({directory: true})` et préremplit nom (basename) + chemin ; sinon fallback input texte (mode navigateur conservé pour le dev).

**Step 4: Vérifier**

Run: `cargo tauri dev` (sidecar lancé à part la première fois si le spawn Rust n'est pas prêt)
Expected: fenêtre native Pupitre, création de projet via dialog natif, conversation fake bin fonctionnelle.

**Step 5: Commit** — `git commit -am "feat: coquille tauri 2 (spawn sidecar, folder picker natif)"`

---

### Task 17: E2E de bout en bout avec fake bins

**Files:**
- Create: `e2e/basic-flow.md` (protocole) — automatisation Playwright optionnelle en M1

**Protocole (exécuté avec la skill webapp-testing ou à la main) :**
1. `PUPITRE_CLAUDE_BIN=…/fake-claude PUPITRE_CODEX_BIN=…/fake-codex PUPITRE_DATA_DIR=$(mktemp -d) bun run --cwd sidecar dev` + `bun run --cwd ui dev`.
2. Créer un projet → conversation claude → vérifier streaming, tool card, done.
3. Envoyer un second message → vérifier que le fake a reçu `-r` (session reprise).
4. Recharger la page → replay complet intact (reprise après fermeture).
5. Conversation codex → mêmes vérifications.
6. Épingler projet + conversation → ordre correct après reload.
7. **Test réel final (consomme du quota, une fois)** : sans overrides, une conversation claude haiku réelle « liste les fichiers » sur un vrai projet → streaming réel OK.

**Commit** — `git commit -am "test: protocole e2e M1"`

---

### Task 18: README + clôture M1

**Files:**
- Create: `README.md` (racine)

Contenu : pitch une phrase, architecture (schéma du design §2), prérequis (bun, rust, webkit2gtk-4.1, CLIs authentifiés), démarrage dev (3 commandes), lancement des tests, lien vers le design et ce plan, périmètre M1 vs suite (M2 orchestration+quotas).

**Vérifier** : `bun test` complet vert depuis `sidecar/`, `cargo tauri dev` fonctionnel.

**Commit** — `git commit -am "docs: README M1"`

---

## Récap risques (à garder en tête pendant l'exécution)

1. **Formats JSONL** : tout repose sur les fixtures de la Task 2. En cas de doute, la fixture fait foi ; re-enregistrer si une mise à jour de CLI change le format (noter la version dans fixtures/README.md).
2. **`codex exec resume` + `--json`** : vérifier que les flags globaux s'appliquent au subcommand (Task 8, Step 4).
3. **Ids de modèles codex** (`gpt-5.6-sol`, `gpt-5.6-luna`) : à valider une fois en réel (Task 15).
4. **Spawn sidecar depuis Rust** : si capricieux en dev, fallback documenté = lancer le sidecar à la main (`bun run dev`), le durcissement vient avec le packaging (M2+).

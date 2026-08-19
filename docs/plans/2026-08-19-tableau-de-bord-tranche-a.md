# Tableau de bord — tranche A (tickets ClickUp + GitLab, reprise de branche) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Une vue **Tableau de bord** par projet qui liste mes tickets (`TECH-XXXXX` ou branche) avec leur état ClickUp, leur MR GitLab, leur pipeline, leur déploiement testing/preprod et leurs conversations Pupitre, et qui permet de **Démarrer / Reprendre** une conversation sur la branche du ticket avec un brief des conversations sœurs injecté.

**Architecture:** Le sidecar gagne des **intégrations par projet** (`project_integrations`), deux clients HTTP déterministes (`integrations/clickup.ts`, `integrations/gitlab.ts`), un `IntegrationsRefresher` (patron `QuotaRefresher`) qui rapproche tâches, MR, pipelines et déploiements par **clé de ticket** extraite de la branche (`ticket-key.ts`) dans `tickets` / `ticket_refs`, et publie un payload `dashboard` sur un canal WS `tickets`. `POST /api/conversations` accepte `ticketId`, relie la conversation, et passe au `ConversationRunner` un **préambule** (brief de reprise) ajouté au prompt provider sans toucher au message stocké. Le front ajoute `DashboardView` (grille CSS à colonnes conditionnelles, patron `CostsView` + `FleetView`), le hook `useDashboard` (patron `useFleet`), une entrée Rail/palette, un groupement par ticket dans la sidebar et une section **Intégrations** dans les réglages projet. Aucun appel LLM dans la relève.

**Tech Stack:** Bun + SQLite (`sidecar/`), React 19 + Vite (`ui/`). Tests : `cd sidecar && bun test`, `cd ui && bun test`, `cd ui && bunx tsc --noEmit`.

**Design validé :** `docs/plans/2026-08-19-tableau-de-bord-design.md` (vocabulaire dans `CONTEXT.md`). Ce plan ne couvre que la tranche A : pas de domaines, pas de Notion, pas de Répétitions, pas de Sentry.

**Constats API vérifiés le 2026-08-19 (à ne pas redécouvrir) :**
- ClickUp v2 : `GET /api/v2/user` → `{user:{id}}` ; `GET /api/v2/team/{teamId}/task?assignees[]=ID&list_ids[]=…&include_closed=false&subtasks=true&page=N` → `{tasks:[…], last_page:bool}` ; une tâche : `id`, `custom_id` (= `TECH-24657`), `name`, `status:{status,color,type}`, `url`, `date_updated` (**epoch ms en string**), `list:{id,name}`, `priority:{priority,color}|null`, `assignees[]`, `custom_fields[]` ; `GET /api/v2/task/{id}` → description dans `description` ; `GET /api/v2/task/{id}/comment` → `{comments:[{id, comment_text, user:{username}, date}]}` du plus récent au plus ancien. Auth : header `Authorization: <token>` (format `pk_…`). **`CLICKUP_API_TOKEN` n'existe pas sur la machine** : le token vient des réglages Pupitre.
- GitLab `https://git.kaizen-hosting.com/api/v4` : token dans `~/.config/glab-cli/config.yml` sous `hosts: { git.kaizen-hosting.com: { token: glpat-… } }` (mode 0600) ; header `PRIVATE-TOKEN`. Moi : `id 123`, `username clement.serizay`. Projets : **reactor = `Affilae/symfony` (id 187)**, **hapigator = `Affilae/hapigator` (id 290)**. `GET projects/{id}/merge_requests?state=opened&scope=all&per_page=50` → `iid,title,source_branch,target_branch,state,web_url,updated_at,draft,has_conflicts,detailed_merge_status,labels[],author{username},reviewers[{username}],assignees[]` — **sans `head_pipeline`** ; pipeline via `GET projects/{id}/merge_requests/{iid}/pipelines?per_page=1` → `[{id,status,web_url,updated_at,ref,sha}]`. Environnements : `GET projects/{id}/environments?search=<nom>&states=available` (liste **sans** `last_deployment`), puis `GET projects/{id}/environments/{envId}` → `last_deployment:{ref:"refs/merge-requests/<iid>/head", sha, status, created_at, user:{username}, deployable:{name:"deploy:preprod", status, web_url}}`. Noms reactor : `preprod` (283), `preprod_testing` (408), `testing2` (476), `preprod_testing_3` (480), `preprod_testing_4` (506). Hapigator : **0 environnement**, déploiement manuel par la devops. Labels de projet reactor : `deploy:preprod`, `deploy:testing`, `deploy:testing_2`, `deploy:testing_3`. Pas de header de rate-limit.
- Convention de branche affilae-mono : `^(issue|maintenance|feature)/(TECH-\d+)` ; titres de MR `TECH-XXXXX / …`.

**Règles du dépôt à respecter (CLAUDE.md) :**
- Ne jamais lancer `bun run dev:sidecar` depuis une conversation Pupitre ; pour recharger le sidecar après un changement backend : `pkill -f "sidecar/src/index.ts"` (il sort 143, Tauri le relance). Vérifier avant que rien ne tourne : `curl -s localhost:4820/api/fleet` doit montrer aucun tour actif.
- Vérifier l'UI dans le navigateur (`http://localhost:5173`) avec Claude in Chrome : compter les éléments dans le DOM, joindre une capture.
- Un commit par tâche, message en français, sans changements hors périmètre. Pas de commentaire qui paraphrase le code.
- `sidecar/tests/workspace-cwd.test.ts` refuse tout nouveau site qui figerait son cwd sur `project.path` : utiliser `conversationCwd(project, conversation)`.
- `ui/src/deadCss.test.ts` échoue si une classe CSS déclarée n'est utilisée nulle part dans les `.tsx`.

---

## Vue d'ensemble des tâches

| # | Tâche | Couche |
|---|---|---|
| 1 | Schéma : `project_integrations`, `tickets`, `ticket_refs`, `ticket_notes`, `conversations.ticket_id` | sidecar |
| 2 | `ticket-key.ts` : extraction de la clé de ticket depuis une branche (pur) | sidecar |
| 3 | `stores/integrations.ts` : `IntegrationStore` (config, statut, snapshot) | sidecar |
| 4 | `stores/tickets.ts` : `TicketStore` (upsert, refs, notes, archivage, liaison conversation) | sidecar |
| 5 | `integrations/clickup.ts` : client + parseurs purs | sidecar |
| 6 | `integrations/gitlab.ts` : client (token glab), parseurs purs | sidecar |
| 7 | `integrations/refresher.ts` : `IntegrationsRefresher` (relève, rapprochement, statut, listeners) | sidecar |
| 8 | Routes : tokens dans `settings`, `/api/projects/:id/integrations`, `/api/projects/:id/dashboard`, `/refresh`, notes, canal WS `tickets` | sidecar |
| 9 | `ticket-brief.ts` + `ticketId` sur `POST /api/conversations` + préambule dans `runTurn` | sidecar |
| 10 | `pupitre-mcp` : outil `read_sibling_conversation` + route `/api/conversations/:id/brief` | sidecar |
| 11 | UI : types, `api.ts`, `useDashboard` (WS) | ui |
| 12 | UI : `DashboardView` + CSS + Rail + App + palette | ui |
| 13 | UI : Démarrer / Reprendre → Composer pré-rempli (branche + ticket) ; préservation de la branche au changement de preset | ui |
| 14 | UI : sidebar groupée par ticket | ui |
| 15 | UI : section Intégrations (réglages projet) + tokens (réglages app) | ui |
| 16 | Docs : README, `docs/help/tableau-de-bord.md` | docs |
| 17 | Vérification navigateur de bout en bout + capture | vérif |

---

### Task 1 : Schéma

**Files:**
- Modify: `sidecar/src/db.ts` (bloc `db.exec` des `CREATE TABLE`, avant la ligne `PRAGMA foreign_keys = ON` des migrations, ~l.279 ; puis un `addColumn` dans la zone des migrations ~l.300-310)
- Test: `sidecar/tests/db-tickets.test.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";

function tables(db: ReturnType<typeof openDb>): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

test("crée les tables du Tableau de bord et la colonne ticket_id", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-db-tickets-")));
  const names = tables(db);
  expect(names).toEqual(expect.arrayContaining(["project_integrations", "tickets", "ticket_refs", "ticket_notes"]));
  const columns = (db.query("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map((c) => c.name);
  expect(columns).toContain("ticket_id");
});

test("une clé de ticket est unique par projet", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-db-tickets-")));
  db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'p', '/tmp/p1', '2026-01-01')").run();
  const insert = db.query(
    "INSERT INTO tickets (id, project_id, key, source, title, status, external_url, updated_at, created_at) VALUES (?, 'p1', 'TECH-1', 'clickup', 't', 'open', NULL, '2026-01-01', '2026-01-01')",
  );
  insert.run("t1");
  expect(() => insert.run("t2")).toThrow();
});
```

> Si `projects` exige d'autres colonnes NOT NULL (vérifier `PRAGMA table_info(projects)` dans `db.ts`), compléter l'INSERT en conséquence — l'intention du test est la contrainte `UNIQUE(project_id, key)`.

**Step 2: Run test to verify it fails**

Run: `cd sidecar && bun test tests/db-tickets.test.ts`
Expected: FAIL — `project_integrations` absent de la liste.

**Step 3: Write minimal implementation**

Dans le bloc `db.exec(\`…\`)` de `openDb`, après la table `debriefs` (~l.110), ajouter :

```sql
    CREATE TABLE IF NOT EXISTS project_integrations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('clickup', 'gitlab', 'github', 'notion', 'sentry')),
      config_json TEXT NOT NULL DEFAULT '{}',
      branch_pattern TEXT NULL,
      status TEXT NOT NULL DEFAULT 'non configurée'
        CHECK (status IN ('ok', 'dégradée', 'hors ligne', 'non configurée', 'à reconfigurer')),
      last_ok_at TEXT NULL,
      last_error TEXT NULL,
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, type)
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('clickup', 'notion', 'git')),
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      external_url TEXT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      last_seen_at TEXT NOT NULL DEFAULT '',
      archived_at TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id, archived_at, updated_at);
    CREATE TABLE IF NOT EXISTS ticket_refs (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('branch', 'mr', 'pipeline', 'deployment', 'sentry_issue')),
      ref TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      seen_at TEXT NOT NULL,
      UNIQUE (ticket_id, kind, ref)
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_refs_ticket ON ticket_refs(ticket_id, kind);
    CREATE TABLE IF NOT EXISTS ticket_notes (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_notes_ticket ON ticket_notes(ticket_id, created_at);
```

Dans la zone des migrations, à côté de `addColumn(db, "conversations", "worktree_path TEXT NULL");` :

```ts
  addColumn(db, "conversations", "ticket_id TEXT NULL REFERENCES tickets(id) ON DELETE SET NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_ticket ON conversations(ticket_id)");
```

> `ALTER TABLE … ADD COLUMN … REFERENCES` est accepté par SQLite tant que la valeur par défaut est NULL. Comme le `PRAGMA foreign_keys` est OFF pendant `openDb`, aucune vérification n'est faite à l'ajout.

**Step 4: Run tests**

Run: `cd sidecar && bun test tests/db-tickets.test.ts && bun test`
Expected: PASS, suite entière verte (les tests existants ouvrent tous `openDb` : une erreur de DDL se verrait partout).

**Step 5: Commit**

```bash
git add sidecar/src/db.ts sidecar/tests/db-tickets.test.ts
git commit -m "feat(tableau-de-bord): schéma des intégrations, tickets, références et notes"
```

---

### Task 2 : `ticket-key.ts`

**Files:**
- Create: `sidecar/src/ticket-key.ts`
- Test: `sidecar/tests/ticket-key.test.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { extractTicketKey, DEFAULT_BRANCH_PATTERN, compileBranchPattern } from "../src/ticket-key";

test("extrait TECH-XXXXX d'une branche affilae-mono", () => {
  const pattern = compileBranchPattern("^(issue|maintenance|feature)/(TECH-\\d+)");
  expect(extractTicketKey("feature/TECH-24657", pattern)).toBe("TECH-24657");
  expect(extractTicketKey("issue/TECH-24868-publisher", pattern)).toBe("TECH-24868");
  expect(extractTicketKey("develop", pattern)).toBeNull();
});

test("la clé est le dernier groupe capturant non vide", () => {
  const pattern = compileBranchPattern("^[a-z]+/([A-Z]+-\\d+)");
  expect(extractTicketKey("feat/ABC-12-truc", pattern)).toBe("ABC-12");
});

test("sans motif, la branche entière est la clé, sauf les branches de base", () => {
  expect(extractTicketKey("feature/foo", null)).toBe("feature/foo");
  expect(extractTicketKey("main", null)).toBeNull();
  expect(extractTicketKey("develop", null)).toBeNull();
  expect(extractTicketKey("master", null)).toBeNull();
});

test("un motif invalide est refusé à la compilation", () => {
  expect(() => compileBranchPattern("(")).toThrow();
});

test("le motif par défaut reconnaît les clés JIRA/ClickUp usuelles", () => {
  const pattern = compileBranchPattern(DEFAULT_BRANCH_PATTERN);
  expect(extractTicketKey("feature/TECH-1", pattern)).toBe("TECH-1");
  expect(extractTicketKey("hotfix/OPS-42-x", pattern)).toBe("OPS-42");
});
```

**Step 2: Run test to verify it fails**

Run: `cd sidecar && bun test tests/ticket-key.test.ts`
Expected: FAIL — module introuvable.

**Step 3: Write minimal implementation**

```ts
/** Motif par défaut : `type/CLE-123…` ; la clé est le dernier groupe capturant. */
export const DEFAULT_BRANCH_PATTERN = "^[a-z]+/([A-Z][A-Z0-9]+-\\d+)";

/** Branches qui ne portent jamais de ticket. */
const BASE_BRANCHES = new Set(["main", "master", "develop", "dev", "staging", "preprod", "production"]);

export function compileBranchPattern(pattern: string): RegExp {
  return new RegExp(pattern, "u");
}

/**
 * Clé de ticket d'une branche. Avec un motif : le dernier groupe capturant
 * non vide, sinon null. Sans motif : la branche elle-même, pour qu'un projet
 * sans gestion de tickets ait quand même des lignes au Tableau de bord.
 */
export function extractTicketKey(branch: string, pattern: RegExp | null): string | null {
  const name = branch.trim();
  if (!name) return null;
  if (pattern === null) return BASE_BRANCHES.has(name) ? null : name;
  const match = name.match(pattern);
  if (!match) return null;
  for (let index = match.length - 1; index >= 1; index -= 1) {
    const group = match[index];
    if (group) return group;
  }
  return null;
}
```

**Step 4: Run tests**

Run: `cd sidecar && bun test tests/ticket-key.test.ts`
Expected: PASS (5 tests).

**Step 5: Commit**

```bash
git add sidecar/src/ticket-key.ts sidecar/tests/ticket-key.test.ts
git commit -m "feat(tableau-de-bord): extraction de la clé de ticket depuis une branche"
```

---

### Task 3 : `IntegrationStore`

**Files:**
- Create: `sidecar/src/stores/integrations.ts`
- Test: `sidecar/tests/integrations-store.test.ts`

**Step 1: Write the failing test**

```ts
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { IntegrationStore } from "../src/stores/integrations";

let store: IntegrationStore;
let projectId: string;

beforeEach(() => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-integrations-")));
  const projects = new ProjectStore(db);
  projectId = projects.create({ name: "mono", path: "/tmp/mono" }).id;
  store = new IntegrationStore(db);
});

test("upsert d'une intégration par (projet, type)", () => {
  const created = store.upsert(projectId, "gitlab", {
    config: { host: "https://git.example", projects: [] },
    branchPattern: "^(issue|feature)/(TECH-\\d+)",
  });
  expect(created.status).toBe("non configurée");
  const updated = store.upsert(projectId, "gitlab", { config: { host: "https://git.other", projects: [] } });
  expect(updated.id).toBe(created.id);
  expect(updated.config).toEqual({ host: "https://git.other", projects: [] });
  expect(updated.branch_pattern).toBe("^(issue|feature)/(TECH-\\d+)");
  expect(store.listByProject(projectId)).toHaveLength(1);
});

test("refuse un motif de branche invalide", () => {
  expect(() => store.upsert(projectId, "clickup", { config: {}, branchPattern: "(" })).toThrow();
});

test("statut, erreur et snapshot", () => {
  const item = store.upsert(projectId, "clickup", { config: { teamId: "1", listIds: [] } });
  store.markOk(item.id, { tasks: 3 });
  expect(store.get(item.id)).toEqual(expect.objectContaining({ status: "ok", last_error: null, snapshot: { tasks: 3 } }));
  store.markError(item.id, "dégradée", "timeout");
  expect(store.get(item.id)).toEqual(expect.objectContaining({ status: "dégradée", last_error: "timeout", snapshot: { tasks: 3 } }));
  store.markError(item.id, "à reconfigurer", "401");
  expect(store.get(item.id)?.status).toBe("à reconfigurer");
});

test("suppression", () => {
  const item = store.upsert(projectId, "clickup", { config: {} });
  expect(store.remove(item.id)).toBe(true);
  expect(store.listByProject(projectId)).toHaveLength(0);
});
```

**Step 2: Run test to verify it fails**

Run: `cd sidecar && bun test tests/integrations-store.test.ts`
Expected: FAIL — module introuvable.

**Step 3: Write minimal implementation**

```ts
import type { Database } from "bun:sqlite";
import { compileBranchPattern } from "../ticket-key";

export type IntegrationType = "clickup" | "gitlab" | "github" | "notion" | "sentry";
export type IntegrationStatus = "ok" | "dégradée" | "hors ligne" | "non configurée" | "à reconfigurer";

export interface ProjectIntegration {
  id: string;
  project_id: string;
  type: IntegrationType;
  config: Record<string, unknown>;
  branch_pattern: string | null;
  status: IntegrationStatus;
  last_ok_at: string | null;
  last_error: string | null;
  /** Dernier état lu (environnements, MR à relire) : survit au redémarrage. */
  snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface IntegrationInput {
  config: Record<string, unknown>;
  branchPattern?: string | null;
}

export class IntegrationStore {
  constructor(private db: Database) {}

  get(id: string): ProjectIntegration | null {
    const row = this.db.query("SELECT * FROM project_integrations WHERE id = ?").get(id) as any;
    return row ? hydrate(row) : null;
  }

  find(projectId: string, type: IntegrationType): ProjectIntegration | null {
    const row = this.db.query("SELECT * FROM project_integrations WHERE project_id = ? AND type = ?")
      .get(projectId, type) as any;
    return row ? hydrate(row) : null;
  }

  listByProject(projectId: string): ProjectIntegration[] {
    const rows = this.db.query("SELECT * FROM project_integrations WHERE project_id = ? ORDER BY type")
      .all(projectId) as any[];
    return rows.map(hydrate);
  }

  listAll(): ProjectIntegration[] {
    return (this.db.query("SELECT * FROM project_integrations ORDER BY project_id, type").all() as any[]).map(hydrate);
  }

  upsert(projectId: string, type: IntegrationType, input: IntegrationInput): ProjectIntegration {
    if (input.branchPattern) compileBranchPattern(input.branchPattern);
    const now = new Date().toISOString();
    const existing = this.find(projectId, type);
    if (existing) {
      this.db.query(
        `UPDATE project_integrations
            SET config_json = ?, branch_pattern = COALESCE(?, branch_pattern), updated_at = ?
          WHERE id = ?`,
      ).run(JSON.stringify(input.config), input.branchPattern ?? null, now, existing.id);
      return this.get(existing.id)!;
    }
    const id = crypto.randomUUID();
    this.db.query(
      `INSERT INTO project_integrations
         (id, project_id, type, config_json, branch_pattern, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'non configurée', ?, ?)`,
    ).run(id, projectId, type, JSON.stringify(input.config), input.branchPattern ?? null, now, now);
    return this.get(id)!;
  }

  markOk(id: string, snapshot?: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.db.query(
      `UPDATE project_integrations
          SET status = 'ok', last_ok_at = ?, last_error = NULL,
              snapshot_json = COALESCE(?, snapshot_json), updated_at = ?
        WHERE id = ?`,
    ).run(now, snapshot ? JSON.stringify(snapshot) : null, now, id);
  }

  markError(id: string, status: Exclude<IntegrationStatus, "ok" | "non configurée">, error: string): void {
    const now = new Date().toISOString();
    this.db.query(
      "UPDATE project_integrations SET status = ?, last_error = ?, updated_at = ? WHERE id = ?",
    ).run(status, error, now, id);
  }

  remove(id: string): boolean {
    return this.db.query("DELETE FROM project_integrations WHERE id = ?").run(id).changes > 0;
  }
}

function hydrate(row: any): ProjectIntegration {
  return {
    id: row.id,
    project_id: row.project_id,
    type: row.type,
    config: JSON.parse(row.config_json ?? "{}"),
    branch_pattern: row.branch_pattern ?? null,
    status: row.status,
    last_ok_at: row.last_ok_at ?? null,
    last_error: row.last_error ?? null,
    snapshot: JSON.parse(row.snapshot_json ?? "{}"),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
```

**Step 4: Run tests**

Run: `cd sidecar && bun test tests/integrations-store.test.ts`
Expected: PASS (4 tests).

**Step 5: Commit**

```bash
git add sidecar/src/stores/integrations.ts sidecar/tests/integrations-store.test.ts
git commit -m "feat(tableau-de-bord): store des intégrations par projet"
```

---

### Task 4 : `TicketStore`

**Files:**
- Create: `sidecar/src/stores/tickets.ts`
- Modify: `sidecar/src/stores/conversations.ts` (interface `Conversation` l.7-30 : ajouter `ticket_id: string | null` ; `create()` l.70-125 : accepter `ticketId?: string | null` et l'insérer ; `listByProject` l.151 : exposer `ticket_key`)
- Test: `sidecar/tests/tickets-store.test.ts`

**Step 1: Write the failing test**

```ts
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";
import { TicketStore } from "../src/stores/tickets";

let tickets: TicketStore;
let conversations: ConversationStore;
let projectId: string;

beforeEach(() => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-tickets-")));
  projectId = new ProjectStore(db).create({ name: "mono", path: "/tmp/mono" }).id;
  conversations = new ConversationStore(db);
  tickets = new TicketStore(db);
});

test("upsert par clé : crée puis met à jour sans changer l'id", () => {
  const a = tickets.upsert(projectId, { key: "TECH-1", source: "clickup", title: "Un", status: "open", externalUrl: "https://x/1" });
  const b = tickets.upsert(projectId, { key: "TECH-1", source: "clickup", title: "Un bis", status: "in progress", externalUrl: "https://x/1" });
  expect(b.id).toBe(a.id);
  expect(b.title).toBe("Un bis");
  expect(b.status).toBe("in progress");
  expect(b.archived_at).toBeNull();
});

test("un ticket git ne réécrit pas le titre d'un ticket clickup existant", () => {
  tickets.upsert(projectId, { key: "TECH-2", source: "clickup", title: "Vrai titre", status: "open", externalUrl: null });
  const again = tickets.upsert(projectId, { key: "TECH-2", source: "git", title: "feature/TECH-2", status: "", externalUrl: null });
  expect(again.source).toBe("clickup");
  expect(again.title).toBe("Vrai titre");
});

test("références : upsert par (kind, ref), payload remplacé, lecture groupée", () => {
  const ticket = tickets.upsert(projectId, { key: "TECH-3", source: "git", title: "b", status: "", externalUrl: null });
  tickets.upsertRef(ticket.id, { kind: "mr", ref: "Affilae/symfony!1862", payload: { status: "opened" } });
  tickets.upsertRef(ticket.id, { kind: "mr", ref: "Affilae/symfony!1862", payload: { status: "merged" } });
  tickets.upsertRef(ticket.id, { kind: "branch", ref: "feature/TECH-3", payload: {} });
  const refs = tickets.refsByTicket(ticket.id);
  expect(refs).toHaveLength(2);
  expect(refs.find((r) => r.kind === "mr")?.payload).toEqual({ status: "merged" });
});

test("archive les tickets non vus depuis 14 jours, réveille ceux revus", () => {
  const old = tickets.upsert(projectId, { key: "TECH-4", source: "git", title: "b", status: "", externalUrl: null });
  tickets.touchSeen(old.id, "2026-01-01T00:00:00.000Z");
  expect(tickets.archiveStale(projectId, new Date("2026-02-01T00:00:00.000Z"))).toBe(1);
  expect(tickets.get(old.id)?.archived_at).not.toBeNull();
  tickets.upsert(projectId, { key: "TECH-4", source: "git", title: "b", status: "", externalUrl: null });
  expect(tickets.get(old.id)?.archived_at).toBeNull();
});

test("notes et liaison de conversation", () => {
  const ticket = tickets.upsert(projectId, { key: "TECH-5", source: "git", title: "b", status: "", externalUrl: null });
  const note = tickets.addNote(ticket.id, "penser au cache");
  expect(tickets.notesByTicket(ticket.id)).toEqual([note]);
  const conversation = conversations.create({ projectId, provider: "claude", model: "m", firstMessage: "x", ticketId: ticket.id });
  expect(conversation.ticket_id).toBe(ticket.id);
  expect(tickets.conversationsByTicket(ticket.id).map((c) => c.id)).toEqual([conversation.id]);
  expect(conversations.listByProject(projectId)[0]?.ticket_key).toBe("TECH-5");
});

test("listByProject rend les tickets actifs avec refs et compteurs", () => {
  const ticket = tickets.upsert(projectId, { key: "TECH-6", source: "clickup", title: "b", status: "open", externalUrl: null });
  tickets.upsertRef(ticket.id, { kind: "branch", ref: "feature/TECH-6", payload: {} });
  conversations.create({ projectId, provider: "claude", model: "m", firstMessage: "x", ticketId: ticket.id });
  const rows = tickets.listByProject(projectId);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.refs).toHaveLength(1);
  expect(rows[0]?.conversations).toHaveLength(1);
});
```

**Step 2: Run test to verify it fails**

Run: `cd sidecar && bun test tests/tickets-store.test.ts`
Expected: FAIL — module introuvable.

**Step 3: Write minimal implementation**

`sidecar/src/stores/tickets.ts` :

```ts
import type { Database } from "bun:sqlite";

export type TicketSource = "clickup" | "notion" | "git";
export type TicketRefKind = "branch" | "mr" | "pipeline" | "deployment" | "sentry_issue";

export interface Ticket {
  id: string;
  project_id: string;
  key: string;
  source: TicketSource;
  title: string;
  status: string;
  external_url: string | null;
  payload: Record<string, unknown>;
  last_seen_at: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketRef {
  id: string;
  ticket_id: string;
  kind: TicketRefKind;
  ref: string;
  payload: Record<string, unknown>;
  seen_at: string;
}

export interface TicketNote {
  id: string;
  ticket_id: string;
  body: string;
  created_at: string;
}

export interface TicketConversationSummary {
  id: string;
  title: string;
  summary: string;
  provider: string;
  updated_at: string;
  worktree_path: string | null;
}

export interface TicketRow extends Ticket {
  refs: TicketRef[];
  conversations: TicketConversationSummary[];
  notes_count: number;
}

export interface TicketInput {
  key: string;
  source: TicketSource;
  title: string;
  status: string;
  externalUrl: string | null;
  payload?: Record<string, unknown>;
}

/** Source la plus informée : une tâche ClickUp/Notion prime sur une branche nue. */
const SOURCE_RANK: Record<TicketSource, number> = { git: 0, notion: 1, clickup: 1 };

export const STALE_TICKET_DAYS = 14;

export class TicketStore {
  constructor(private db: Database) {}

  get(id: string): Ticket | null {
    const row = this.db.query("SELECT * FROM tickets WHERE id = ?").get(id) as any;
    return row ? hydrateTicket(row) : null;
  }

  findByKey(projectId: string, key: string): Ticket | null {
    const row = this.db.query("SELECT * FROM tickets WHERE project_id = ? AND key = ?").get(projectId, key) as any;
    return row ? hydrateTicket(row) : null;
  }

  upsert(projectId: string, input: TicketInput): Ticket {
    const now = new Date().toISOString();
    const existing = this.findByKey(projectId, input.key);
    if (!existing) {
      const id = crypto.randomUUID();
      this.db.query(
        `INSERT INTO tickets (id, project_id, key, source, title, status, external_url, payload_json, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, projectId, input.key, input.source, input.title, input.status, input.externalUrl,
        JSON.stringify(input.payload ?? {}), now, now, now);
      return this.get(id)!;
    }
    const upgrade = SOURCE_RANK[input.source] >= SOURCE_RANK[existing.source];
    if (upgrade) {
      this.db.query(
        `UPDATE tickets SET source = ?, title = ?, status = ?, external_url = ?, payload_json = ?,
                last_seen_at = ?, archived_at = NULL, updated_at = ? WHERE id = ?`,
      ).run(input.source, input.title, input.status, input.externalUrl, JSON.stringify(input.payload ?? {}),
        now, now, existing.id);
    } else {
      this.db.query("UPDATE tickets SET last_seen_at = ?, archived_at = NULL, updated_at = ? WHERE id = ?")
        .run(now, now, existing.id);
    }
    return this.get(existing.id)!;
  }

  touchSeen(id: string, at: string = new Date().toISOString()): void {
    this.db.query("UPDATE tickets SET last_seen_at = ? WHERE id = ?").run(at, id);
  }

  archiveStale(projectId: string, now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - STALE_TICKET_DAYS * 86_400_000).toISOString();
    return this.db.query(
      `UPDATE tickets SET archived_at = ?, updated_at = ?
        WHERE project_id = ? AND archived_at IS NULL AND last_seen_at < ?`,
    ).run(now.toISOString(), now.toISOString(), projectId, cutoff).changes;
  }

  upsertRef(ticketId: string, input: { kind: TicketRefKind; ref: string; payload: Record<string, unknown> }): TicketRef {
    const now = new Date().toISOString();
    this.db.query(
      `INSERT INTO ticket_refs (id, ticket_id, kind, ref, payload_json, seen_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticket_id, kind, ref) DO UPDATE SET payload_json = excluded.payload_json, seen_at = excluded.seen_at`,
    ).run(crypto.randomUUID(), ticketId, input.kind, input.ref, JSON.stringify(input.payload), now);
    return this.db.query("SELECT * FROM ticket_refs WHERE ticket_id = ? AND kind = ? AND ref = ?")
      .get(ticketId, input.kind, input.ref) as any as TicketRef & { payload_json: string }
      ? hydrateRef(this.db.query("SELECT * FROM ticket_refs WHERE ticket_id = ? AND kind = ? AND ref = ?")
        .get(ticketId, input.kind, input.ref))
      : (() => { throw new Error("référence introuvable après upsert"); })();
  }

  refsByTicket(ticketId: string): TicketRef[] {
    return (this.db.query("SELECT * FROM ticket_refs WHERE ticket_id = ? ORDER BY kind, seen_at DESC").all(ticketId) as any[])
      .map(hydrateRef);
  }

  /** Branche(s) connues d'un ticket, la plus récemment vue d'abord. */
  branchesOf(ticketId: string): string[] {
    return this.refsByTicket(ticketId).filter((ref) => ref.kind === "branch").map((ref) => ref.ref);
  }

  addNote(ticketId: string, body: string): TicketNote {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query("INSERT INTO ticket_notes (id, ticket_id, body, created_at) VALUES (?, ?, ?, ?)").run(id, ticketId, body, now);
    return { id, ticket_id: ticketId, body, created_at: now };
  }

  notesByTicket(ticketId: string): TicketNote[] {
    return this.db.query("SELECT * FROM ticket_notes WHERE ticket_id = ? ORDER BY created_at").all(ticketId) as TicketNote[];
  }

  deleteNote(id: string): boolean {
    return this.db.query("DELETE FROM ticket_notes WHERE id = ?").run(id).changes > 0;
  }

  linkConversation(conversationId: string, ticketId: string | null): void {
    this.db.query("UPDATE conversations SET ticket_id = ? WHERE id = ?").run(ticketId, conversationId);
  }

  conversationsByTicket(ticketId: string): TicketConversationSummary[] {
    return this.db.query(
      `SELECT id, title, summary, provider, updated_at, worktree_path FROM conversations
        WHERE ticket_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`,
    ).all(ticketId) as TicketConversationSummary[];
  }

  listByProject(projectId: string): TicketRow[] {
    const rows = this.db.query(
      "SELECT * FROM tickets WHERE project_id = ? AND archived_at IS NULL ORDER BY updated_at DESC",
    ).all(projectId) as any[];
    return rows.map((row) => {
      const ticket = hydrateTicket(row);
      const notes = this.db.query("SELECT COUNT(*) AS n FROM ticket_notes WHERE ticket_id = ?").get(ticket.id) as { n: number };
      return {
        ...ticket,
        refs: this.refsByTicket(ticket.id),
        conversations: this.conversationsByTicket(ticket.id),
        notes_count: notes.n,
      };
    });
  }
}

function hydrateTicket(row: any): Ticket {
  return { ...row, payload: JSON.parse(row.payload_json ?? "{}"), payload_json: undefined, external_url: row.external_url ?? null, archived_at: row.archived_at ?? null };
}

function hydrateRef(row: any): TicketRef {
  return { id: row.id, ticket_id: row.ticket_id, kind: row.kind, ref: row.ref, payload: JSON.parse(row.payload_json ?? "{}"), seen_at: row.seen_at };
}
```

> Simplifie `upsertRef` : après l'`INSERT … ON CONFLICT`, relis la ligne une fois et passe-la à `hydrateRef` (le code ci-dessus montre l'intention ; écris-le en deux lignes propres). Retire la clé `payload_json: undefined` de `hydrateTicket` en déstructurant `const { payload_json, ...rest } = row`.

Dans `stores/conversations.ts` :
- interface `Conversation` : ajouter `ticket_id: string | null;` et `ticket_key?: string | null;` (présent seulement dans `listByProject`).
- `create()` : ajouter `ticketId?: string | null` à l'input, la colonne `ticket_id` dans l'INSERT et `input.ticketId ?? null` dans les valeurs.
- `listByProject` : remplacer `SELECT * FROM conversations WHERE project_id = ?` par
  `SELECT c.*, t.key AS ticket_key FROM conversations c LEFT JOIN tickets t ON t.id = c.ticket_id WHERE c.project_id = ?` (préfixer le prédicat et l'ORDER BY avec `c.`). `get()` ne change pas.

**Step 4: Run tests**

Run: `cd sidecar && bun test tests/tickets-store.test.ts && bun test`
Expected: PASS ; la suite entière reste verte (le `LEFT JOIN` ne change aucune ligne existante).

**Step 5: Commit**

```bash
git add sidecar/src/stores/tickets.ts sidecar/src/stores/conversations.ts sidecar/tests/tickets-store.test.ts
git commit -m "feat(tableau-de-bord): store des tickets, références, notes et liaison conversation"
```

---

### Task 5 : client ClickUp

**Files:**
- Create: `sidecar/src/integrations/clickup.ts`
- Create: `sidecar/tests/fixtures/clickup-tasks.json`
- Test: `sidecar/tests/clickup.test.ts`

**Step 1: Write the fixture and the failing test**

`sidecar/tests/fixtures/clickup-tasks.json` (forme v2 brute, deux tâches) :

```json
{
  "tasks": [
    {
      "id": "86caw5afd",
      "custom_id": "TECH-24657",
      "name": "[Feature] - Ajout de la sélection des leviers",
      "status": { "status": "in progress", "color": "#4466ff", "type": "custom", "orderindex": 11 },
      "url": "https://app.clickup.com/t/86caw5afd",
      "date_updated": "1786716751258",
      "list": { "id": "900500195250", "name": "Features" },
      "priority": { "priority": "normal", "color": "#6fddff" },
      "assignees": [{ "id": 82632460, "username": "Clément Serizay" }],
      "custom_fields": [
        {
          "id": "1f116001-08d8-46a1-9858-c49dc7487cc3",
          "name": "🖥 ️ Service",
          "type": "labels",
          "type_config": { "options": [{ "id": "2dbab653-ee34-4bf9-8101-9b18ee6b0ccf", "label": "API" }, { "id": "7c027756-5a09-4b1c-8fe1-dfbd7c8f797c", "label": "BackOffice" }] },
          "value": ["7c027756-5a09-4b1c-8fe1-dfbd7c8f797c"]
        }
      ]
    },
    {
      "id": "86cb0000x",
      "custom_id": null,
      "name": "Tâche sans custom id",
      "status": { "status": "Open", "color": "#d3d3d3", "type": "open", "orderindex": 0 },
      "url": "https://app.clickup.com/t/86cb0000x",
      "date_updated": "1786716751000",
      "list": { "id": "900100168537", "name": "Bugs" },
      "priority": null,
      "assignees": [],
      "custom_fields": []
    }
  ],
  "last_page": true
}
```

`sidecar/tests/clickup.test.ts` :

```ts
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClickUpClient, parseClickUpTasks, ClickUpAuthError } from "../src/integrations/clickup";

const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/clickup-tasks.json"), "utf8"));

test("parse les tâches v2 en tickets normalisés", () => {
  const tasks = parseClickUpTasks(fixture);
  expect(tasks).toHaveLength(2);
  expect(tasks[0]).toEqual({
    id: "86caw5afd",
    key: "TECH-24657",
    title: "[Feature] - Ajout de la sélection des leviers",
    status: "in progress",
    statusColor: "#4466ff",
    url: "https://app.clickup.com/t/86caw5afd",
    updatedAt: new Date(1786716751258).toISOString(),
    list: "Features",
    priority: "normal",
    labels: ["BackOffice"],
  });
  expect(tasks[1]?.key).toBe("86cb0000x");
});

test("le client pagine jusqu'à last_page et envoie le token en Authorization", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    expect((init?.headers as Record<string, string>).Authorization).toBe("pk_test");
    if (url.endsWith("/user")) return Response.json({ user: { id: 42 } });
    const page = Number(new URL(url).searchParams.get("page"));
    return Response.json(page === 0 ? { ...fixture, last_page: false } : { tasks: [], last_page: true });
  };
  const client = new ClickUpClient("pk_test", fetchImpl);
  expect(await client.me()).toBe(42);
  const tasks = await client.assignedTasks({ teamId: "20556900", listIds: ["900500195250"], userId: 42 });
  expect(tasks).toHaveLength(2);
  expect(calls.filter((url) => url.includes("/team/20556900/task"))).toHaveLength(2);
  expect(calls[1]).toContain("assignees%5B%5D=42");
  expect(calls[1]).toContain("list_ids%5B%5D=900500195250");
});

test("401 devient une ClickUpAuthError", async () => {
  const client = new ClickUpClient("bad", async () => new Response("{}", { status: 401 }));
  await expect(client.me()).rejects.toBeInstanceOf(ClickUpAuthError);
});

test("contexte d'une tâche : description et commentaires récents", async () => {
  const client = new ClickUpClient("pk", async (input) => {
    const url = String(input);
    if (url.endsWith("/comment")) {
      return Response.json({ comments: [{ id: "1", comment_text: "Dernier", user: { username: "Alex" }, date: "1785923853742" }] });
    }
    return Response.json({ id: "86caw5afd", description: "Faire la chose." });
  });
  const context = await client.taskContext("86caw5afd");
  expect(context.description).toBe("Faire la chose.");
  expect(context.comments[0]).toEqual({ author: "Alex", text: "Dernier", at: new Date(1785923853742).toISOString() });
});
```

**Step 2: Run test to verify it fails**

Run: `cd sidecar && bun test tests/clickup.test.ts`
Expected: FAIL — module introuvable.

**Step 3: Write minimal implementation**

```ts
const BASE = "https://api.clickup.com/api/v2";

export class ClickUpAuthError extends Error {}
export class ClickUpHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface ClickUpTask {
  id: string;
  /** `custom_id` (TECH-XXXXX) sinon l'id technique. */
  key: string;
  title: string;
  status: string;
  statusColor: string | null;
  url: string;
  updatedAt: string;
  list: string | null;
  priority: string | null;
  labels: string[];
}

export interface ClickUpTaskContext {
  description: string;
  comments: Array<{ author: string; text: string; at: string }>;
}

function epochMs(value: unknown): string {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date(0).toISOString();
}

/** Valeurs lisibles des champs `labels` (le champ Service, entre autres). */
function labelValues(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];
  const labels: string[] = [];
  for (const field of fields as any[]) {
    if (field?.type !== "labels" || !Array.isArray(field.value)) continue;
    const options: any[] = field.type_config?.options ?? [];
    for (const id of field.value) {
      const option = options.find((item) => item?.id === id);
      if (option?.label) labels.push(String(option.label));
    }
  }
  return labels;
}

export function parseClickUpTasks(payload: unknown): ClickUpTask[] {
  const tasks = (payload as any)?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.map((task: any) => ({
    id: String(task.id),
    key: task.custom_id ? String(task.custom_id) : String(task.id),
    title: String(task.name ?? ""),
    status: String(task.status?.status ?? ""),
    statusColor: task.status?.color ? String(task.status.color) : null,
    url: String(task.url ?? ""),
    updatedAt: epochMs(task.date_updated),
    list: task.list?.name ? String(task.list.name) : null,
    priority: task.priority?.priority ? String(task.priority.priority) : null,
    labels: labelValues(task.custom_fields),
  }));
}

export class ClickUpClient {
  constructor(private token: string, private fetchImpl: typeof fetch = fetch) {}

  private async get(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${BASE}${path}`, {
      headers: { Authorization: this.token, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) throw new ClickUpAuthError(`ClickUp ${response.status}`);
    if (!response.ok) throw new ClickUpHttpError(response.status, `ClickUp ${response.status} sur ${path}`);
    return response.json();
  }

  async me(): Promise<number> {
    const payload = await this.get("/user") as { user?: { id?: number } };
    if (typeof payload.user?.id !== "number") throw new ClickUpHttpError(500, "réponse /user inattendue");
    return payload.user.id;
  }

  async assignedTasks(input: { teamId: string; listIds: string[]; userId: number }): Promise<ClickUpTask[]> {
    const tasks: ClickUpTask[] = [];
    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ include_closed: "false", subtasks: "true", page: String(page) });
      params.append("assignees[]", String(input.userId));
      for (const listId of input.listIds) params.append("list_ids[]", listId);
      const payload = await this.get(`/team/${encodeURIComponent(input.teamId)}/task?${params}`) as { last_page?: boolean };
      tasks.push(...parseClickUpTasks(payload));
      if (payload.last_page !== false) break;
    }
    return tasks;
  }

  async taskContext(taskId: string, maxComments = 8): Promise<ClickUpTaskContext> {
    const [task, comments] = await Promise.all([
      this.get(`/task/${encodeURIComponent(taskId)}`) as Promise<{ description?: string }>,
      this.get(`/task/${encodeURIComponent(taskId)}/comment`) as Promise<{ comments?: any[] }>,
    ]);
    return {
      description: String(task.description ?? ""),
      comments: (comments.comments ?? []).slice(0, maxComments).map((comment) => ({
        author: String(comment.user?.username ?? "?"),
        text: String(comment.comment_text ?? ""),
        at: epochMs(comment.date),
      })),
    };
  }
}
```

**Step 4: Run tests**

Run: `cd sidecar && bun test tests/clickup.test.ts`
Expected: PASS (4 tests).

**Step 5: Commit**

```bash
git add sidecar/src/integrations/clickup.ts sidecar/tests/clickup.test.ts sidecar/tests/fixtures/clickup-tasks.json
git commit -m "feat(tableau-de-bord): client ClickUp déterministe (tâches assignées, contexte de tâche)"
```

---

### Task 6 : client GitLab

**Files:**
- Create: `sidecar/src/integrations/gitlab.ts`
- Test: `sidecar/tests/gitlab.test.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitLabClient, GitLabAuthError, readGlabToken, parseMergeRequest, parseDeployment, mergeRequestIidOfRef,
} from "../src/integrations/gitlab";

test("lit le token glab pour un hôte donné", () => {
  const home = mkdtempSync(join(tmpdir(), "pupitre-glab-"));
  mkdirSync(join(home, ".config/glab-cli"), { recursive: true });
  writeFileSync(join(home, ".config/glab-cli/config.yml"), [
    "host: gitlab.com",
    "hosts:",
    "    gitlab.com:",
    "        token: glpat-other",
    "    git.kaizen-hosting.com:",
    "        token: glpat-kaizen",
    "        api_protocol: https",
    "",
  ].join("\n"));
  expect(readGlabToken("https://git.kaizen-hosting.com", home)).toBe("glpat-kaizen");
  expect(readGlabToken("https://absent.example", home)).toBeNull();
});

test("parse une MR de la liste", () => {
  const mr = parseMergeRequest({
    iid: 1862, title: "TECH-24657 / Replace content types", source_branch: "feature/TECH-24657", target_branch: "develop",
    state: "opened", web_url: "https://git/x/-/merge_requests/1862", updated_at: "2026-08-19T11:36:57.763+02:00",
    draft: false, has_conflicts: false, detailed_merge_status: "mergeable", labels: ["deploy:testing"],
    author: { username: "clement.serizay" }, reviewers: [{ username: "louis.quellier" }], assignees: [],
  });
  expect(mr).toEqual({
    iid: 1862, title: "TECH-24657 / Replace content types", sourceBranch: "feature/TECH-24657", targetBranch: "develop",
    state: "opened", url: "https://git/x/-/merge_requests/1862", updatedAt: "2026-08-19T11:36:57.763+02:00",
    draft: false, hasConflicts: false, mergeStatus: "mergeable", labels: ["deploy:testing"],
    author: "clement.serizay", reviewers: ["louis.quellier"],
  });
});

test("résout l'iid de MR d'une ref de déploiement", () => {
  expect(mergeRequestIidOfRef("refs/merge-requests/1815/head")).toBe(1815);
  expect(mergeRequestIidOfRef("develop")).toBeNull();
});

test("parse un déploiement d'environnement", () => {
  expect(parseDeployment({
    ref: "refs/merge-requests/1815/head", sha: "a3bb6b78", status: "success", created_at: "2026-08-18T08:44:45.595+02:00",
    user: { username: "theo.micaletti" }, deployable: { name: "deploy:preprod", status: "success", web_url: "https://git/j/1" },
  })).toEqual({
    ref: "refs/merge-requests/1815/head", mergeRequestIid: 1815, sha: "a3bb6b78", status: "success",
    createdAt: "2026-08-18T08:44:45.595+02:00", user: "theo.micaletti", job: "deploy:preprod", jobUrl: "https://git/j/1",
  });
});

test("le client envoie PRIVATE-TOKEN, résout un projet par chemin, et lève sur 401", async () => {
  const seen: string[] = [];
  const client = new GitLabClient({ host: "https://git.example", token: "glpat-x" }, async (input, init) => {
    const url = String(input);
    seen.push(url);
    expect((init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat-x");
    if (url.endsWith("/user")) return Response.json({ id: 123, username: "clement.serizay" });
    if (url.endsWith("/projects/Affilae%2Fsymfony")) return Response.json({ id: 187, path_with_namespace: "Affilae/symfony" });
    if (url.includes("/merge_requests/1862/pipelines")) return Response.json([{ id: 119728, status: "manual", web_url: "https://git/p/119728", updated_at: "2026-08-19T10:00:00Z" }]);
    if (url.includes("/environments?")) return Response.json([{ id: 283, name: "preprod", state: "available" }, { id: 999, name: "preprod-old", state: "available" }]);
    if (url.endsWith("/environments/283")) return Response.json({ id: 283, name: "preprod", last_deployment: { ref: "refs/merge-requests/1815/head", sha: "a", status: "success", created_at: "2026-08-18T08:44:45Z", user: { username: "theo" }, deployable: { name: "deploy:preprod", status: "success", web_url: "u" } } });
    if (url.endsWith("/merge_requests/1815")) return Response.json({ iid: 1815, title: "t", source_branch: "feature/TECH-23903", target_branch: "develop", state: "merged", web_url: "w", updated_at: "x", draft: false, has_conflicts: false, detailed_merge_status: "not_open", labels: [], author: { username: "theo" }, reviewers: [], assignees: [] });
    return new Response("{}", { status: 401 });
  });
  expect(await client.me()).toEqual({ id: 123, username: "clement.serizay" });
  expect(await client.projectId("Affilae/symfony")).toBe(187);
  expect((await client.latestPipeline(187, 1862))?.status).toBe("manual");
  expect((await client.environmentByName(187, "preprod"))?.id).toBe(283);
  expect((await client.lastDeployment(187, 283))?.mergeRequestIid).toBe(1815);
  expect((await client.mergeRequest(187, 1815)).sourceBranch).toBe("feature/TECH-23903");
  await expect(client.openMergeRequests(290)).rejects.toBeInstanceOf(GitLabAuthError);
});
```

**Step 2: Run test to verify it fails**

Run: `cd sidecar && bun test tests/gitlab.test.ts`
Expected: FAIL — module introuvable.

**Step 3: Write minimal implementation**

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class GitLabAuthError extends Error {}
export class GitLabHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface GitLabMergeRequest {
  iid: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  state: string;
  url: string;
  updatedAt: string;
  draft: boolean;
  hasConflicts: boolean;
  mergeStatus: string;
  labels: string[];
  author: string;
  reviewers: string[];
}

export interface GitLabPipeline {
  id: number;
  status: string;
  url: string;
  updatedAt: string;
}

export interface GitLabDeployment {
  ref: string;
  mergeRequestIid: number | null;
  sha: string;
  status: string;
  createdAt: string;
  user: string;
  job: string | null;
  jobUrl: string | null;
}

/**
 * Le token de `glab`, déjà saisi par l'utilisateur. Parseur YAML volontairement
 * minimal : le fichier est plat (`hosts:` puis un bloc par hôte) et ne contient
 * que des scalaires ; une dépendance YAML pour trois lignes serait excessive.
 */
export function readGlabToken(host: string, home = homedir()): string | null {
  let content: string;
  try {
    content = readFileSync(join(home, ".config/glab-cli/config.yml"), "utf8");
  } catch {
    return null;
  }
  const hostname = new URL(host).hostname;
  let inHosts = false;
  let current: string | null = null;
  for (const line of content.split("\n")) {
    if (/^hosts:\s*$/u.test(line)) { inHosts = true; continue; }
    if (!inHosts) continue;
    const hostMatch = line.match(/^ {2,4}([^\s:]+):\s*$/u);
    if (hostMatch) { current = hostMatch[1] ?? null; continue; }
    const tokenMatch = line.match(/^\s+token:\s*(\S+)\s*$/u);
    if (tokenMatch && current === hostname) return tokenMatch[1] ?? null;
    if (/^\S/u.test(line)) inHosts = false;
  }
  return null;
}

export function mergeRequestIidOfRef(ref: string): number | null {
  const match = ref.match(/^refs\/merge-requests\/(\d+)\/head$/u);
  return match ? Number(match[1]) : null;
}

export function parseMergeRequest(raw: any): GitLabMergeRequest {
  return {
    iid: Number(raw.iid),
    title: String(raw.title ?? ""),
    sourceBranch: String(raw.source_branch ?? ""),
    targetBranch: String(raw.target_branch ?? ""),
    state: String(raw.state ?? ""),
    url: String(raw.web_url ?? ""),
    updatedAt: String(raw.updated_at ?? ""),
    draft: Boolean(raw.draft),
    hasConflicts: Boolean(raw.has_conflicts),
    mergeStatus: String(raw.detailed_merge_status ?? ""),
    labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
    author: String(raw.author?.username ?? ""),
    reviewers: Array.isArray(raw.reviewers) ? raw.reviewers.map((r: any) => String(r.username)) : [],
  };
}

export function parseDeployment(raw: any): GitLabDeployment {
  const ref = String(raw.ref ?? "");
  return {
    ref,
    mergeRequestIid: mergeRequestIidOfRef(ref),
    sha: String(raw.sha ?? ""),
    status: String(raw.status ?? ""),
    createdAt: String(raw.created_at ?? ""),
    user: String(raw.user?.username ?? ""),
    job: raw.deployable?.name ? String(raw.deployable.name) : null,
    jobUrl: raw.deployable?.web_url ? String(raw.deployable.web_url) : null,
  };
}

export class GitLabClient {
  private base: string;
  constructor(private auth: { host: string; token: string }, private fetchImpl: typeof fetch = fetch) {
    this.base = `${auth.host.replace(/\/$/u, "")}/api/v4`;
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      headers: { "PRIVATE-TOKEN": this.auth.token, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) throw new GitLabAuthError(`GitLab ${response.status}`);
    if (!response.ok) throw new GitLabHttpError(response.status, `GitLab ${response.status} sur ${path}`);
    return response.json();
  }

  async me(): Promise<{ id: number; username: string }> {
    const user = await this.get("/user") as { id: number; username: string };
    return { id: user.id, username: user.username };
  }

  async projectId(path: string): Promise<number> {
    const project = await this.get(`/projects/${encodeURIComponent(path)}`) as { id: number };
    return project.id;
  }

  async openMergeRequests(projectId: number): Promise<GitLabMergeRequest[]> {
    const list = await this.get(`/projects/${projectId}/merge_requests?state=opened&scope=all&per_page=100`) as any[];
    return list.map(parseMergeRequest);
  }

  async mergeRequest(projectId: number, iid: number): Promise<GitLabMergeRequest> {
    return parseMergeRequest(await this.get(`/projects/${projectId}/merge_requests/${iid}`));
  }

  async latestPipeline(projectId: number, iid: number): Promise<GitLabPipeline | null> {
    const list = await this.get(`/projects/${projectId}/merge_requests/${iid}/pipelines?per_page=1`) as any[];
    const first = list[0];
    return first ? { id: Number(first.id), status: String(first.status), url: String(first.web_url ?? ""), updatedAt: String(first.updated_at ?? "") } : null;
  }

  /** `search` est un préfixe côté GitLab : on exige l'égalité stricte du nom. */
  async environmentByName(projectId: number, name: string): Promise<{ id: number; name: string } | null> {
    const list = await this.get(`/projects/${projectId}/environments?search=${encodeURIComponent(name)}&states=available&per_page=50`) as any[];
    const exact = list.find((item) => item.name === name);
    return exact ? { id: Number(exact.id), name } : null;
  }

  async lastDeployment(projectId: number, environmentId: number): Promise<GitLabDeployment | null> {
    const env = await this.get(`/projects/${projectId}/environments/${environmentId}`) as { last_deployment?: unknown };
    return env.last_deployment ? parseDeployment(env.last_deployment) : null;
  }
}
```

**Step 4: Run tests**

Run: `cd sidecar && bun test tests/gitlab.test.ts`
Expected: PASS (5 tests).

**Step 5: Commit**

```bash
git add sidecar/src/integrations/gitlab.ts sidecar/tests/gitlab.test.ts
git commit -m "feat(tableau-de-bord): client GitLab déterministe (MR, pipelines, environnements, token glab)"
```

---

### Task 7 : `IntegrationsRefresher`

**Files:**
- Create: `sidecar/src/integrations/refresher.ts`
- Test: `sidecar/tests/integrations-refresher.test.ts`

Le refresher ne connaît ni `fetch` ni les tokens : il reçoit des **fabriques de clients** injectables (tests sans réseau), relève chaque intégration d'un projet indépendamment, écrit dans `TicketStore` dans une transaction par source, met à jour le statut de l'intégration et notifie ses listeners `(projectId) => void`.

**Configurations attendues (`config` JSON de `project_integrations`) :**

```ts
// clickup
{ teamId: "20556900", listIds: ["900100168537", "900500195250", "901503919889"] }
// gitlab
{ host: "https://git.kaizen-hosting.com",
  projects: [
    { path: "Affilae/symfony", label: "reactor", environments: ["preprod", "preprod_testing", "testing2", "preprod_testing_3", "preprod_testing_4"] },
    { path: "Affilae/hapigator", label: "hapigator", environments: [] } ] }
```

**Step 1: Write the failing test**

```ts
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";
import { IntegrationStore } from "../src/stores/integrations";
import { TicketStore } from "../src/stores/tickets";
import { IntegrationsRefresher } from "../src/integrations/refresher";
import { ClickUpAuthError } from "../src/integrations/clickup";
import type { ClickUpTask } from "../src/integrations/clickup";
import type { GitLabMergeRequest } from "../src/integrations/gitlab";

let projectId: string;
let integrations: IntegrationStore;
let tickets: TicketStore;
let conversations: ConversationStore;
let db: ReturnType<typeof openDb>;

const task: ClickUpTask = {
  id: "86caw5afd", key: "TECH-24657", title: "Leviers", status: "in progress", statusColor: "#4466ff",
  url: "https://app.clickup.com/t/86caw5afd", updatedAt: "2026-08-19T00:00:00.000Z", list: "Features", priority: "normal", labels: ["BackOffice"],
};
const mine: GitLabMergeRequest = {
  iid: 1862, title: "TECH-24657 / Leviers", sourceBranch: "feature/TECH-24657", targetBranch: "develop", state: "opened",
  url: "https://git/x/1862", updatedAt: "2026-08-19T10:00:00Z", draft: false, hasConflicts: false, mergeStatus: "mergeable",
  labels: [], author: "clement.serizay", reviewers: [],
};
const toReview: GitLabMergeRequest = { ...mine, iid: 1868, title: "TECH-24868 / Facture", sourceBranch: "issue/TECH-24868-publisher", author: "louis.quellier", reviewers: ["clement.serizay"] };

function fakeClickUp(tasks: ClickUpTask[] = [task]) {
  return { me: async () => 82632460, assignedTasks: async () => tasks, taskContext: async () => ({ description: "", comments: [] }) };
}

function fakeGitLab() {
  return {
    me: async () => ({ id: 123, username: "clement.serizay" }),
    projectId: async (path: string) => (path === "Affilae/symfony" ? 187 : 290),
    openMergeRequests: async (id: number) => (id === 187 ? [mine, toReview] : []),
    mergeRequest: async () => ({ ...mine, iid: 1815, sourceBranch: "feature/TECH-23903", state: "merged" }),
    latestPipeline: async () => ({ id: 119728, status: "manual", url: "https://git/p/119728", updatedAt: "2026-08-19T10:00:00Z" }),
    environmentByName: async (_: number, name: string) => (name === "preprod" ? { id: 283, name } : null),
    lastDeployment: async () => ({ ref: "refs/merge-requests/1815/head", mergeRequestIid: 1815, sha: "a", status: "success", createdAt: "2026-08-18T08:44:45Z", user: "theo.micaletti", job: "deploy:preprod", jobUrl: "u" }),
  };
}

function makeRefresher(overrides: Partial<ConstructorParameters<typeof IntegrationsRefresher>[1]> = {}) {
  return new IntegrationsRefresher({ integrations, tickets, conversations, projects: new ProjectStore(db) }, {
    clickUpClient: () => fakeClickUp() as any,
    gitLabClient: () => fakeGitLab() as any,
    ...overrides,
  });
}

beforeEach(() => {
  db = openDb(mkdtempSync(join(tmpdir(), "pupitre-refresher-")));
  projectId = new ProjectStore(db).create({ name: "mono", path: "/tmp/mono" }).id;
  integrations = new IntegrationStore(db);
  tickets = new TicketStore(db);
  conversations = new ConversationStore(db);
  integrations.upsert(projectId, "clickup", { config: { teamId: "1", listIds: ["a"] }, branchPattern: "^(issue|maintenance|feature)/(TECH-\\d+)" });
  integrations.upsert(projectId, "gitlab", {
    config: { host: "https://git.example", projects: [{ path: "Affilae/symfony", label: "reactor", environments: ["preprod", "absente"] }, { path: "Affilae/hapigator", label: "hapigator", environments: [] }] },
    branchPattern: "^(issue|maintenance|feature)/(TECH-\\d+)",
  });
});

test("rapproche tâche ClickUp, MR, pipeline et déploiement sur la clé du ticket", async () => {
  const refresher = makeRefresher();
  const notified: string[] = [];
  refresher.subscribe((id) => notified.push(id));
  await refresher.refreshProject(projectId);
  const rows = tickets.listByProject(projectId);
  const t = rows.find((row) => row.key === "TECH-24657")!;
  expect(t.source).toBe("clickup");
  expect(t.status).toBe("in progress");
  expect(t.refs.map((r) => r.kind).sort()).toEqual(["branch", "mr", "pipeline"]);
  expect(t.refs.find((r) => r.kind === "mr")?.ref).toBe("reactor!1862");
  expect(t.refs.find((r) => r.kind === "pipeline")?.payload).toEqual(expect.objectContaining({ status: "manual" }));
  // Le déploiement preprod pointe sur une MR mergée d'un autre ticket : il crée ce ticket en source git
  const deployed = rows.find((row) => row.key === "TECH-23903")!;
  expect(deployed.source).toBe("git");
  expect(deployed.refs.find((r) => r.kind === "deployment")?.payload).toEqual(expect.objectContaining({ environment: "preprod", user: "theo.micaletti" }));
  // La MR à relire n'est pas un ticket à moi
  expect(rows.find((row) => row.key === "TECH-24868")).toBeUndefined();
  const gitlab = integrations.find(projectId, "gitlab")!;
  expect(gitlab.status).toBe("ok");
  expect(gitlab.snapshot.toReview).toEqual([expect.objectContaining({ iid: 1868, author: "louis.quellier" })]);
  expect(gitlab.snapshot.environments).toEqual([
    expect.objectContaining({ project: "reactor", name: "preprod", branch: "feature/TECH-23903", key: "TECH-23903", user: "theo.micaletti" }),
    expect.objectContaining({ project: "reactor", name: "absente", missing: true }),
  ]);
  expect(notified).toEqual([projectId]);
});

test("une source en 401 passe à reconfigurer et n'efface rien ; l'autre continue", async () => {
  await makeRefresher().refreshProject(projectId);
  const refresher = makeRefresher({ clickUpClient: () => ({ ...fakeClickUp(), me: async () => { throw new ClickUpAuthError("401"); } }) as any });
  await refresher.refreshProject(projectId);
  expect(integrations.find(projectId, "clickup")?.status).toBe("à reconfigurer");
  expect(integrations.find(projectId, "gitlab")?.status).toBe("ok");
  expect(tickets.listByProject(projectId).find((row) => row.key === "TECH-24657")?.status).toBe("in progress");
});

test("une panne réseau passe en dégradée et garde les données", async () => {
  await makeRefresher().refreshProject(projectId);
  const refresher = makeRefresher({ gitLabClient: () => ({ ...fakeGitLab(), openMergeRequests: async () => { throw new TypeError("fetch failed"); } }) as any });
  await refresher.refreshProject(projectId);
  const gitlab = integrations.find(projectId, "gitlab")!;
  expect(gitlab.status).toBe("dégradée");
  expect(gitlab.last_error).toContain("fetch failed");
  expect(gitlab.snapshot.environments).toHaveLength(2);
});

test("une intégration sans token reste non configurée", async () => {
  const refresher = makeRefresher({ clickUpClient: () => null });
  await refresher.refreshProject(projectId);
  expect(integrations.find(projectId, "clickup")?.status).toBe("non configurée");
});

test("les conversations sur worktree créent des tickets git et se relient", async () => {
  const worktree = "/tmp/wt/feature-TECH-99";
  const conversation = conversations.create({ projectId, provider: "claude", model: "m", firstMessage: "x", worktreePath: worktree });
  const refresher = makeRefresher({ clickUpClient: () => null, gitLabClient: () => null, branchOfWorktree: () => "feature/TECH-99" });
  await refresher.refreshProject(projectId);
  const row = tickets.listByProject(projectId).find((item) => item.key === "TECH-99")!;
  expect(row.source).toBe("git");
  expect(row.conversations.map((c) => c.id)).toEqual([conversation.id]);
  expect(conversations.get(conversation.id)?.ticket_id).toBe(row.id);
});

test("start/stop : relève immédiate, puis périodique, sans double passage", async () => {
  let calls = 0;
  const refresher = makeRefresher({ clickUpClient: () => { calls += 1; return fakeClickUp() as any; } });
  refresher.start(50);
  await new Promise((resolve) => setTimeout(resolve, 130));
  refresher.stop();
  expect(calls).toBeGreaterThanOrEqual(2);
});
```

**Step 2: Run test to verify it fails**

Run: `cd sidecar && bun test tests/integrations-refresher.test.ts`
Expected: FAIL — module introuvable.

**Step 3: Write minimal implementation**

```ts
import type { Database } from "bun:sqlite";
import type { ProjectStore } from "../stores/projects";
import type { ConversationStore } from "../stores/conversations";
import type { IntegrationStore, ProjectIntegration } from "../stores/integrations";
import type { TicketStore } from "../stores/tickets";
import { ClickUpAuthError, ClickUpClient } from "./clickup";
import type { ClickUpTask } from "./clickup";
import { GitLabAuthError, GitLabClient, readGlabToken } from "./gitlab";
import type { GitLabMergeRequest } from "./gitlab";
import { compileBranchPattern, extractTicketKey } from "../ticket-key";

export const INTEGRATIONS_POLL_MS = 5 * 60 * 1000;
export const INTEGRATIONS_IDLE_POLL_MS = 30 * 60 * 1000;

export interface ClickUpConfig { teamId: string; listIds: string[] }
export interface GitLabProjectConfig { path: string; label: string; environments: string[] }
export interface GitLabConfig { host: string; projects: GitLabProjectConfig[] }

export interface EnvironmentState {
  project: string;
  name: string;
  missing?: boolean;
  branch: string | null;
  key: string | null;
  mergeRequestIid: number | null;
  user: string | null;
  deployedAt: string | null;
  status: string | null;
  jobUrl: string | null;
}

export interface RefresherStores {
  integrations: IntegrationStore;
  tickets: TicketStore;
  conversations: ConversationStore;
  projects: ProjectStore;
}

export interface RefresherDeps {
  /** null = pas de token : l'intégration reste « non configurée ». */
  clickUpClient?: (integration: ProjectIntegration) => Pick<ClickUpClient, "me" | "assignedTasks" | "taskContext"> | null;
  gitLabClient?: (integration: ProjectIntegration) => Pick<GitLabClient, "me" | "projectId" | "openMergeRequests" | "mergeRequest" | "latestPipeline" | "environmentByName" | "lastDeployment"> | null;
  /** Branche d'un worktree (lue par git) ; injectable pour les tests. */
  branchOfWorktree?: (path: string) => string | null;
  clickUpToken?: () => string | null;
  gitLabToken?: (host: string) => string | null;
}

type Listener = (projectId: string) => void;

export class IntegrationsRefresher {
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Map<string, Promise<void>>();
  private mergeRequestCache = new Map<string, GitLabMergeRequest>();

  constructor(private stores: RefresherStores, private deps: RefresherDeps = {}) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(intervalMs = INTEGRATIONS_POLL_MS): void {
    void this.refreshAll();
    if (this.timer !== null) return;
    this.timer = setInterval(() => { void this.refreshAll(); }, intervalMs);
    this.timer.unref?.();
  }

  /** Change la cadence sans relève immédiate (focus perdu/retrouvé). */
  setInterval(intervalMs: number): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = setInterval(() => { void this.refreshAll(); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async refreshAll(): Promise<void> {
    const projectIds = new Set(this.stores.integrations.listAll().map((item) => item.project_id));
    for (const project of this.stores.projects.list()) projectIds.add(project.id);
    await Promise.all([...projectIds].map((id) => this.refreshProject(id).catch(() => {})));
  }

  refreshProject(projectId: string): Promise<void> {
    const running = this.inFlight.get(projectId);
    if (running) return running;
    const run = this.run(projectId).finally(() => { this.inFlight.delete(projectId); });
    this.inFlight.set(projectId, run);
    return run;
  }

  private async run(projectId: string): Promise<void> {
    const items = this.stores.integrations.listByProject(projectId);
    const pattern = compiledPattern(items);
    await Promise.all([
      ...items.map((item) => this.refreshOne(item, pattern).catch(() => {})),
      Promise.resolve().then(() => this.refreshGitSource(projectId, pattern)),
    ]);
    this.stores.tickets.archiveStale(projectId);
    for (const listener of this.listeners) listener(projectId);
  }

  private async refreshOne(item: ProjectIntegration, pattern: RegExp | null): Promise<void> {
    try {
      if (item.type === "clickup") await this.refreshClickUp(item);
      else if (item.type === "gitlab") await this.refreshGitLab(item, pattern);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const auth = error instanceof ClickUpAuthError || error instanceof GitLabAuthError;
      this.stores.integrations.markError(item.id, auth ? "à reconfigurer" : "dégradée", message);
    }
  }

  // ---- ClickUp -------------------------------------------------------------

  private clickUp(item: ProjectIntegration) {
    if (this.deps.clickUpClient) return this.deps.clickUpClient(item);
    const token = this.deps.clickUpToken?.() ?? process.env.CLICKUP_API_TOKEN ?? null;
    return token ? new ClickUpClient(token) : null;
  }

  private async refreshClickUp(item: ProjectIntegration): Promise<void> {
    const client = this.clickUp(item);
    if (!client) return;
    const config = item.config as unknown as ClickUpConfig;
    const userId = await client.me();
    const tasks = await client.assignedTasks({ teamId: config.teamId, listIds: config.listIds ?? [], userId });
    this.write(() => {
      for (const task of tasks) this.upsertClickUpTask(item.project_id, task);
    });
    this.stores.integrations.markOk(item.id, { userId, tasks: tasks.length });
  }

  private upsertClickUpTask(projectId: string, task: ClickUpTask): void {
    this.stores.tickets.upsert(projectId, {
      key: task.key,
      source: "clickup",
      title: task.title,
      status: task.status,
      externalUrl: task.url,
      payload: { clickupId: task.id, statusColor: task.statusColor, list: task.list, priority: task.priority, labels: task.labels, updatedAt: task.updatedAt },
    });
  }

  /** Contexte ClickUp d'un ticket pour le brief de reprise ; null sans intégration. */
  async clickUpContext(projectId: string, ticketKey: string): Promise<{ description: string; comments: Array<{ author: string; text: string; at: string }> } | null> {
    const item = this.stores.integrations.find(projectId, "clickup");
    if (!item) return null;
    const client = this.clickUp(item);
    const ticket = this.stores.tickets.findByKey(projectId, ticketKey);
    const clickupId = ticket?.payload.clickupId;
    if (!client || typeof clickupId !== "string") return null;
    try {
      return await client.taskContext(clickupId);
    } catch {
      return null;
    }
  }

  // ---- GitLab --------------------------------------------------------------

  private gitLab(item: ProjectIntegration) {
    if (this.deps.gitLabClient) return this.deps.gitLabClient(item);
    const host = String((item.config as any).host ?? "");
    const token = this.deps.gitLabToken?.(host) ?? readGlabToken(host);
    return host && token ? new GitLabClient({ host, token }) : null;
  }

  private async refreshGitLab(item: ProjectIntegration, pattern: RegExp | null): Promise<void> {
    const client = this.gitLab(item);
    if (!client) return;
    const config = item.config as unknown as GitLabConfig;
    const me = await client.me();
    const environments: EnvironmentState[] = [];
    const toReview: Array<GitLabMergeRequest & { project: string }> = [];
    const writes: Array<() => void> = [];

    for (const projectConfig of config.projects ?? []) {
      const gitlabProjectId = await client.projectId(projectConfig.path);
      const mergeRequests = await client.openMergeRequests(gitlabProjectId);
      for (const mr of mergeRequests) {
        this.mergeRequestCache.set(`${gitlabProjectId}:${mr.iid}`, mr);
        const isMine = mr.author === me.username;
        const reviewsMine = mr.reviewers.includes(me.username) && !isMine;
        if (reviewsMine) toReview.push({ ...mr, project: projectConfig.label });
        const key = extractTicketKey(mr.sourceBranch, pattern);
        if (key === null) continue;
        const known = this.stores.tickets.findByKey(item.project_id, key);
        if (!isMine && !known) continue;
        const pipeline = isMine || known ? await client.latestPipeline(gitlabProjectId, mr.iid) : null;
        writes.push(() => {
          const ticket = this.stores.tickets.upsert(item.project_id, {
            key, source: "git", title: mr.title, status: "", externalUrl: null,
          });
          this.stores.tickets.upsertRef(ticket.id, { kind: "branch", ref: mr.sourceBranch, payload: { project: projectConfig.label } });
          this.stores.tickets.upsertRef(ticket.id, {
            kind: "mr", ref: `${projectConfig.label}!${mr.iid}`,
            payload: { iid: mr.iid, project: projectConfig.label, title: mr.title, state: mr.state, url: mr.url, draft: mr.draft, hasConflicts: mr.hasConflicts, mergeStatus: mr.mergeStatus, labels: mr.labels, author: mr.author, reviewers: mr.reviewers, targetBranch: mr.targetBranch, updatedAt: mr.updatedAt },
          });
          if (pipeline) {
            this.stores.tickets.upsertRef(ticket.id, { kind: "pipeline", ref: `${projectConfig.label}!${mr.iid}`, payload: { ...pipeline, project: projectConfig.label } });
          }
        });
      }

      for (const name of projectConfig.environments ?? []) {
        const env = await client.environmentByName(gitlabProjectId, name);
        if (!env) {
          environments.push({ project: projectConfig.label, name, missing: true, branch: null, key: null, mergeRequestIid: null, user: null, deployedAt: null, status: null, jobUrl: null });
          continue;
        }
        const deployment = await client.lastDeployment(gitlabProjectId, env.id);
        let branch: string | null = deployment?.ref ?? null;
        if (deployment?.mergeRequestIid) {
          const cacheKey = `${gitlabProjectId}:${deployment.mergeRequestIid}`;
          const mr = this.mergeRequestCache.get(cacheKey) ?? await client.mergeRequest(gitlabProjectId, deployment.mergeRequestIid);
          this.mergeRequestCache.set(cacheKey, mr);
          branch = mr.sourceBranch;
        }
        const key = branch ? extractTicketKey(branch, pattern) : null;
        const state: EnvironmentState = {
          project: projectConfig.label, name, branch, key,
          mergeRequestIid: deployment?.mergeRequestIid ?? null,
          user: deployment?.user ?? null, deployedAt: deployment?.createdAt ?? null,
          status: deployment?.status ?? null, jobUrl: deployment?.jobUrl ?? null,
        };
        environments.push(state);
        if (key !== null && branch !== null) {
          writes.push(() => {
            const ticket = this.stores.tickets.upsert(item.project_id, { key, source: "git", title: branch, status: "", externalUrl: null });
            this.stores.tickets.upsertRef(ticket.id, { kind: "branch", ref: branch, payload: { project: projectConfig.label } });
            this.stores.tickets.upsertRef(ticket.id, {
              kind: "deployment", ref: `${projectConfig.label}:${name}`,
              payload: { environment: name, project: projectConfig.label, user: state.user, deployedAt: state.deployedAt, status: state.status, jobUrl: state.jobUrl },
            });
          });
        }
      }
    }

    this.write(() => { for (const write of writes) write(); });
    this.stores.integrations.markOk(item.id, { username: me.username, environments, toReview });
  }

  // ---- Source git locale ---------------------------------------------------

  /** Les conversations sur worktree sont des tickets même sans ClickUp/GitLab. */
  private refreshGitSource(projectId: string, pattern: RegExp | null): void {
    const branchOf = this.deps.branchOfWorktree ?? defaultBranchOfWorktree;
    this.write(() => {
      for (const conversation of this.stores.conversations.listByProject(projectId)) {
        if (!conversation.worktree_path) continue;
        const branch = branchOf(conversation.worktree_path);
        if (!branch) continue;
        const key = extractTicketKey(branch, pattern);
        if (key === null) continue;
        const ticket = this.stores.tickets.upsert(projectId, { key, source: "git", title: branch, status: "", externalUrl: null });
        this.stores.tickets.upsertRef(ticket.id, { kind: "branch", ref: branch, payload: { local: true } });
        if (conversation.ticket_id === null) this.stores.tickets.linkConversation(conversation.id, ticket.id);
      }
    });
  }

  private write(fn: () => void): void {
    const db = (this.stores.tickets as unknown as { db: Database }).db;
    db.transaction(fn)();
  }
}

function compiledPattern(items: ProjectIntegration[]): RegExp | null {
  const pattern = items.find((item) => item.branch_pattern)?.branch_pattern ?? null;
  return pattern ? compileBranchPattern(pattern) : null;
}

/** `git worktree list` n'est pas nécessaire : le HEAD du worktree suffit. */
function defaultBranchOfWorktree(path: string): string | null {
  try {
    const head = require("node:fs").readFileSync(require("node:path").join(path, ".git"), "utf8") as string;
    const gitdir = head.match(/^gitdir: (.+)$/mu)?.[1];
    if (!gitdir) return null;
    const ref = require("node:fs").readFileSync(require("node:path").join(gitdir, "HEAD"), "utf8") as string;
    return ref.match(/^ref: refs\/heads\/(.+)$/mu)?.[1] ?? null;
  } catch {
    return null;
  }
}
```

> Deux ajustements à faire proprement plutôt que tels quels : (1) remplacer les `require(...)` de `defaultBranchOfWorktree` par des imports ESM en tête de fichier (`readFileSync` de `node:fs`, `join` de `node:path`) ; (2) plutôt que d'atteindre `tickets.db` par un cast, donner à `TicketStore` une méthode publique `transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }` et l'utiliser dans `write()`. Le test « conversations sur worktree » ne dépend d'aucun dépôt git réel grâce à l'injection `branchOfWorktree`.

**Step 4: Run tests**

Run: `cd sidecar && bun test tests/integrations-refresher.test.ts && bun test`
Expected: PASS (6 tests), suite verte.

**Step 5: Commit**

```bash
git add sidecar/src/integrations/refresher.ts sidecar/src/stores/tickets.ts sidecar/tests/integrations-refresher.test.ts
git commit -m "feat(tableau-de-bord): relève périodique et rapprochement par clé de ticket"
```

---

### Task 8 : Routes HTTP, tokens, canal WS `tickets`

**Files:**
- Create: `sidecar/src/dashboard.ts` (composition du payload)
- Modify: `sidecar/src/server.ts` (`ServerDeps` l.87-120 ; `WebSocketData` l.182-185 ; registres de sockets ~l.925 ; `PUT /api/settings` l.1823-1868 ; nouvelles routes après `GET /api/projects/:id/worktrees` ~l.1356 ; `/ws` l.2902 ; `websocket.open/close` l.2941+)
- Modify: `sidecar/src/index.ts` (instancier `IntegrationStore`, `TicketStore`, `IntegrationsRefresher` ; `start()` après `quotaRefresher.start()` ; `stop()` dans `shutdownGracefully`)
- Test: `sidecar/tests/dashboard-routes.test.ts` (patron `tests/server.test.ts` : construire `ServerDeps` à la main)

**Payload `GET /api/projects/:id/dashboard`** (aussi poussé sur `/ws?channel=tickets&project=<id>`) :

```ts
export interface DashboardPayload {
  projectId: string;
  refreshedAt: string;
  integrations: Array<{ id: string; type: IntegrationType; status: IntegrationStatus; last_ok_at: string | null; last_error: string | null; branch_pattern: string | null; config: Record<string, unknown> }>;
  tickets: TicketRow[];
  environments: EnvironmentState[];
  toReview: Array<GitLabMergeRequest & { project: string }>;
}
```

**Step 1: Write the failing test**

```ts
// sidecar/tests/dashboard-routes.test.ts — reprendre le beforeEach de tests/server.test.ts
// (stores réels sur db temporaire, createServer(deps), port 0) et ajouter aux deps :
//   integrations: new IntegrationStore(db), tickets: new TicketStore(db),
//   integrationsRefresher: new IntegrationsRefresher({...}, { clickUpClient: () => null, gitLabClient: () => null })
import { test, expect } from "bun:test";
// … imports du patron server.test.ts …

test("CRUD des intégrations d'un projet et validation du motif", async () => {
  const project = await createProject("/tmp/dash-1");
  const put = await putJson(`/api/projects/${project.id}/integrations/gitlab`, {
    config: { host: "https://git.example", projects: [] }, branchPattern: "^(issue|feature)/(TECH-\\d+)",
  });
  expect(put.status).toBe(200);
  const list = await fetch(`${baseUrl}/api/projects/${project.id}/integrations`).then((r) => r.json());
  expect(list).toHaveLength(1);
  expect(list[0]).toEqual(expect.objectContaining({ type: "gitlab", status: "non configurée" }));
  const bad = await putJson(`/api/projects/${project.id}/integrations/gitlab`, { config: {}, branchPattern: "(" });
  expect(bad.status).toBe(400);
  const del = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/gitlab`, { method: "DELETE" });
  expect(del.status).toBe(204);
});

test("les tokens d'intégration s'écrivent dans settings sans jamais être relus par GET", async () => {
  const put = await putJson("/api/settings", { integrationTokens: { clickup: "pk_secret", gitlab: "glpat-secret" } });
  expect(put.status).toBe(200);
  const settings = await fetch(`${baseUrl}/api/settings`).then((r) => r.json());
  expect(settings.integrationTokens).toEqual({ clickup: true, gitlab: true });
  expect(JSON.stringify(settings)).not.toContain("pk_secret");
});

test("dashboard : tickets, notes, refresh et canal WS", async () => {
  const project = await createProject("/tmp/dash-2");
  const ticket = current!.deps.tickets.upsert(project.id, { key: "TECH-1", source: "git", title: "b", status: "", externalUrl: null });
  const payload = await fetch(`${baseUrl}/api/projects/${project.id}/dashboard`).then((r) => r.json());
  expect(payload.tickets.map((t: any) => t.key)).toEqual(["TECH-1"]);
  const note = await postJson(`/api/tickets/${ticket.id}/notes`, { body: "penser au cache" });
  expect(note.status).toBe(201);
  const waiter = webSocketEventWaiter(`${baseUrl.replace("http", "ws")}/ws?channel=tickets&project=${project.id}`, (event: any) => event.tickets?.[0]?.notes_count === 1);
  const refresh = await postJson(`/api/projects/${project.id}/dashboard/refresh`, {});
  expect(refresh.status).toBe(202);
  await waiter;
});
```

> Le canal WS envoie le payload courant à l'ouverture (comme `fleet`) ; le test attend le message qui suit le refresh. Adapter `webSocketEventWaiter` si sa signature diffère — lire `tests/server.test.ts:116`.

**Step 2: Run test to verify it fails**

Run: `cd sidecar && bun test tests/dashboard-routes.test.ts`
Expected: FAIL — `ServerDeps` refuse `integrations`, routes 404.

**Step 3: Write minimal implementation**

`sidecar/src/dashboard.ts` :

```ts
import type { IntegrationStore } from "./stores/integrations";
import type { TicketStore, TicketRow } from "./stores/tickets";
import type { EnvironmentState } from "./integrations/refresher";

export interface DashboardPayload {
  projectId: string;
  refreshedAt: string;
  integrations: Array<Record<string, unknown>>;
  tickets: TicketRow[];
  environments: EnvironmentState[];
  toReview: unknown[];
}

export function dashboardPayload(projectId: string, integrations: IntegrationStore, tickets: TicketStore): DashboardPayload {
  const items = integrations.listByProject(projectId);
  const gitlab = items.find((item) => item.type === "gitlab");
  return {
    projectId,
    refreshedAt: new Date().toISOString(),
    integrations: items.map(({ snapshot: _snapshot, ...rest }) => rest),
    tickets: tickets.listByProject(projectId),
    environments: (gitlab?.snapshot.environments as EnvironmentState[] | undefined) ?? [],
    toReview: (gitlab?.snapshot.toReview as unknown[] | undefined) ?? [],
  };
}
```

`server.ts` :

1. `ServerDeps` : ajouter `integrations: IntegrationStore; tickets: TicketStore; integrationsRefresher: IntegrationsRefresher;`.
2. `WebSocketData` : ajouter `| { channel: "tickets"; projectId: string }`.
3. Registre : `const ticketSockets = new Map<string, Set<ServerWebSocket<WebSocketData>>>();` et
   ```ts
   const broadcastDashboard = (projectId: string) => {
     const sockets = ticketSockets.get(projectId);
     if (!sockets || sockets.size === 0) return;
     const message = JSON.stringify(dashboardPayload(projectId, deps.integrations, deps.tickets));
     for (const socket of sockets) { try { socket.send(message); } catch { sockets.delete(socket); } }
   };
   deps.integrationsRefresher.subscribe(broadcastDashboard);
   ```
4. `PUT /api/settings` : nouveau bloc
   ```ts
   if ("integrationTokens" in body) {
     const tokens = body.integrationTokens;
     if (typeof tokens !== "object" || tokens === null) throw new HttpError(400, "integrationTokens invalide");
     const current = deps.settings.get<Record<string, string>>(INTEGRATION_TOKENS_KEY) ?? {};
     for (const [name, value] of Object.entries(tokens as Record<string, unknown>)) {
       if (name !== "clickup" && name !== "gitlab") throw new HttpError(400, `token ${name} inconnu`);
       if (value === null || value === "") delete current[name];
       else if (typeof value === "string") current[name] = value;
       else throw new HttpError(400, `token ${name} invalide`);
     }
     deps.settings.set(INTEGRATION_TOKENS_KEY, current);
     updated = true;
   }
   ```
   et dans `GET /api/settings` comme dans la réponse du PUT, remplacer la valeur par des booléens : écrire une fonction `publicSettings(deps)` qui fait `const all = deps.settings.all(); const tokens = all[INTEGRATION_TOKENS_KEY] as Record<string,string> | undefined; return { ...all, integrationTokens: Object.fromEntries(Object.keys(tokens ?? {}).map((k) => [k, true])), conductorToolTokens: conductorToolTokens() }`. Exporter `INTEGRATION_TOKENS_KEY = "integrationTokens"` depuis `stores/settings.ts`.
5. Routes (après `/api/projects/:id/worktrees`) :
   ```ts
   const projectIntegrationsId = routeId(pathname, /^\/api\/projects\/([^/]+)\/integrations$/);
   if (request.method === "GET" && projectIntegrationsId !== null) {
     if (!deps.projects.get(projectIntegrationsId)) throw new HttpError(404, "projet inconnu");
     return json(deps.integrations.listByProject(projectIntegrationsId).map(({ snapshot: _s, ...rest }) => rest));
   }
   const projectIntegration = pathname.match(/^\/api\/projects\/([^/]+)\/integrations\/(clickup|gitlab|github|notion|sentry)$/);
   if (projectIntegration && (request.method === "PUT" || request.method === "DELETE")) {
     const projectId = decodeURIComponent(projectIntegration[1]!);
     const type = projectIntegration[2] as IntegrationType;
     if (!deps.projects.get(projectId)) throw new HttpError(404, "projet inconnu");
     if (request.method === "DELETE") {
       const existing = deps.integrations.find(projectId, type);
       if (existing) deps.integrations.remove(existing.id);
       return empty(204);
     }
     const body = await readObject(request);
     const config = body.config;
     if (typeof config !== "object" || config === null || Array.isArray(config)) throw new HttpError(400, "champ config invalide");
     const branchPattern = optionalTrimmed(body, "branchPattern");
     try {
       const saved = deps.integrations.upsert(projectId, type, { config: config as Record<string, unknown>, branchPattern });
       void deps.integrationsRefresher.refreshProject(projectId).catch(() => {});
       const { snapshot: _s, ...rest } = saved;
       return json(rest);
     } catch (error) {
       throw new HttpError(400, error instanceof Error ? `motif de branche invalide : ${error.message}` : "intégration invalide");
     }
   }
   const projectDashboardId = routeId(pathname, /^\/api\/projects\/([^/]+)\/dashboard$/);
   if (request.method === "GET" && projectDashboardId !== null) {
     if (!deps.projects.get(projectDashboardId)) throw new HttpError(404, "projet inconnu");
     return json(dashboardPayload(projectDashboardId, deps.integrations, deps.tickets));
   }
   const projectDashboardRefreshId = routeId(pathname, /^\/api\/projects\/([^/]+)\/dashboard\/refresh$/);
   if (request.method === "POST" && projectDashboardRefreshId !== null) {
     if (!deps.projects.get(projectDashboardRefreshId)) throw new HttpError(404, "projet inconnu");
     void deps.integrationsRefresher.refreshProject(projectDashboardRefreshId).catch(() => {});
     return empty(202);
   }
   const ticketNotesId = routeId(pathname, /^\/api\/tickets\/([^/]+)\/notes$/);
   if (ticketNotesId !== null && (request.method === "GET" || request.method === "POST")) {
     const ticket = deps.tickets.get(ticketNotesId);
     if (!ticket) throw new HttpError(404, "ticket inconnu");
     if (request.method === "GET") return json(deps.tickets.notesByTicket(ticket.id));
     const body = await readObject(request);
     const note = deps.tickets.addNote(ticket.id, requiredString(body, "body").trim());
     broadcastDashboard(ticket.project_id);
     return json(note, 201);
   }
   const ticketNoteId = routeId(pathname, /^\/api\/ticket-notes\/([^/]+)$/);
   if (request.method === "DELETE" && ticketNoteId !== null) {
     if (!deps.tickets.deleteNote(ticketNoteId)) throw new HttpError(404, "note inconnue");
     return empty(204);
   }
   ```
   > Pour que la suppression de note rafraîchisse le WS, `deleteNote` peut retourner le `ticket_id` supprimé (`SELECT` avant `DELETE`) ; simple et suffisant.
6. `/ws` : avant le test `channel !== "conversation"` :
   ```ts
   if (channel === "tickets") {
     const projectId = url.searchParams.get("project");
     if (!projectId || !deps.projects.get(projectId)) throw new HttpError(404, "projet inconnu");
     if (server.upgrade(request, { data: { channel: "tickets", projectId } })) return;
     throw new HttpError(400, "upgrade WebSocket refusé");
   }
   ```
   `open` : `if (socket.data.channel === "tickets") { const set = ticketSockets.get(projectId) ?? new Set(); set.add(socket); ticketSockets.set(projectId, set); socket.send(JSON.stringify(dashboardPayload(...))); return; }` ; `close` : retirer du set.

`index.ts` : après `const routineStore = …` :
```ts
  const integrations = new IntegrationStore(db);
  const tickets = new TicketStore(db);
  const integrationsRefresher = new IntegrationsRefresher(
    { integrations, tickets, conversations, projects },
    { clickUpToken: () => settings.get<Record<string, string>>(INTEGRATION_TOKENS_KEY)?.clickup ?? null,
      gitLabToken: (host) => settings.get<Record<string, string>>(INTEGRATION_TOKENS_KEY)?.gitlab ?? readGlabToken(host) },
  );
```
passer les trois dans `createServer({...})`, `integrationsRefresher.start()` juste après `quotaRefresher.start()`, `integrationsRefresher.stop()` dans `shutdownGracefully`. Mettre aussi à jour `tests/server.test.ts` (et tout test qui construit `ServerDeps`) pour fournir les trois nouveaux champs — sinon `tsc`/`bun test` échouent.

**Step 4: Run tests**

Run: `cd sidecar && bun test`
Expected: PASS, y compris `server.test.ts` mis à jour.

**Step 5: Commit**

```bash
git add sidecar/src/dashboard.ts sidecar/src/server.ts sidecar/src/index.ts sidecar/src/stores/settings.ts sidecar/tests/dashboard-routes.test.ts sidecar/tests/server.test.ts
git commit -m "feat(tableau-de-bord): routes intégrations, dashboard, notes, tokens et canal WS tickets"
```

---

### Task 9 : brief de reprise et `ticketId` à la création

**Files:**
- Create: `sidecar/src/ticket-brief.ts`
- Modify: `sidecar/src/runner.ts` (`runTurn` l.169-173 : 5e paramètre `options: { preamble?: string } = {}` ; l.291 : préfixer le prompt provider)
- Modify: `sidecar/src/server.ts` (`POST /api/conversations` l.1870-1932)
- Test: `sidecar/tests/ticket-brief.test.ts`, et un cas dans `tests/dashboard-routes.test.ts`

**Step 1: Write the failing tests**

```ts
// sidecar/tests/ticket-brief.test.ts
import { test, expect } from "bun:test";
import { composeTicketBrief, MAX_BRIEF_CHARS } from "../src/ticket-brief";

const base = {
  ticket: { key: "TECH-24657", title: "Leviers", status: "in progress", source: "clickup" as const, external_url: "https://app.clickup.com/t/x" },
  branches: ["feature/TECH-24657"],
  refs: [{ kind: "mr" as const, ref: "reactor!1862", payload: { url: "https://git/1862", state: "opened", mergeStatus: "mergeable" } }],
  notes: [{ body: "penser au cache", created_at: "2026-08-19T10:00:00Z" }],
  clickup: { description: "Faire la chose.", comments: [{ author: "Alex", text: "Dernier mot", at: "2026-08-19T09:00:00Z" }] },
  siblings: [{ id: "c1", title: "Première passe", summary: "Ajout du modèle", debrief: "# Débrief\n\nFait A, reste B." }],
};

test("compose un brief markdown ordonné et borné", () => {
  const brief = composeTicketBrief(base);
  expect(brief.startsWith("# Reprise du ticket TECH-24657")).toBe(true);
  const order = ["## Ticket", "## Branche et MR", "## Notes", "## Conversations précédentes", "## Consigne"].map((h) => brief.indexOf(h));
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(brief).toContain("feature/TECH-24657");
  expect(brief).toContain("read_sibling_conversation");
  expect(brief).toContain("c1");
});

test("tronque les débriefs trop longs sans dépasser la borne", () => {
  const brief = composeTicketBrief({ ...base, siblings: [{ id: "c1", title: "t", summary: "s", debrief: "x".repeat(MAX_BRIEF_CHARS * 2) }] });
  expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS + 200);
  expect(brief).toContain("[tronqué]");
});

test("sans ClickUp ni conversations sœurs, les sections absentes ne sont pas écrites", () => {
  const brief = composeTicketBrief({ ...base, clickup: null, siblings: [], notes: [] });
  expect(brief).not.toContain("## Notes");
  expect(brief).not.toContain("## Conversations précédentes");
});
```

Dans `tests/dashboard-routes.test.ts`, ajouter :

```ts
test("POST /api/conversations avec ticketId relie la conversation, prend la branche du ticket et injecte le brief", async () => {
  const project = await createProject(repoPath); // dépôt git réel comme dans server.test.ts (runGit init + commit)
  const ticket = current!.deps.tickets.upsert(project.id, { key: "TECH-7", source: "git", title: "b", status: "", externalUrl: null });
  current!.deps.tickets.upsertRef(ticket.id, { kind: "branch", ref: "feature/TECH-7", payload: {} });
  const created = await postJson("/api/conversations", { projectId: project.id, provider: "claude", model: "claude-fable-5", message: "On reprend", ticketId: ticket.id });
  expect(created.status).toBe(201);
  const conversation = await created.json();
  expect(conversation.ticket_id).toBe(ticket.id);
  expect(conversation.worktree_path).toContain("feature-TECH-7");
  await waitForRunnerIdle();
  const events = current!.deps.conversations.listEvents(conversation.id);
  const userMessage = events.find((e: any) => e.type === "user-message") as any;
  expect(userMessage.text).toBe("On reprend");                   // l'historique garde le message original
  const sent = readFileSync(fakeClaudePromptLog, "utf8");         // le fake-claude journalise le prompt reçu (voir tests/fake-bins)
  expect(sent).toContain("# Reprise du ticket TECH-7");
});
```

> Vérifier comment `tests/fake-bins/fake-claude` expose le prompt reçu (variable d'env de journalisation ou fixture) ; si rien n'existe, ajouter une écriture du prompt dans `$PUPITRE_FAKE_PROMPT_LOG` quand la variable est définie — changement minime et réutilisable.

**Step 2: Run tests to verify they fail**

Run: `cd sidecar && bun test tests/ticket-brief.test.ts tests/dashboard-routes.test.ts`
Expected: FAIL — module introuvable ; `ticketId` ignoré.

**Step 3: Write minimal implementation**

`sidecar/src/ticket-brief.ts` :

```ts
export const MAX_BRIEF_CHARS = 12_000;
const MAX_DEBRIEF_CHARS = 3_000;
const MAX_DESCRIPTION_CHARS = 2_000;

export interface TicketBriefInput {
  ticket: { key: string; title: string; status: string; source: "clickup" | "notion" | "git"; external_url: string | null };
  branches: string[];
  refs: Array<{ kind: string; ref: string; payload: Record<string, unknown> }>;
  notes: Array<{ body: string; created_at: string }>;
  clickup: { description: string; comments: Array<{ author: string; text: string; at: string }> } | null;
  siblings: Array<{ id: string; title: string; summary: string; debrief: string | null }>;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[tronqué]`;
}

/**
 * Le préambule injecté au premier tour d'une conversation démarrée depuis le
 * Tableau de bord. Markdown court et ordonné : l'agent doit pouvoir l'ignorer
 * en partie, mais jamais devoir le chercher.
 */
export function composeTicketBrief(input: TicketBriefInput): string {
  const parts: string[] = [`# Reprise du ticket ${input.ticket.key}`, ""];
  parts.push("## Ticket", `- Titre : ${input.ticket.title}`, `- Statut : ${input.ticket.status || "inconnu"}`);
  if (input.ticket.external_url) parts.push(`- Lien : ${input.ticket.external_url}`);
  if (input.clickup?.description) parts.push("", clip(input.clickup.description.trim(), MAX_DESCRIPTION_CHARS));
  if (input.clickup?.comments.length) {
    parts.push("", "Derniers commentaires :");
    for (const comment of input.clickup.comments) parts.push(`- ${comment.author} (${comment.at.slice(0, 10)}) : ${clip(comment.text.trim(), 400)}`);
  }
  parts.push("", "## Branche et MR");
  parts.push(input.branches.length ? `- Branche : ${input.branches.join(", ")}` : "- Aucune branche connue");
  for (const ref of input.refs) {
    if (ref.kind === "mr") parts.push(`- MR ${ref.ref} : ${String(ref.payload.state ?? "")} · ${String(ref.payload.mergeStatus ?? "")} · ${String(ref.payload.url ?? "")}`);
    if (ref.kind === "pipeline") parts.push(`- Pipeline ${ref.ref} : ${String(ref.payload.status ?? "")} · ${String(ref.payload.url ?? "")}`);
    if (ref.kind === "deployment") parts.push(`- Déployé sur ${String(ref.payload.environment ?? ref.ref)} par ${String(ref.payload.user ?? "?")} le ${String(ref.payload.deployedAt ?? "").slice(0, 10)}`);
  }
  if (input.notes.length) {
    parts.push("", "## Notes");
    for (const note of input.notes) parts.push(`- (${note.created_at.slice(0, 10)}) ${note.body}`);
  }
  if (input.siblings.length) {
    parts.push("", "## Conversations précédentes sur ce ticket");
    for (const sibling of input.siblings) {
      parts.push(`### ${sibling.title} (id ${sibling.id})`, sibling.summary);
      if (sibling.debrief) parts.push("", clip(sibling.debrief.trim(), MAX_DEBRIEF_CHARS));
      parts.push("");
    }
  }
  parts.push("## Consigne",
    "Prends ce contexte comme point de départ. Pour creuser une conversation précédente, appelle l'outil",
    "`read_sibling_conversation` avec son id plutôt que de deviner. Confirme brièvement la reprise, puis traite la demande ci-dessous.");
  return clip(parts.join("\n"), MAX_BRIEF_CHARS);
}
```

`runner.ts` :
```ts
  async runTurn(
    conversationId: string,
    prompt: string,
    imageNames: string[],
    attachments: MediaAttachment[] = [],
    options: { preamble?: string } = {},
  ): Promise<TurnOutcome> {
```
et, l.291, envelopper : `prompt: withActionFormat((options.preamble ? \`${options.preamble}\n\n---\n\n\` : "") + (this.skills?.augmentPrompt(...) ?? prompt) + attachmentPrompt(...), this.actionFormat())`. Le `user-message` persisté (l.253) ne change pas : l'historique garde le message original.

`server.ts`, `POST /api/conversations` — après `const branch = optionalTrimmed(body, "branch");` :
```ts
          const ticketId = optionalTrimmed(body, "ticketId");
          let ticket = ticketId ? deps.tickets.get(ticketId) : null;
          if (ticketId && (!ticket || ticket.project_id !== projectId)) throw new HttpError(404, "ticket inconnu");
          // Sans branche explicite, la branche la plus récente du ticket ; avec une
          // branche et sans ticket, le ticket que la branche désigne (s'il existe).
          let effectiveBranch = branch ?? (ticket ? deps.tickets.branchesOf(ticket.id)[0] ?? null : null);
          if (!ticket && effectiveBranch) {
            const pattern = deps.integrations.listByProject(projectId).find((i) => i.branch_pattern)?.branch_pattern ?? null;
            const key = extractTicketKey(effectiveBranch, pattern ? compileBranchPattern(pattern) : null);
            ticket = key ? deps.tickets.findByKey(projectId, key) : null;
          }
```
remplacer l'usage de `branch` par `effectiveBranch` pour `createWorktree`, passer `ticketId: ticket?.id ?? null` à `deps.conversations.create(...)`, puis avant `runTurn` :
```ts
          const preamble = ticket ? await ticketBriefFor(deps, ticket, conversation.id) : undefined;
          void deps.runner.runTurn(conversation.id, message, images, attachments, preamble ? { preamble } : {})
            .catch((error) => console.error("Échec du tour", error));
```
avec, en haut de `server.ts` :
```ts
async function ticketBriefFor(deps: ServerDeps, ticket: Ticket, excludeConversationId: string): Promise<string> {
  const siblings = deps.tickets.conversationsByTicket(ticket.id)
    .filter((item) => item.id !== excludeConversationId)
    .slice(0, 5)
    .map((item) => ({ id: item.id, title: item.title, summary: item.summary, debrief: deps.debriefs.latest(item.id)?.content_md ?? null }));
  return composeTicketBrief({
    ticket,
    branches: deps.tickets.branchesOf(ticket.id),
    refs: deps.tickets.refsByTicket(ticket.id),
    notes: deps.tickets.notesByTicket(ticket.id),
    clickup: await deps.integrationsRefresher.clickUpContext(ticket.project_id, ticket.key),
    siblings,
  });
}
```

**Step 4: Run tests**

Run: `cd sidecar && bun test`
Expected: PASS.

**Step 5: Commit**

```bash
git add sidecar/src/ticket-brief.ts sidecar/src/runner.ts sidecar/src/server.ts sidecar/tests/ticket-brief.test.ts sidecar/tests/dashboard-routes.test.ts sidecar/tests/fake-bins
git commit -m "feat(tableau-de-bord): brief de reprise injecté au premier tour d'un ticket"
```

---

### Task 10 : outil MCP `read_sibling_conversation`

**Files:**
- Modify: `sidecar/src/pupitre-mcp.ts` (après `publish_html_document`)
- Modify: `sidecar/src/server.ts` (route `GET /api/conversations/:id/brief`)
- Modify: `sidecar/src/adapters/claude.ts` l.70 (`--allowedTools` : ajouter `mcp__pupitre__read_sibling_conversation` et, tant qu'on y est, `mcp__pupitre__publish_document`)
- Test: `sidecar/tests/pupitre-mcp.test.ts` (s'il existe, étendre ; sinon créer sur le modèle de `conductor-mcp.test.ts`)

**Step 1: Write the failing test**

```ts
test("GET /api/conversations/:id/brief rend titre, résumé, dernier débrief et derniers échanges", async () => {
  const project = await createProject("/tmp/brief-1");
  const conversation = current!.deps.conversations.create({ projectId: project.id, provider: "claude", model: "m", firstMessage: "Bonjour" });
  current!.deps.conversations.appendEvent(conversation.id, { type: "user-message", text: "Bonjour", images: [] });
  current!.deps.conversations.appendEvent(conversation.id, { type: "text-final", text: "Salut, voici le plan." } as any);
  const brief = await fetch(`${baseUrl}/api/conversations/${conversation.id}/brief`).then((r) => r.json());
  expect(brief).toEqual(expect.objectContaining({ id: conversation.id, title: expect.any(String), debrief: null }));
  expect(brief.exchanges.at(-1)).toEqual({ role: "assistant", text: "Salut, voici le plan." });
});
```

Et pour l'outil MCP (patron `conductor-mcp.test.ts` : client MCP in-memory sur `createPupitreServer()` avec `PUPITRE_PORT` pointant sur un serveur de test) :

```ts
test("read_sibling_conversation relaie le brief en texte", async () => {
  // … créer une conversation comme ci-dessus, démarrer le client MCP …
  const result = await client.callTool({ name: "read_sibling_conversation", arguments: { conversation_id: conversation.id } });
  expect((result.content as any)[0].text).toContain("Salut, voici le plan.");
});
```

**Step 2: Run test to verify it fails**

Run: `cd sidecar && bun test tests/pupitre-mcp.test.ts tests/dashboard-routes.test.ts`
Expected: FAIL — 404 / outil inconnu.

**Step 3: Write minimal implementation**

Route, à côté de `GET /api/conversations/:id/debriefs` :
```ts
        const conversationBriefId = routeId(pathname, /^\/api\/conversations\/([^/]+)\/brief$/);
        if (request.method === "GET" && conversationBriefId !== null) {
          const conversation = deps.conversations.get(conversationBriefId);
          if (!conversation) throw new HttpError(404, "conversation inconnue");
          const exchanges = deps.conversations.listEvents(conversation.id)
            .filter((event: any) => event.type === "user-message" || event.type === "text-final")
            .slice(-12)
            .map((event: any) => ({ role: event.type === "user-message" ? "user" : "assistant", text: String(event.text ?? "").slice(0, 2_000) }));
          return json({
            id: conversation.id, title: conversation.title, summary: conversation.summary,
            provider: conversation.provider, updated_at: conversation.updated_at,
            debrief: deps.debriefs.latest(conversation.id)?.content_md ?? null,
            exchanges,
          });
        }
```

`pupitre-mcp.ts` :
```ts
  server.registerTool("read_sibling_conversation", {
    title: "Lire une conversation Pupitre liée",
    description: "Rend le titre, le résumé, le dernier débrief et les derniers échanges d'une autre conversation "
      + "Pupitre du même ticket, pour creuser un point du brief de reprise sans deviner. Utilise les ids "
      + "donnés dans la section « Conversations précédentes » du brief.",
    inputSchema: { conversation_id: z.string().describe("Id de la conversation à lire.") },
  }, async (args: { conversation_id: string }) => {
    try {
      const response = await fetch(`${baseUrl()}/api/conversations/${encodeURIComponent(args.conversation_id)}/brief`);
      if (!response.ok) throw new Error(await errorMessage(response));
      const brief = await response.json() as { title: string; summary: string; debrief: string | null; exchanges: Array<{ role: string; text: string }> };
      const lines = [`# ${brief.title}`, "", brief.summary, ""];
      if (brief.debrief) lines.push("## Dernier débrief", brief.debrief, "");
      lines.push("## Derniers échanges");
      for (const exchange of brief.exchanges) lines.push(`**${exchange.role}** : ${exchange.text}`, "");
      return text(lines.join("\n"));
    } catch (error) {
      return text(`Lecture impossible : ${error instanceof Error ? error.message : String(error)}`, true);
    }
  });
```

`adapters/claude.ts` l.70 : `args.push("--allowedTools", "mcp__pupitre__publish_document,mcp__pupitre__publish_html_document,mcp__pupitre__read_sibling_conversation");` — vérifier d'abord dans `claude --help` que `--allowedTools` accepte une liste séparée par des virgules (sinon répéter l'option).

**Step 4: Run tests**

Run: `cd sidecar && bun test`
Expected: PASS.

**Step 5: Commit**

```bash
git add sidecar/src/pupitre-mcp.ts sidecar/src/server.ts sidecar/src/adapters/claude.ts sidecar/tests
git commit -m "feat(tableau-de-bord): outil MCP read_sibling_conversation"
```

---

### Task 11 : UI — types, `api.ts`, `useDashboard`

**Files:**
- Modify: `ui/src/types.ts` (l.6 `WorkspaceView` : ajouter `'dashboard'` ; `Conversation` l.213-245 : ajouter `ticket_id: string | null` et `ticket_key?: string | null` ; nouveaux types en fin de fichier)
- Modify: `ui/src/api.ts` (`CreateConversationInput` l.53-70 : `ticketId?: string | null` ; `Settings` l.136-149 : `integrationTokens?: Record<string, boolean>` ; nouvelles fonctions)
- Create: `ui/src/useDashboard.ts`
- Test: `ui/src/useDashboard.test.ts`

**Types à ajouter (`types.ts`) — miroir exact du sidecar :**

```ts
export type IntegrationType = 'clickup' | 'gitlab' | 'github' | 'notion' | 'sentry'
export type IntegrationStatus = 'ok' | 'dégradée' | 'hors ligne' | 'non configurée' | 'à reconfigurer'

export interface ProjectIntegration {
  id: string
  project_id: string
  type: IntegrationType
  config: Record<string, unknown>
  branch_pattern: string | null
  status: IntegrationStatus
  last_ok_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export type TicketSource = 'clickup' | 'notion' | 'git'
export type TicketRefKind = 'branch' | 'mr' | 'pipeline' | 'deployment' | 'sentry_issue'

export interface TicketRef { id: string; ticket_id: string; kind: TicketRefKind; ref: string; payload: Record<string, unknown>; seen_at: string }
export interface TicketNote { id: string; ticket_id: string; body: string; created_at: string }
export interface TicketConversationSummary { id: string; title: string; summary: string; provider: Provider; updated_at: string; worktree_path: string | null }

export interface TicketRow {
  id: string
  project_id: string
  key: string
  source: TicketSource
  title: string
  status: string
  external_url: string | null
  payload: Record<string, unknown>
  last_seen_at: string
  archived_at: string | null
  created_at: string
  updated_at: string
  refs: TicketRef[]
  conversations: TicketConversationSummary[]
  notes_count: number
}

export interface EnvironmentState {
  project: string
  name: string
  missing?: boolean
  branch: string | null
  key: string | null
  mergeRequestIid: number | null
  user: string | null
  deployedAt: string | null
  status: string | null
  jobUrl: string | null
}

export interface ReviewRequest {
  project: string
  iid: number
  title: string
  sourceBranch: string
  url: string
  updatedAt: string
  author: string
  draft: boolean
}

export interface DashboardPayload {
  projectId: string
  refreshedAt: string
  integrations: ProjectIntegration[]
  tickets: TicketRow[]
  environments: EnvironmentState[]
  toReview: ReviewRequest[]
}
```

**`api.ts` :**

```ts
export function getProjectDashboard(projectId: string, signal?: AbortSignal): Promise<DashboardPayload> {
  return fetchJson(`/api/projects/${routeId(projectId)}/dashboard`, { signal })
}
export function refreshProjectDashboard(projectId: string): Promise<void> {
  return fetchVoid(`/api/projects/${routeId(projectId)}/dashboard/refresh`, jsonPost({}))
}
export function listProjectIntegrations(projectId: string, signal?: AbortSignal): Promise<ProjectIntegration[]> {
  return fetchJson(`/api/projects/${routeId(projectId)}/integrations`, { signal })
}
export function saveProjectIntegration(projectId: string, type: IntegrationType, input: { config: Record<string, unknown>; branchPattern?: string | null }): Promise<ProjectIntegration> {
  return fetchJson(`/api/projects/${routeId(projectId)}/integrations/${type}`, jsonPut(input))
}
export function deleteProjectIntegration(projectId: string, type: IntegrationType): Promise<void> {
  return fetchVoid(`/api/projects/${routeId(projectId)}/integrations/${type}`, { method: 'DELETE' })
}
export function listTicketNotes(ticketId: string): Promise<TicketNote[]> {
  return fetchJson(`/api/tickets/${routeId(ticketId)}/notes`)
}
export function createTicketNote(ticketId: string, body: string): Promise<TicketNote> {
  return fetchJson(`/api/tickets/${routeId(ticketId)}/notes`, jsonPost({ body }))
}
export function deleteTicketNote(noteId: string): Promise<void> {
  return fetchVoid(`/api/ticket-notes/${routeId(noteId)}`, { method: 'DELETE' })
}
export function updateIntegrationTokens(tokens: Partial<Record<'clickup' | 'gitlab', string | null>>): Promise<Settings> {
  return fetchJson('/api/settings', jsonPut({ integrationTokens: tokens }))
}
```

**Step 1: Write the failing test** (`ui/src/useDashboard.test.ts`, patron `useFleet` : snapshot HTTP puis WS ; mocker `WebSocket` par une classe factice globale)

```ts
import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()
const { cleanup, render, screen, act } = await import('@testing-library/react')
const { useDashboard } = await import('./useDashboard')
const defaultFetch = globalThis.fetch
const DefaultSocket = globalThis.WebSocket

class FakeSocket {
  static instances: FakeSocket[] = []
  listeners: Record<string, Array<(event: any) => void>> = {}
  constructor(public url: string) { FakeSocket.instances.push(this) }
  addEventListener(name: string, fn: (event: any) => void) { (this.listeners[name] ??= []).push(fn) }
  emit(name: string, event: any) { for (const fn of this.listeners[name] ?? []) fn(event) }
  close() {}
}

afterEach(() => { cleanup(); globalThis.fetch = defaultFetch; globalThis.WebSocket = DefaultSocket; FakeSocket.instances = [] })

const payload = { projectId: 'p1', refreshedAt: 'now', integrations: [], tickets: [{ id: 't1', key: 'TECH-1', title: 'Un', status: 'open', source: 'clickup', external_url: null, payload: {}, last_seen_at: '', archived_at: null, created_at: '', updated_at: '', project_id: 'p1', refs: [], conversations: [], notes_count: 0 }], environments: [], toReview: [] }

function Probe() {
  const state = useDashboard('p1')
  return createElement('div', null, `${state.connected ? 'live' : 'off'}:${state.data?.tickets.length ?? 0}`)
}

test('charge le snapshot HTTP puis suit le canal tickets', async () => {
  globalThis.fetch = mock(async () => Response.json(payload)) as typeof fetch
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  render(createElement(Probe))
  await screen.findByText('off:1')
  const socket = FakeSocket.instances[0]!
  expect(socket.url).toContain('/ws?channel=tickets&project=p1')
  await act(async () => {
    socket.emit('open', {})
    socket.emit('message', { data: JSON.stringify({ ...payload, tickets: [...payload.tickets, { ...payload.tickets[0], id: 't2', key: 'TECH-2' }] }) })
  })
  await screen.findByText('live:2')
})
```

**Step 2: Run test to verify it fails**

Run: `cd ui && bun test src/useDashboard.test.ts`
Expected: FAIL — module introuvable.

**Step 3: Write minimal implementation** (`ui/src/useDashboard.ts`, calqué sur `useFleet.ts:130-235`)

```ts
import { useEffect, useState } from 'react'
import { getProjectDashboard } from './api'
import { reconnectDelayMs } from './backoff'
import { webSocketUrl } from './transport'
import type { DashboardPayload } from './types'

export interface DashboardState {
  data: DashboardPayload | null
  connected: boolean
  error: string | null
}

function isPayload(value: unknown): value is DashboardPayload {
  return typeof value === 'object' && value !== null && Array.isArray((value as DashboardPayload).tickets)
}

/** Snapshot HTTP d'abord, puis le canal `tickets` : l'UI ne poll jamais. */
export function useDashboard(projectId: string): DashboardState {
  const [data, setData] = useState<DashboardPayload | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let failedAttempts = 0
    const controller = new AbortController()
    setData(null)
    setError(null)

    function connect() {
      const current = new WebSocket(webSocketUrl(`/ws?channel=tickets&project=${encodeURIComponent(projectId)}`))
      socket = current
      current.addEventListener('open', () => { if (disposed) return; failedAttempts = 0; setConnected(true) })
      current.addEventListener('message', (message) => {
        if (disposed) return
        let payload: unknown
        try { payload = JSON.parse(String((message as MessageEvent).data)) } catch { return }
        if (isPayload(payload)) setData(payload)
      })
      const retry = () => {
        if (disposed || socket !== current) return
        setConnected(false)
        failedAttempts += 1
        retryTimer = setTimeout(connect, reconnectDelayMs(failedAttempts))
      }
      current.addEventListener('close', retry)
      current.addEventListener('error', retry)
    }

    void getProjectDashboard(projectId, controller.signal)
      .then((payload) => { if (!disposed) setData(payload) })
      .catch((loadError: unknown) => { if (!disposed && !controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : String(loadError)) })
    connect()
    return () => { disposed = true; controller.abort(); clearTimeout(retryTimer); socket?.close() }
  }, [projectId])

  return { data, connected, error }
}
```

**Step 4: Run tests**

Run: `cd ui && bun test src/useDashboard.test.ts && bunx tsc --noEmit`
Expected: PASS ; `tsc` vert (les nouveaux champs `ticket_id` sur `Conversation` sont optionnels dans les fixtures existantes ? Non : `ticket_id` est requis → ajouter `ticket_id: null` aux fixtures `Conversation` des tests UI existants, `Sidebar.test.ts` notamment).

**Step 5: Commit**

```bash
git add ui/src/types.ts ui/src/api.ts ui/src/useDashboard.ts ui/src/useDashboard.test.ts ui/src/Sidebar.test.ts
git commit -m "feat(tableau-de-bord): types, API client et hook temps réel du tableau"
```

---

### Task 12 : UI — `DashboardView`, CSS, Rail, App, palette

**Files:**
- Create: `ui/src/DashboardView.tsx`
- Create: `ui/src/styles/dashboard.css` (+ `@import './dashboard.css';` dans `ui/src/styles/index.css` après `costs.css`)
- Modify: `ui/src/Rail.tsx` (`NavName` l.35-48 ; `NAV_PATHS` l.49-115 ; `RailProps` l.9-33 : `onDashboardSelect: () => void` ; `nav` l.214-240 : entrée `{ name: 'dashboard', label: 'Tableau de bord', view: 'dashboard', onClick: onDashboardSelect, needsProject: true }` juste avant `git`)
- Modify: `ui/src/App.tsx` (handler `handleDashboardSelect` à côté de `handleCostsSelect` l.430 ; fil d'Ariane l.573-588 : `dashboard: 'Tableau de bord'` ; props Rail l.617-641 ; rendu après le garde projet, avant `git` l.706 ; `handlePaletteViewSelect` l.499-507)
- Modify: `ui/src/CommandPalette.tsx` (type `onViewSelect` l.31 : ajouter `'dashboard'` ; `views` l.147-157 : `['dashboard', 'Tableau de bord', 'Tickets, MR, environnements']`)
- Test: `ui/src/DashboardView.test.tsx`

**Comportement de la vue (props `{ project: Project; onConversationSelect(conversationId): void; onStartConversation(seed: { ticketId: string; branch: string | null; ticketKey: string }): void }`) :**
- En-tête : titre « Tableau de bord », baseline `project.name`, indicateur `temps réel / reconnexion` (classe `dashboard-connection is-live`, patron `fleet-connection`), bouton « Rafraîchir » (→ `refreshProjectDashboard`).
- Bandeau par intégration non `ok` : `« ClickUp : à reconfigurer — 401 »` (classe `dashboard-banner`, sémantique doublée du texte), et pour `non configurée` un lien « Configurer » qui ouvre les réglages projet (prop optionnelle `onOpenSettings`).
- Bloc **Mes tickets** : grille `.dashboard-table` avec variable `--dashboard-grid-columns`, colonnes `Ticket · Statut · Branche · MR · Pipeline · Déployé · Conversations · Actions` ; la colonne « Déployé » **n'existe que si** `data.integrations.some(i => i.type === 'gitlab')` (classe modificatrice `dashboard-table--with-gitlab`, même mécanisme que `costs.css:57-60`). Chaque ligne : clé en `--font-mono` + titre, statut (pastille colorée par `payload.statusColor` **et** texte), branche (`BranchIcon`), MR (lien `external` avec `mergeStatus` en texte), pipeline (statut texte + classe `is-ok/is-warn/is-danger` selon `success / running|manual|pending / failed|canceled`), déploiement (`environment · user`), compteur de conversations (clic → liste dépliable de `conversations` avec `onConversationSelect`), actions : **Démarrer** si `conversations.length === 0` sinon **Reprendre** (→ `onStartConversation`), lien externe, « Notes (n) » qui déplie un mini-formulaire `createTicketNote` + liste.
- Bloc **Environnements** (si des `environments`) : une ligne par env : `project · name`, branche + clé, `user`, date relative, `missing` → « introuvable ».
- Bloc **À relire** (si `toReview.length`) : `project!iid · title · author · âge`, lien.
- Empty states : `.dashboard-empty` avec titre + phrase (« Aucun ticket pour ce projet — configure ClickUp ou GitLab, ou démarre une conversation sur une branche. »).

**Step 1: Write the failing test**

```tsx
import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { DashboardPayload, Project } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { DashboardView } = await import('./DashboardView')
const defaultFetch = globalThis.fetch
const DefaultSocket = globalThis.WebSocket
class SilentSocket { constructor(public url: string) {} addEventListener() {} close() {} }
afterEach(() => { cleanup(); globalThis.fetch = defaultFetch; globalThis.WebSocket = DefaultSocket })

const project = { id: 'p1', name: 'affilae-mono', path: '/tmp/mono' } as Project
const ticket = { id: 't1', project_id: 'p1', key: 'TECH-24657', source: 'clickup', title: 'Leviers', status: 'in progress', external_url: 'https://app.clickup.com/t/x', payload: { statusColor: '#4466ff' }, last_seen_at: '', archived_at: null, created_at: '', updated_at: '2026-08-19T10:00:00Z', notes_count: 0,
  refs: [
    { id: 'r1', ticket_id: 't1', kind: 'branch', ref: 'feature/TECH-24657', payload: {}, seen_at: '' },
    { id: 'r2', ticket_id: 't1', kind: 'mr', ref: 'reactor!1862', payload: { url: 'https://git/1862', mergeStatus: 'mergeable', state: 'opened' }, seen_at: '' },
    { id: 'r3', ticket_id: 't1', kind: 'pipeline', ref: 'reactor!1862', payload: { status: 'failed', url: 'https://git/p' }, seen_at: '' },
  ],
  conversations: [{ id: 'c1', title: 'Première passe', summary: '', provider: 'claude', updated_at: '', worktree_path: '/wt' }] }
const withGitlab: DashboardPayload = { projectId: 'p1', refreshedAt: '', integrations: [{ id: 'i1', project_id: 'p1', type: 'gitlab', config: {}, branch_pattern: null, status: 'dégradée', last_ok_at: null, last_error: 'fetch failed', created_at: '', updated_at: '' }], tickets: [ticket as any], environments: [{ project: 'reactor', name: 'preprod', branch: 'feature/TECH-23903', key: 'TECH-23903', mergeRequestIid: 1815, user: 'theo.micaletti', deployedAt: '2026-08-18T08:44:45Z', status: 'success', jobUrl: null }], toReview: [] }

function mount(payload: DashboardPayload, onStart = mock(() => {})) {
  globalThis.fetch = mock(async () => Response.json(payload)) as typeof fetch
  globalThis.WebSocket = SilentSocket as unknown as typeof WebSocket
  render(createElement(DashboardView, { project, onConversationSelect: () => {}, onStartConversation: onStart }))
  return onStart
}

test('rend une ligne par ticket, la colonne Déployé avec GitLab, et le bandeau de dégradation', async () => {
  mount(withGitlab)
  await screen.findByText('TECH-24657')
  expect(document.querySelectorAll('.dashboard-row:not(.dashboard-head)')).toHaveLength(1)
  expect(document.querySelector('.dashboard-table--with-gitlab')).not.toBeNull()
  expect(screen.getByText(/GitLab/).textContent).toContain('dégradée')
  expect(screen.getByText('failed')).toBeTruthy()
  expect(screen.getByText('preprod')).toBeTruthy()
})

test('Reprendre transmet ticket et branche ; sans GitLab la colonne Déployé disparaît', async () => {
  const onStart = mount({ ...withGitlab, integrations: [], environments: [] })
  const button = await screen.findByRole('button', { name: 'Reprendre' })
  fireEvent.click(button)
  expect(onStart).toHaveBeenCalledWith({ ticketId: 't1', branch: 'feature/TECH-24657', ticketKey: 'TECH-24657' })
  expect(document.querySelector('.dashboard-table--with-gitlab')).toBeNull()
})

test('un ticket sans conversation propose Démarrer', async () => {
  mount({ ...withGitlab, tickets: [{ ...ticket, conversations: [] } as any] })
  expect(await screen.findByRole('button', { name: 'Démarrer' })).toBeTruthy()
})
```

**Step 2: Run test to verify it fails**

Run: `cd ui && bun test src/DashboardView.test.tsx`
Expected: FAIL — module introuvable.

**Step 3: Write minimal implementation**

Squelette de `DashboardView.tsx` (compléter les cellules selon le comportement décrit ; rester fidèle aux classes listées pour que `deadCss.test.ts` reste vert) :

```tsx
import { useMemo, useState } from 'react'
import { BranchIcon } from './BranchIcon'
import { createTicketNote, listTicketNotes, refreshProjectDashboard } from './api'
import { useDashboard } from './useDashboard'
import type { Project, TicketRow, TicketRef, TicketNote } from './types'

interface DashboardViewProps {
  project: Project
  onConversationSelect: (conversationId: string) => void
  onStartConversation: (seed: { ticketId: string; branch: string | null; ticketKey: string }) => void
  onOpenSettings?: () => void
}

const INTEGRATION_LABEL: Record<string, string> = { clickup: 'ClickUp', gitlab: 'GitLab', github: 'GitHub', notion: 'Notion', sentry: 'Sentry' }

function refOf(ticket: TicketRow, kind: TicketRef['kind']): TicketRef | undefined {
  return ticket.refs.find((ref) => ref.kind === kind)
}

function pipelineTone(status: string | undefined): string {
  if (!status) return ''
  if (status === 'success') return 'is-ok'
  if (status === 'failed' || status === 'canceled') return 'is-danger'
  return 'is-warn'
}

function relative(iso: string | null | undefined): string {
  if (!iso) return '—'
  const diff = Date.now() - Date.parse(iso)
  if (!Number.isFinite(diff)) return '—'
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} j`
}

export function DashboardView({ project, onConversationSelect, onStartConversation, onOpenSettings }: DashboardViewProps) {
  const { data, connected, error } = useDashboard(project.id)
  const [openTicket, setOpenTicket] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, TicketNote[]>>({})
  const [draftNote, setDraftNote] = useState('')
  const hasGitlab = data?.integrations.some((item) => item.type === 'gitlab') ?? false
  const tableClassName = useMemo(() => `dashboard-table${hasGitlab ? ' dashboard-table--with-gitlab' : ''}`, [hasGitlab])
  const degraded = data?.integrations.filter((item) => item.status !== 'ok') ?? []

  async function toggleNotes(ticket: TicketRow) {
    if (openTicket === ticket.id) { setOpenTicket(null); return }
    setOpenTicket(ticket.id)
    setNotes((current) => ({ ...current, [ticket.id]: current[ticket.id] ?? [] }))
    try { setNotes((current) => ({ ...current })); const loaded = await listTicketNotes(ticket.id); setNotes((current) => ({ ...current, [ticket.id]: loaded })) } catch { /* le bandeau d'erreur suffit */ }
  }

  async function addNote(ticket: TicketRow) {
    const body = draftNote.trim()
    if (!body) return
    const note = await createTicketNote(ticket.id, body)
    setNotes((current) => ({ ...current, [ticket.id]: [...(current[ticket.id] ?? []), note] }))
    setDraftNote('')
  }

  return (
    <section className="dashboard-view" aria-labelledby="dashboard-title">
      <div className="dashboard-scroll">
        <header className="dashboard-header">
          <div>
            <h1 id="dashboard-title">Tableau de bord</h1>
            <p className="dashboard-baseline">{project.name}</p>
          </div>
          <div className="dashboard-header-actions">
            <span className={`dashboard-connection ${connected ? 'is-live' : ''}`}><i aria-hidden="true" /> {connected ? 'temps réel' : 'reconnexion'}</span>
            <button type="button" className="secondary-button" onClick={() => void refreshProjectDashboard(project.id).catch(() => {})}>Rafraîchir</button>
          </div>
        </header>
        {error ? <p className="dashboard-banner is-danger">Tableau indisponible : {error}</p> : null}
        {degraded.map((item) => (
          <p key={item.id} className={`dashboard-banner ${item.status === 'non configurée' ? '' : 'is-warn'}`}>
            {INTEGRATION_LABEL[item.type] ?? item.type} : {item.status}{item.last_error ? ` — ${item.last_error}` : ''}
            {item.status === 'non configurée' && onOpenSettings ? <button type="button" className="text-button" onClick={onOpenSettings}>Configurer</button> : null}
          </p>
        ))}

        <h2 className="dashboard-section-title">Mes tickets</h2>
        {data === null ? null : data.tickets.length === 0 ? (
          <div className="dashboard-empty"><strong>Aucun ticket pour ce projet</strong><p>Configure ClickUp ou GitLab, ou démarre une conversation sur une branche.</p></div>
        ) : (
          <div className={tableClassName} role="region" aria-label="Mes tickets">
            <div className="dashboard-row dashboard-head">
              <span>Ticket</span><span>Statut</span><span>Branche</span><span>MR</span><span>Pipeline</span>{hasGitlab ? <span>Déployé</span> : null}<span>Conv.</span><span>Actions</span>
            </div>
            {data.tickets.map((ticket) => {
              const branch = refOf(ticket, 'branch')
              const mr = refOf(ticket, 'mr')
              const pipeline = refOf(ticket, 'pipeline')
              const deployment = refOf(ticket, 'deployment')
              const pipelineStatus = pipeline ? String(pipeline.payload.status ?? '') : ''
              return (
                <div className="dashboard-row" key={ticket.id}>
                  <span className="dashboard-ticket"><strong className="dashboard-key">{ticket.key}</strong><small>{ticket.title}</small></span>
                  <span className="dashboard-status"><i aria-hidden="true" style={{ background: String(ticket.payload.statusColor ?? 'var(--text-faint)') }} />{ticket.status || '—'}</span>
                  <span className="dashboard-branch">{branch ? <><BranchIcon />{branch.ref}</> : '—'}</span>
                  <span>{mr ? <a href={String(mr.payload.url ?? '#')} target="_blank" rel="noreferrer">{mr.ref} · {String(mr.payload.mergeStatus ?? mr.payload.state ?? '')}</a> : '—'}</span>
                  <span className={`dashboard-pipeline ${pipelineTone(pipelineStatus)}`}>{pipeline ? <a href={String(pipeline.payload.url ?? '#')} target="_blank" rel="noreferrer">{pipelineStatus}</a> : '—'}</span>
                  {hasGitlab ? <span>{deployment ? `${String(deployment.payload.environment ?? '')} · ${String(deployment.payload.user ?? '')}` : '—'}</span> : null}
                  <span>
                    {ticket.conversations.length === 0 ? '0' : (
                      <details className="dashboard-conversations"><summary>{ticket.conversations.length}</summary>
                        <ul>{ticket.conversations.map((c) => <li key={c.id}><button type="button" className="text-button" onClick={() => onConversationSelect(c.id)}>{c.title}</button></li>)}</ul>
                      </details>
                    )}
                  </span>
                  <span className="dashboard-actions">
                    <button type="button" className="primary-button" onClick={() => onStartConversation({ ticketId: ticket.id, branch: branch?.ref ?? null, ticketKey: ticket.key })}>
                      {ticket.conversations.length === 0 ? 'Démarrer' : 'Reprendre'}
                    </button>
                    {ticket.external_url ? <a className="text-button" href={ticket.external_url} target="_blank" rel="noreferrer">Ouvrir</a> : null}
                    <button type="button" className="text-button" onClick={() => void toggleNotes(ticket)}>Notes ({(notes[ticket.id] ?? []).length || ticket.notes_count})</button>
                  </span>
                  {openTicket === ticket.id ? (
                    <div className="dashboard-notes">
                      <ul>{(notes[ticket.id] ?? []).map((note) => <li key={note.id}>{note.body}</li>)}</ul>
                      <form onSubmit={(event) => { event.preventDefault(); void addNote(ticket) }}>
                        <input value={draftNote} onChange={(event) => setDraftNote(event.target.value)} placeholder="Ajouter une note" aria-label="Nouvelle note" />
                        <button type="submit" className="secondary-button">Ajouter</button>
                      </form>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}

        {data && data.environments.length > 0 ? (
          <>
            <h2 className="dashboard-section-title">Environnements</h2>
            <div className="dashboard-envs" role="region" aria-label="Environnements">
              <div className="dashboard-env-row dashboard-head"><span>Environnement</span><span>Branche</span><span>Par</span><span>Depuis</span></div>
              {data.environments.map((env) => (
                <div className="dashboard-env-row" key={`${env.project}:${env.name}`}>
                  <span><small>{env.project}</small> <strong>{env.name}</strong></span>
                  <span>{env.missing ? 'introuvable' : env.branch ? <><BranchIcon />{env.branch}{env.key ? <small> · {env.key}</small> : null}</> : '—'}</span>
                  <span>{env.user ?? '—'}</span>
                  <span>{relative(env.deployedAt)}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {data && data.toReview.length > 0 ? (
          <>
            <h2 className="dashboard-section-title">À relire</h2>
            <ul className="dashboard-review">
              {data.toReview.map((mr) => (
                <li key={`${mr.project}!${mr.iid}`}>
                  <a href={mr.url} target="_blank" rel="noreferrer"><strong>{mr.project}!{mr.iid}</strong> {mr.title}</a>
                  <small>{mr.author} · {relative(mr.updatedAt)}</small>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </section>
  )
}
```

> Nettoyer `toggleNotes` (le `setNotes((current) => ({ ...current }))` inutile est un reliquat — garder uniquement le chargement). Les `<details>` imbriqués dans une grille sont acceptables en happy-dom ; vérifier le rendu réel à la tâche 17.

`dashboard.css` — uniquement des tokens (`docs/DESIGN-SYSTEM.md`) :

```css
.dashboard-view { height: 100%; overflow: hidden; background: var(--bg-workspace); }
.dashboard-scroll { height: 100%; overflow: auto; padding: var(--space-5) var(--space-6); }
.dashboard-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
.dashboard-header h1 { font-size: var(--text-lg); color: var(--text-strong); margin: 0; }
.dashboard-baseline { color: var(--text-muted); font-size: var(--text-sm); margin: var(--space-1) 0 0; }
.dashboard-header-actions { display: flex; align-items: center; gap: var(--space-3); }
.dashboard-connection { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--text-muted); font-size: var(--text-xs); }
.dashboard-connection i { width: 6px; height: 6px; border-radius: var(--r-full); background: var(--text-faint); }
.dashboard-connection.is-live i { background: var(--ok); }
.dashboard-banner { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--r-sm); color: var(--text); font-size: var(--text-sm); margin-bottom: var(--space-3); }
.dashboard-banner.is-warn { border-color: var(--warn); }
.dashboard-banner.is-danger { border-color: var(--danger); }
.dashboard-section-title { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: .06em; color: var(--text-faint); margin: var(--space-5) 0 var(--space-2); }
.dashboard-table, .dashboard-envs { background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: var(--r-md); overflow: hidden; }
.dashboard-table { --dashboard-grid-columns: minmax(200px, 1.6fr) minmax(110px, .8fr) minmax(160px, 1.2fr) minmax(150px, 1fr) minmax(90px, .6fr) minmax(60px, .4fr) minmax(200px, 1.2fr); }
.dashboard-table--with-gitlab { --dashboard-grid-columns: minmax(200px, 1.6fr) minmax(110px, .8fr) minmax(160px, 1.2fr) minmax(150px, 1fr) minmax(90px, .6fr) minmax(140px, .9fr) minmax(60px, .4fr) minmax(200px, 1.2fr); }
.dashboard-row { display: grid; grid-template-columns: var(--dashboard-grid-columns); gap: var(--space-3); align-items: center; padding: var(--space-2) var(--space-3); border-top: 1px solid var(--border-subtle); font-size: var(--text-sm); min-height: 32px; }
.dashboard-row:first-child { border-top: 0; }
.dashboard-head { color: var(--text-faint); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: .06em; }
.dashboard-ticket { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dashboard-ticket small { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dashboard-key { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text-strong); }
.dashboard-status { display: inline-flex; align-items: center; gap: var(--space-2); }
.dashboard-status i { width: 8px; height: 8px; border-radius: var(--r-full); }
.dashboard-branch { display: inline-flex; align-items: center; gap: var(--space-1); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dashboard-pipeline.is-ok a { color: var(--ok); }
.dashboard-pipeline.is-warn a { color: var(--warn); }
.dashboard-pipeline.is-danger a { color: var(--danger); }
.dashboard-conversations summary { cursor: pointer; font-family: var(--font-mono); }
.dashboard-conversations ul { margin: var(--space-1) 0 0; padding: 0; list-style: none; }
.dashboard-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.dashboard-notes { grid-column: 1 / -1; padding: var(--space-2) 0 var(--space-1) var(--space-2); border-left: 2px solid var(--border); }
.dashboard-notes ul { margin: 0 0 var(--space-2); padding-left: var(--space-4); color: var(--text); }
.dashboard-notes form { display: flex; gap: var(--space-2); }
.dashboard-notes input { flex: 1; background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--r-sm); color: var(--text); padding: var(--space-1) var(--space-2); }
.dashboard-env-row { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(220px, 1.6fr) minmax(140px, .8fr) minmax(80px, .5fr); gap: var(--space-3); align-items: center; padding: var(--space-2) var(--space-3); border-top: 1px solid var(--border-subtle); font-size: var(--text-sm); }
.dashboard-env-row:first-child { border-top: 0; }
.dashboard-review { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.dashboard-review li { display: flex; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) var(--space-3); background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: var(--r-md); }
.dashboard-empty { padding: var(--space-6); text-align: center; color: var(--text-muted); background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: var(--r-md); }
.dashboard-empty strong { display: block; color: var(--text-strong); margin-bottom: var(--space-1); }
```

Rail : icône `dashboard: <path d="M2 3h5v5H2zM9 3h5v3H9zM9 8h5v5H9zM2 10h5v3H2z" />`. App : `handleDashboardSelect` = copie de `handleCostsSelect` avec `'dashboard'` ; rendu `workspaceView === 'dashboard' ? <DashboardView project={selectedProject} onConversationSelect={(id) => void handleGitConversationSelect(id)} onStartConversation={handleStartFromTicket} onOpenSettings={…} />` (le handler `handleStartFromTicket` arrive à la tâche 13 ; pour cette tâche, passer `() => {}`).

**Step 4: Run tests**

Run: `cd ui && bun test && bunx tsc --noEmit`
Expected: PASS (y compris `deadCss.test.ts`).

**Step 5: Commit**

```bash
git add ui/src/DashboardView.tsx ui/src/DashboardView.test.tsx ui/src/styles/dashboard.css ui/src/styles/index.css ui/src/Rail.tsx ui/src/App.tsx ui/src/CommandPalette.tsx
git commit -m "feat(tableau-de-bord): vue Tableau de bord, entrée du rail et de la palette"
```

---

### Task 13 : UI — Démarrer / Reprendre depuis le tableau

**Files:**
- Modify: `ui/src/App.tsx` (état `conversationSeed`, handler `handleStartFromTicket`, passage à `Chat`, reset dans `handleConversationCreated` / `handleConversationClosed`)
- Modify: `ui/src/Chat.tsx` (prop `initialConfig?: Partial<ConversationConfig>` et `ticketId?: string | null`, transmis au `Composer` l.338)
- Modify: `ui/src/Composer.tsx` (props `initialConfig`, `ticketId` ; `useState<ConversationConfig>` l.189 : fusionner `initialConfig` ; l.361 : `ticketId` dans `buildCreateConversationInput`)
- Modify: `ui/src/ConfigPanel.tsx` (`ConversationConfig` l.22-34 : `ticketKey?: string | null` pour l'affichage ; l.131, l.158, l.243, l.286 : préserver `branch` et `ticketKey` quand un preset est appliqué ; afficher la clé de ticket à côté du champ Branche)
- Modify: `ui/src/conversationDraft.ts` (`ticketId` dans le draft et le contrat)
- Test: `sidecar/tests/ui-conversation-draft.test.ts` (étendre), `ui/src/ConfigPanel.test.tsx` (créer si absent) 

**Step 1: Write the failing tests**

Dans `sidecar/tests/ui-conversation-draft.test.ts` :
```ts
test("transmet ticketId et garde la branche", () => {
  const input = buildCreateConversationInput({ projectId: "p", provider: "claude", model: "m", effort: "high", speed: "standard", orchestrator: true, branch: " feature/TECH-1 ", ticketId: "t1", message: "x", images: [] });
  expect(input.branch).toBe("feature/TECH-1");
  expect(input.ticketId).toBe("t1");
});
```

`ui/src/ConfigPanel.test.tsx` (patron `HtmlDocumentCard.test.tsx`) :
```tsx
test("appliquer le preset par défaut du projet ne perd pas la branche ni le ticket", async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/presets')) return Response.json([{ id: 'preset-1', name: 'Éco', provider: 'claude', model: 'claude-haiku-4-5-20251001', effort: 'low', speed: 'standard', orchestrator: true, built_in: true, permission_mode: null, subagent_preset_id: null, subagent_effort: null }])
    if (url.includes('/git')) return Response.json({ branches: [], worktrees: [], commits: [], currentBranch: 'develop' })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  const changes: ConversationConfig[] = []
  render(createElement(ConfigPanel, {
    project: { id: 'p1', name: 'mono', path: '/tmp', default_preset_id: 'preset-1' } as Project,
    config: { presetId: null, provider: 'claude', model: 'claude-fable-5', effort: 'high', speed: 'standard', permissionMode: null, orchestrator: true, subagentPresetId: null, subagentEffort: null, branch: 'feature/TECH-1', ticketKey: 'TECH-1' },
    onConfigChange: (next) => changes.push(next),
    applyProjectDefault: true,
  } as any))
  await waitFor(() => expect(changes.length).toBeGreaterThan(0))
  expect(changes.at(-1)).toEqual(expect.objectContaining({ presetId: 'preset-1', branch: 'feature/TECH-1', ticketKey: 'TECH-1' }))
})
```
> Adapter les props obligatoires de `ConfigPanel` (lire `ConfigPanelProps` dans le fichier) ; l'intention du test : après application d'un preset, `branch` et `ticketKey` survivent.

**Step 2: Run tests to verify they fail**

Run: `cd sidecar && bun test tests/ui-conversation-draft.test.ts ; cd ../ui && bun test src/ConfigPanel.test.tsx`
Expected: FAIL — `ticketId` absent du contrat ; `branch` perdu après preset.

**Step 3: Write minimal implementation**

- `conversationDraft.ts` : ajouter `ticketId?: string | null` au draft et `ticketId: draft.ticketId ?? null` au résultat ; `api.ts` `CreateConversationInput.ticketId?: string | null`.
- `ConfigPanel.tsx` : 
  ```ts
  function keepBranch(next: ConversationConfig, current: ConversationConfig): ConversationConfig {
    return { ...next, branch: current.branch ?? null, ticketKey: current.ticketKey ?? null }
  }
  ```
  et remplacer les quatre `onConfigChange(configOf(x))` par `onConfigChange(keepBranch(configOf(x), configRef.current))`. Sous le champ Branche, si `config.ticketKey` : `<small className="config-ticket">Ticket {config.ticketKey}</small>` (ajouter `.config-ticket { color: var(--text-muted); font-size: var(--text-xs); }` dans `composer.css` ou la feuille où vit `.config-branch`).
- `Composer.tsx` : props `initialConfig?: Partial<ConversationConfig>` et `ticketId?: string | null` ; `useState<ConversationConfig>({ …défauts…, ...initialConfig })` ; dans `buildCreateConversationInput({ …, ticketId: ticketId ?? null })`.
- `Chat.tsx` : mêmes deux props, transmises au `Composer`.
- `App.tsx` :
  ```ts
  const [conversationSeed, setConversationSeed] = useState<{ ticketId: string; ticketKey: string; branch: string | null } | null>(null)
  function handleStartFromTicket(seed: { ticketId: string; branch: string | null; ticketKey: string }) {
    if (!confirmLeaveMemory() || selectedProject === null) return
    setConversationSeed(seed)
    setSelectedConversation(null)
    setNewConversationDraft('')
    setNewConversationAttachments([])
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    setWorkspaceView('conversations')
  }
  ```
  `handleConversationCreate` (bouton sidebar) fait `setConversationSeed(null)` ; `handleConversationCreated` et `handleConversationClosed` aussi. Le `<Chat>` de création reçoit `initialConfig={conversationSeed ? { branch: conversationSeed.branch, ticketKey: conversationSeed.ticketKey } : undefined}` et `ticketId={conversationSeed?.ticketId ?? null}` ; inclure `conversationSeed?.ticketId ?? ''` dans la `key` du `Chat` de création (l.810) pour remonter un Composer frais.
  `DashboardView` reçoit `onStartConversation={handleStartFromTicket}` et `onOpenSettings` qui ouvre `ProjectSettingsDialog` (réutiliser l'état existant qui le monte depuis `App.tsx:867`).

**Step 4: Run tests**

Run: `cd ui && bun test && bunx tsc --noEmit && cd ../sidecar && bun test tests/ui-conversation-draft.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add ui/src/App.tsx ui/src/Chat.tsx ui/src/Composer.tsx ui/src/ConfigPanel.tsx ui/src/ConfigPanel.test.tsx ui/src/conversationDraft.ts ui/src/api.ts ui/src/styles sidecar/tests/ui-conversation-draft.test.ts
git commit -m "feat(tableau-de-bord): démarrer ou reprendre un ticket sur sa branche depuis le tableau"
```

---

### Task 14 : UI — sidebar groupée par ticket

**Files:**
- Modify: `ui/src/Sidebar.tsx` (`groupConversations` l.127-153 ; rendu des groupes l.526 ; ligne l.549-661 pour une pastille de clé)
- Modify: `ui/src/styles/sidebar.css` (classe `.conv-row-ticket`)
- Test: `ui/src/Sidebar.test.ts` (ajouter un cas)

**Comportement :** les conversations qui portent un `ticket_key` sont regroupées **d'abord**, un groupe par clé (`TECH-24657 · n`), triés par `updated_at` la plus récente du groupe ; les épinglées restent en tête dans leur groupe ; les conversations sans ticket gardent les groupes de récence actuels. Une conversation à ticket affiche sa clé en `--font-mono` avant la branche.

**Step 1: Write the failing test** (dans `Sidebar.test.ts`, avec les fixtures existantes ; `ticket_id`/`ticket_key` sur deux conversations)

```ts
test('regroupe les conversations par ticket avant la récence', async () => {
  // fixtures : c1 (ticket_key 'TECH-1', updated il y a 1 j), c2 (ticket_key 'TECH-1', aujourd'hui), c3 (sans ticket, aujourd'hui)
  // … rendu de <Sidebar> comme dans les tests existants …
  const headers = [...document.querySelectorAll('.conv-group-header span:first-child')].map((el) => el.textContent)
  expect(headers[0]).toBe('TECH-1 · 2')
  expect(headers).toContain("Aujourd'hui")
  expect(document.querySelectorAll('.conv-row-ticket')).toHaveLength(2)
})
```

**Step 2: Run test to verify it fails**

Run: `cd ui && bun test src/Sidebar.test.ts`
Expected: FAIL — pas de groupe `TECH-1 · 2`.

**Step 3: Write minimal implementation**

```ts
function groupConversations(items: Conversation[]): ConversationGroup[] {
  const byTicket = new Map<string, Conversation[]>()
  const rest: Conversation[] = []
  for (const conversation of items) {
    const key = conversation.ticket_key ?? null
    if (key) { const list = byTicket.get(key) ?? []; list.push(conversation); byTicket.set(key, list) }
    else rest.push(conversation)
  }
  const ticketGroups: ConversationGroup[] = [...byTicket.entries()]
    .map(([key, list]) => ({ key: `ticket-${key}`, label: `${key} · ${list.length}`, items: list, latest: Math.max(...list.map((c) => Date.parse(c.updated_at))) }))
    .sort((a, b) => b.latest - a.latest)
    .map(({ latest: _latest, ...group }) => group)
  return [...ticketGroups, ...groupByRecency(rest)]
}
```
où `groupByRecency` est l'ancien corps de `groupConversations` (renommé). Dans la ligne, avant le bloc branche (l.580) : `{conversation.ticket_key ? <span className="conv-row-ticket">{conversation.ticket_key}</span> : null}` ; CSS : `.conv-row-ticket { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); margin-right: var(--space-1); }`.

**Step 4: Run tests**

Run: `cd ui && bun test && bunx tsc --noEmit`
Expected: PASS.

**Step 5: Commit**

```bash
git add ui/src/Sidebar.tsx ui/src/Sidebar.test.ts ui/src/styles/sidebar.css
git commit -m "feat(tableau-de-bord): sidebar groupée par ticket"
```

---

### Task 15 : UI — réglages : Intégrations (projet) et tokens (app)

**Files:**
- Modify: `ui/src/ProjectSettingsDialog.tsx` (nouvelle section après « Serveurs MCP chargés », l.214-326 ; sauvegarde dans `handleSave` l.128-149)
- Modify: `ui/src/AppSettingsView.tsx` (section « Tokens d'intégration » : deux champs `password` ClickUp / GitLab, état « défini / non défini » depuis `settings.integrationTokens`, bouton Enregistrer → `updateIntegrationTokens`, bouton Effacer → `null`)
- Modify: `ui/src/styles/settings.css` / `dialogs.css` si une classe manque
- Test: `ui/src/ProjectSettingsDialog.test.tsx` (créer si absent ; patron `HtmlDocumentCard.test.tsx`)

**Section Intégrations (projet)** — formulaire volontairement simple, une carte par type :
- **ClickUp** : case « Activer », `Team ID`, `Listes (ids séparés par des virgules)`.
- **GitLab** : case « Activer », `Hôte` (`https://git.kaizen-hosting.com`), **projets** : lignes `chemin · libellé · environnements (virgules)` avec « + Ajouter un projet », et note « Token : celui de `glab` est utilisé automatiquement ; sinon, renseigne-le dans Paramètres › Tokens ».
- **Motif de branche** (commun) : champ texte, valeur par défaut proposée `^(issue|maintenance|feature)/(TECH-\d+)`, aide « la clé du ticket est le dernier groupe capturant ».
- À l'enregistrement : pour chaque type, `saveProjectIntegration` si activé, `deleteProjectIntegration` si désactivé et existait. Chargement tolérant à la panne comme la section MCP.

**Step 1: Write the failing test**

```tsx
test('enregistre une intégration GitLab avec son motif de branche', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/integrations') && (!init || init.method === undefined)) return Response.json([])
    if (url.endsWith('/presets')) return Response.json([])
    if (url.endsWith('/mcp-servers')) return Response.json({ servers: [], enabled: [], weights: {} })
    if (init?.method === 'PUT') { calls.push({ url, body: JSON.parse(String(init.body)) }); return Response.json({ id: 'i1', type: 'gitlab', status: 'non configurée' }) }
    return Response.json({ id: 'p1', name: 'mono' })
  }) as typeof fetch
  render(createElement(ProjectSettingsDialog, { project: { id: 'p1', name: 'mono', path: '/tmp', filesystem_scope: 'project-and-ai-roots' } as Project, onClose: () => {}, onUpdated: () => {} }))
  fireEvent.click(await screen.findByLabelText('Activer GitLab'))
  fireEvent.change(screen.getByLabelText('Hôte GitLab'), { target: { value: 'https://git.example' } })
  fireEvent.change(screen.getByLabelText('Motif de branche'), { target: { value: '^(issue|feature)/(TECH-\\d+)' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/integrations/gitlab'))).toBe(true))
  const saved = calls.find((c) => c.url.endsWith('/integrations/gitlab'))!.body as any
  expect(saved.config.host).toBe('https://git.example')
  expect(saved.branchPattern).toBe('^(issue|feature)/(TECH-\\d+)')
})
```
> Vérifier les routes réellement appelées au montage du dialogue (presets, MCP, etc.) et les mocker toutes ; la 404 explicite par défaut aide à les repérer.

**Step 2: Run test to verify it fails**

Run: `cd ui && bun test src/ProjectSettingsDialog.test.tsx`
Expected: FAIL — pas de case « Activer GitLab ».

**Step 3: Write minimal implementation**

État local : `integrations: { clickup: { enabled, teamId, listIds }, gitlab: { enabled, host, projects: Array<{path,label,environments}> }, branchPattern }`, initialisé depuis `listProjectIntegrations(project.id)` dans un `useEffect` tolérant. Dans `handleSave`, après les presets :
```ts
      for (const type of ['clickup', 'gitlab'] as const) {
        const form = integrations[type]
        if (form.enabled) {
          const config = type === 'clickup'
            ? { teamId: form.teamId.trim(), listIds: form.listIds.split(',').map((s) => s.trim()).filter(Boolean) }
            : { host: form.host.trim(), projects: form.projects.map((p) => ({ path: p.path.trim(), label: p.label.trim() || p.path.trim(), environments: p.environments.split(',').map((s) => s.trim()).filter(Boolean) })) }
          await saveProjectIntegration(project.id, type, { config, branchPattern: integrations.branchPattern.trim() || null })
        } else if (form.existed) {
          await deleteProjectIntegration(project.id, type)
        }
      }
```
Libellés accessibles exacts : « Activer ClickUp », « Team ID », « Listes ClickUp », « Activer GitLab », « Hôte GitLab », « Projets GitLab » (chaque ligne : « Chemin », « Libellé », « Environnements »), « Motif de branche ».

`AppSettingsView.tsx` : section « Tokens d'intégration » avec deux `<input type="password">` (« Token ClickUp », « Token GitLab (optionnel si glab est connecté) »), état « défini » lu depuis `settings.integrationTokens?.clickup === true`, boutons « Enregistrer » (`updateIntegrationTokens({ clickup: value || undefined, … })`) et « Effacer » (`{ clickup: null }`). Jamais de relecture de la valeur : le champ reste vide après enregistrement, seul le badge « défini » change.

**Step 4: Run tests**

Run: `cd ui && bun test && bunx tsc --noEmit`
Expected: PASS.

**Step 5: Commit**

```bash
git add ui/src/ProjectSettingsDialog.tsx ui/src/ProjectSettingsDialog.test.tsx ui/src/AppSettingsView.tsx ui/src/styles
git commit -m "feat(tableau-de-bord): réglages des intégrations par projet et tokens d'intégration"
```

---

### Task 16 : Docs

**Files:**
- Modify: `README.md` (nouvelle section « Tableau de bord (tranche A) » après « Fleet, recherche et palette »)
- Create: `docs/help/tableau-de-bord.md` (même format que les autres pages de `docs/help/` — lire une page existante pour le front-matter et les liens contextuels ; enregistrer la page là où l'index d'aide les référence, cf. `sidecar/src/server.ts` ou le module help)

**Contenu README (10-15 lignes) :** ce qu'est un Ticket, d'où viennent les données (ClickUp + GitLab, relève toutes les 5 min sans LLM, token glab réutilisé), ce que font Démarrer/Reprendre (worktree partagé, brief injecté, `read_sibling_conversation`), où configurer (réglages projet › Intégrations ; Paramètres › Tokens), ce que la tranche A ne fait pas encore (domaines, Notion, Répétitions, Sentry — renvoyer au design).

**Step 1-5 :** écrire, relire, `cd sidecar && bun test` (certains tests indexent les pages d'aide), commit :

```bash
git add README.md docs/help/tableau-de-bord.md
git commit -m "docs(tableau-de-bord): README et page d'aide"
```

---

### Task 17 : Vérification navigateur de bout en bout

**Pré-requis :** sidecar rechargé (`pkill -f "sidecar/src/index.ts"` après avoir vérifié qu'aucun tour ne tourne), Vite sur `http://localhost:5173`, un token ClickUp saisi dans Paramètres › Tokens, `glab` connecté.

**Parcours à vérifier avec Claude in Chrome, en mesurant dans le DOM :**
1. Projet `affilae-mono` → Réglages projet → Intégrations : activer ClickUp (team `20556900`, listes `900100168537,900500195250,901503919889`) et GitLab (hôte `https://git.kaizen-hosting.com`, projets `Affilae/symfony · reactor · preprod,preprod_testing,testing2,preprod_testing_3,preprod_testing_4` et `Affilae/hapigator · hapigator ·` vide), motif `^(issue|maintenance|feature)/(TECH-\d+)`. Enregistrer.
2. Ouvrir le Tableau de bord : attendre le passage `reconnexion → temps réel`. Compter `.dashboard-row:not(.dashboard-head)` et comparer à `curl -s localhost:4820/api/projects/<id>/dashboard | jq '.tickets | length'` — **égalité exigée**. Vérifier qu'au moins un ticket porte une MR et un pipeline (`jq '[.tickets[].refs[].kind] | unique'`).
3. Bloc Environnements : 5 lignes reactor ; `preprod` doit afficher une branche et un auteur (pas « introuvable »).
4. Cliquer **Reprendre** sur un ticket qui a déjà une conversation : le Composer s'ouvre avec la branche pré-remplie et « Ticket TECH-… » visible ; changer de preset → la branche reste. Envoyer un message court. Vérifier en base : `sqlite3 ~/.local/share/pupitre/pupitre.db "select ticket_id, worktree_path from conversations order by created_at desc limit 2"` → même `worktree_path` que la conversation sœur, `ticket_id` renseigné ; premier `user-message` = le message tapé (pas le brief).
5. Sidebar : le groupe `TECH-… · 2` apparaît en tête.
6. Couper le réseau ClickUp (token invalide dans Paramètres) → Rafraîchir → bandeau « ClickUp : à reconfigurer — ClickUp 401 », les lignes restent.
7. Capture d'écran du tableau complet jointe à la réponse finale, avec les comptes relevés (tickets, refs, environnements).

**Commit final** (s'il reste des retouches issues de la vérification) : `fix(tableau-de-bord): retouches après vérification navigateur`.

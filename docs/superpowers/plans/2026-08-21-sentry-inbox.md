# Sentry Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter à chaque projet Pupitre une inbox Sentry read-only qui classe les issues liées à l’utilisateur, lance un scout structuré et, après confirmation, crée le ticket ClickUp puis la conversation de correction sur `issue/TECH-XXXXX`.

**Architecture:** Le sidecar conserve secrets, issues et triages dans SQLite, interroge Sentry avec un client GET-only et enrichit le `IntegrationsRefresher` existant. Un classifieur déterministe compile les signaux des domaines projet, du skill `matching-system` et des tickets ClickUp ouverts ; l’UI affiche une inbox dédiée et les actions passent par un service de workflow qui réutilise conversations, skills, ClickUp et Git worktrees.

**Tech Stack:** Bun, TypeScript, SQLite, React 19, Vite, Testing Library, API Sentry v0, API ClickUp v2.

**Spec:** `docs/plans/2026-08-21-sentry-inbox-design.md`

## Global Constraints

- Toute l’implémentation vit dans `/home/clement/Desktop/pupitre`; affilae-mono n’est qu’un projet configuré et une source de contexte.
- Configuration, token, snapshots, catalogue de domaines et triages sont isolés par projet Pupitre.
- Sentry est GET-only et limité à l’environnement `production`.
- Les scans tournent toutes les 15 minutes quand Pupitre est actif, toutes les 60 minutes en arrière-plan, et à la demande.
- Aucun appel LLM ne participe au scan ou au classement périodique.
- Une confirmation est obligatoire avant création ClickUp et avant création de MR.
- Emails, IP, tokens et cookies sont expurgés avant stockage ou injection dans une conversation.
- Brand Search n’est pas un domaine permanent.
- Exécuter les tests sidecar et UI séparément; ne jamais redémarrer le sidecar depuis une conversation Pupitre.

---

## File Map

| Fichier | Responsabilité |
| --- | --- |
| `sidecar/src/stores/integration-secrets.ts` | Secrets par intégration, jamais sérialisés dans les payloads publics |
| `sidecar/src/stores/sentry.ts` | Persistance et cycle de vie des issues/triages |
| `sidecar/src/integrations/sentry.ts` | Client Sentry GET-only et parsing des réponses |
| `sidecar/src/sentry-redaction.ts` | Nettoyage récursif des données sensibles |
| `sidecar/src/sentry-domains.ts` | Compilation des skills/tickets et classement explicable |
| `sidecar/src/sentry-workflow.ts` | Scout, verdict structuré et création de correction |
| `ui/src/SentryInbox.tsx` | Liste, filtres, états et panneau de détail |
| `ui/src/styles/sentry.css` | Mise en page de l’inbox et du panneau |

### Task 1: Persistance isolée des secrets, issues et triages

**Files:**
- Modify: `sidecar/src/db.ts`
- Create: `sidecar/src/stores/integration-secrets.ts`
- Create: `sidecar/src/stores/sentry.ts`
- Create: `sidecar/tests/db-sentry.test.ts`
- Create: `sidecar/tests/sentry-store.test.ts`

**Interfaces:**
- Produces: `IntegrationSecretStore.get(integrationId, name): string | null`, `set(...)`, `removeIntegration(...)`.
- Produces: `SentryStore.upsertIssue(input): SentryIssue`, `listProject(projectId, filter)`, `markMissing(...)`, `upsertTriage(...)`, `triageForIssue(issueId)`.

- [ ] **Step 1: Write the schema test**

Assert that `openDb()` creates `integration_secrets`, `sentry_issues`, and `sentry_triages`, that `(integration_id, sentry_issue_id)` is unique, and that deleting a project cascades through its integration to all three tables.

- [ ] **Step 2: Run the schema test and verify failure**

Run: `cd sidecar && bun test tests/db-sentry.test.ts`

Expected: FAIL because the tables do not exist.

- [ ] **Step 3: Add the schema**

Use these keys and constraints in `openDb()`:

```sql
CREATE TABLE IF NOT EXISTS integration_secrets (
  integration_id TEXT NOT NULL REFERENCES project_integrations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (integration_id, name)
);
CREATE TABLE IF NOT EXISTS sentry_issues (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES project_integrations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sentry_issue_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  relevance_json TEXT NOT NULL DEFAULT '{"matched":false,"reasons":[]}',
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('new','active','quiet','resolved_remote')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_scanned_at TEXT NOT NULL,
  UNIQUE (integration_id, sentry_issue_id)
);
CREATE INDEX IF NOT EXISTS idx_sentry_issues_project
  ON sentry_issues(project_id, lifecycle, last_seen_at DESC);
CREATE TABLE IF NOT EXISTS sentry_triages (
  issue_id TEXT PRIMARY KEY REFERENCES sentry_issues(id) ON DELETE CASCADE,
  conversation_id TEXT NULL REFERENCES conversations(id) ON DELETE SET NULL,
  correction_conversation_id TEXT NULL REFERENCES conversations(id) ON DELETE SET NULL,
  ticket_id TEXT NULL REFERENCES tickets(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('idle','running','done','error')),
  verdict TEXT NULL CHECK (verdict IN ('real_fixable','real_investigate','noise','uncertain')),
  report_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 4: Write store tests**

Cover project isolation for the same Sentry issue id, upsert preserving an existing triage, `noise` surviving a new occurrence, transition to `quiet`/`resolved_remote`, and secret reads never appearing in issue/integration serialization. Add `sweep(now)` tests: keep every row for 30 days, retain rows carrying a triage after that boundary, and delete only untriaged `quiet`/`resolved_remote` rows older than 30 days.

- [ ] **Step 5: Implement the two stores and run tests**

Run: `cd sidecar && bun test tests/db-sentry.test.ts tests/sentry-store.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sidecar/src/db.ts sidecar/src/stores/integration-secrets.ts sidecar/src/stores/sentry.ts sidecar/tests/db-sentry.test.ts sidecar/tests/sentry-store.test.ts
git commit -m "feat(sentry): stocker les issues et secrets par projet"
```

### Task 2: Client Sentry read-only et expurgation

**Files:**
- Create: `sidecar/src/integrations/sentry.ts`
- Create: `sidecar/src/sentry-redaction.ts`
- Create: `sidecar/tests/sentry-client.test.ts`
- Create: `sidecar/tests/sentry-redaction.test.ts`

**Interfaces:**
- Produces: `SentryClient.listIssues({org, project, environment, statsPeriod, query}): Promise<SentryIssueSummary[]>`.
- Produces: `issueDetail(org, issueId)`, `issueEvents(org, issueId, input)`, `eventDetail(org, project, eventId)`.
- Produces: `redactSentryValue(value: unknown): unknown`.

- [ ] **Step 1: Write client contract tests with a fake fetch**

Verify calls to:

```text
GET /api/0/projects/{org}/{project}/issues/?environment=production&statsPeriod=24h&query=is%3Aunresolved
GET /api/0/organizations/{org}/issues/{issueId}/
GET /api/0/organizations/{org}/issues/{issueId}/events/?environment=production&statsPeriod=24h
GET /api/0/projects/{org}/{project}/events/{eventId}/
```

Cover `Link` pagination, maximum 50 results per page, one retry for `429/502/503/504`, `Retry-After`, and `SentryAuthError` for `401/403`.

- [ ] **Step 2: Run the tests and verify failure**

Run: `cd sidecar && bun test tests/sentry-client.test.ts tests/sentry-redaction.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement GET-only parsing**

Normalize summaries to this stable shape:

```ts
export interface SentryIssueSummary {
  id: string; shortId: string; project: string; title: string;
  culprit: string | null; transaction: string | null; level: string;
  status: string; count: number; userCount: number;
  firstSeen: string; lastSeen: string; permalink: string;
  release: string | null; tags: Record<string, string[]>;
}
```

- [ ] **Step 4: Implement recursive redaction**

Remove keys matching `/authorization|cookie|token|password|secret/i`, replace emails with `[email]`, IPv4/IPv6 values with `[ip]`, and cap strings at 4,000 characters and arrays at 50 entries.

- [ ] **Step 5: Run tests and commit**

Run: `cd sidecar && bun test tests/sentry-client.test.ts tests/sentry-redaction.test.ts`

```bash
git add sidecar/src/integrations/sentry.ts sidecar/src/sentry-redaction.ts sidecar/tests/sentry-client.test.ts sidecar/tests/sentry-redaction.test.ts
git commit -m "feat(sentry): ajouter le client read-only"
```

### Task 3: Classifieur déterministe piloté par skills et tickets

**Files:**
- Create: `sidecar/src/sentry-domains.ts`
- Create: `sidecar/tests/sentry-domains.test.ts`
- Modify: `sidecar/src/stores/tickets.ts`

**Interfaces:**
- Produces: `compileDomainCatalog(project, integrations, skills, tickets): DomainCatalog`.
- Produces: `classifySentryIssue(issue, frames, catalog): {matched: boolean; reasons: RelevanceReason[]}`.
- Consumes: `SkillInventory`, `TicketStore.listActive(projectId)`.

- [ ] **Step 1: Write fixture-driven classification tests**

Cover `/matching/search`, `/publisher/profile-analysis`, `affiliateProfiles/create.js`, vectorisation, Atlas, quality gate, wishlists, Instagram, an open ClickUp ticket, a closed-ticket-only signal, ordinary Brand Search, and the Reactivator recommendation handoff containing both matching and Brand Search signals.

- [ ] **Step 2: Run the test and verify failure**

Run: `cd sidecar && bun test tests/sentry-domains.test.ts`

Expected: FAIL because `sentry-domains.ts` does not exist.

- [ ] **Step 3: Implement catalog compilation**

Read enabled domain configuration from the Sentry integration. Resolve configured skill names through `SkillInventory`, then extract only explicit backticked endpoints and paths plus configured aliases. For affilae-mono seed:

```ts
const DEFAULT_AFFILAE_DOMAINS = {
  matching: { skill: "matching-system", aliases: ["matching", "matchmaking", "vectoriz", "atlas", "affiliate profile", "quality gate"] },
  wishlists: { aliases: ["wishlist", "wishlists", "gift_lists"] },
  instagram: { aliases: ["instagram", "connected_instagram", "third_party_integrations"] },
};
```

Require either one exact endpoint/path match or two independent alias matches. Brand Search alone must score zero.

- [ ] **Step 4: Add active-ticket signals**

Expose `TicketStore.listActive(projectId)` and `TicketStore.setDomainContext(ticketId, {sourceUpdatedAt, text})`. Compile ticket title, key, labels, branch refs, and the stored context capped at 2,000 characters. Closed/archived tickets do not enter the current catalog.

- [ ] **Step 5: Run tests and commit**

Run: `cd sidecar && bun test tests/sentry-domains.test.ts tests/tickets-store.test.ts`

```bash
git add sidecar/src/sentry-domains.ts sidecar/src/stores/tickets.ts sidecar/tests/sentry-domains.test.ts sidecar/tests/tickets-store.test.ts
git commit -m "feat(sentry): classer les issues par domaines"
```

### Task 4: Relève Sentry et cadence active/idle

**Files:**
- Modify: `sidecar/src/integrations/refresher.ts`
- Modify: `sidecar/src/index.ts`
- Modify: `sidecar/src/server.ts`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/api.ts`
- Modify: `sidecar/tests/integrations-refresher.test.ts`
- Create: `sidecar/tests/sentry-refresher.test.ts`

**Interfaces:**
- Adds to `RefresherDeps`: `sentryClient(integration): SentryHandle | null`, `compileSentryCatalog(projectId, integration): DomainCatalog`.
- Consumes: `IntegrationSecretStore`, `SentryStore`, `SentryClient`.

- [ ] **Step 1: Write refresh tests**

Verify three configured Sentry projects are fetched independently with `production`, one failure does not discard successful results, auth failure marks `à reconfigurer`, concurrent manual scans coalesce, and missing issues become `quiet` without losing triage. For a previously active issue absent from the unresolved result, fetch its detail once: status `resolved` becomes `resolved_remote`; any other status becomes `quiet`.

Also verify ClickUp calls `taskContext` only for an active task whose `updatedAt` differs from its stored domain context, then persists the bounded description through `TicketStore.setDomainContext` for the classifier.

- [ ] **Step 2: Run the tests and verify failure**

Run: `cd sidecar && bun test tests/sentry-refresher.test.ts tests/integrations-refresher.test.ts`

- [ ] **Step 3: Wire Sentry into `refreshOne`**

Parse this config shape and call `SentryStore.upsertIssue()` inside one SQLite transaction per Sentry project:

```ts
export interface SentryConfig {
  baseUrl: string;
  org: string;
  projects: string[];
  environment: "production";
  domains: Array<{name: string; skill?: string; aliases: string[]}>;
}
```

Call `SentryStore.sweep(new Date())` after a successful project refresh so untriaged quiet/resolved rows respect the 30-day retention rule.

- [ ] **Step 4: Implement cadence switching**

Add `SENTRY_ACTIVE_POLL_MS = 15 * 60_000` and `SENTRY_IDLE_POLL_MS = 60 * 60_000`. Add `POST /api/activity/visibility {active:boolean}` and have `App.tsx` report `document.visibilityState === 'visible' && document.hasFocus()` on focus, blur and visibility changes. Keep one global refresher tick; record a per-integration `nextDueAt` in memory so ClickUp/GitLab retain 5/30 minutes while Sentry uses 15/60 minutes.

- [ ] **Step 5: Run tests and commit**

Run: `cd sidecar && bun test tests/sentry-refresher.test.ts tests/integrations-refresher.test.ts tests/integrations-store.test.ts`

```bash
git add sidecar/src/integrations/refresher.ts sidecar/src/index.ts sidecar/src/server.ts sidecar/tests/sentry-refresher.test.ts sidecar/tests/integrations-refresher.test.ts ui/src/App.tsx ui/src/api.ts
git commit -m "feat(sentry): relever les issues par projet"
```

### Task 5: Configuration par projet et API inbox

**Files:**
- Modify: `sidecar/src/server.ts`
- Modify: `sidecar/src/dashboard.ts`
- Modify: `sidecar/tests/dashboard-routes.test.ts`
- Create: `sidecar/tests/sentry-routes.test.ts`
- Modify: `ui/src/ProjectSettingsDialog.tsx`
- Modify: `ui/src/ProjectSettingsDialog.test.tsx`
- Modify: `ui/src/api.ts`
- Modify: `ui/src/types.ts`

**Interfaces:**
- Produces routes: `GET /api/projects/:projectId/sentry`, `POST /api/projects/:projectId/sentry/refresh`, `GET /api/sentry/issues/:id`.
- Extends `PUT /api/projects/:projectId/integrations/sentry` with top-level `token?: string | null`, stripped before `IntegrationStore.upsert`.

- [ ] **Step 1: Write route tests**

Assert token write/update/delete is scoped to the integration id, every GET returns only `tokenConfigured: boolean`, project A cannot read issue B, refresh returns `202`, detail is redacted, and invalid org/project/domain config returns `400`.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd sidecar && bun test tests/sentry-routes.test.ts tests/dashboard-routes.test.ts`

- [ ] **Step 3: Implement API types and routes**

Expose `SentryInboxPayload`, `SentryIssueRow`, `SentryIssueDetail`, `SentryTriage`, and `RelevanceReason` identically in sidecar and `ui/src/types.ts`. Never add secret fields to these types.

- [ ] **Step 4: Add the Sentry form to project settings**

Fields: enabled, base URL defaulting to `https://sentry.io`, organisation slug, comma-separated projects, environment fixed/read-only to `production`, token password input, and domain rows `{name, skill, aliases}`. Affilae-mono can be seeded in the UI with projects `hapigator, reactor, reactivator` and the four validated domains, but saving remains explicit.

- [ ] **Step 5: Run sidecar/UI tests and commit**

Run: `cd sidecar && bun test tests/sentry-routes.test.ts tests/dashboard-routes.test.ts`

Run: `cd ui && bun test ProjectSettingsDialog.test.tsx && bunx tsc --noEmit`

```bash
git add sidecar/src/server.ts sidecar/src/dashboard.ts sidecar/tests/sentry-routes.test.ts sidecar/tests/dashboard-routes.test.ts ui/src/ProjectSettingsDialog.tsx ui/src/ProjectSettingsDialog.test.tsx ui/src/api.ts ui/src/types.ts
git commit -m "feat(sentry): configurer une inbox par projet"
```

### Task 6: Onglet inbox et panneau de détail

**Files:**
- Create: `ui/src/SentryInbox.tsx`
- Create: `ui/src/SentryInbox.test.tsx`
- Create: `ui/src/styles/sentry.css`
- Modify: `ui/src/DashboardView.tsx`
- Modify: `ui/src/DashboardView.test.tsx`
- Modify: `ui/src/styles/dashboard.css`
- Modify: `ui/src/api.ts`

**Interfaces:**
- Consumes: `getSentryInbox`, `getSentryIssue`, `refreshSentryInbox`, `startSentryScout`.
- Produces callback: `onConversationSelect(conversationId)` when a scout already exists or is created.

- [ ] **Step 1: Write UI tests**

Test tabs `Toutes`, `Mes domaines`, `Bruit`; project badges; lifecycle states; relevance reasons; stale/degraded banner; manual refresh disabled while pending; detail fetch on row click; no scout call on row click; scout call only on button.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd ui && bun test SentryInbox.test.tsx DashboardView.test.tsx`

- [ ] **Step 3: Implement accessible inbox**

Use real buttons/tabs (`role="tablist"`), a stable list plus adjacent detail panel, existing dashboard typography/buttons/colors, and responsive stacking below 900px. Do not introduce a global incident rail.

- [ ] **Step 4: Run UI tests and typecheck**

Run: `cd ui && bun test SentryInbox.test.tsx DashboardView.test.tsx && bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add ui/src/SentryInbox.tsx ui/src/SentryInbox.test.tsx ui/src/styles/sentry.css ui/src/DashboardView.tsx ui/src/DashboardView.test.tsx ui/src/styles/dashboard.css ui/src/api.ts
git commit -m "feat(sentry): afficher l'inbox du projet"
```

### Task 7: Scout structuré et verdict persistant

**Files:**
- Create: `sidecar/src/sentry-workflow.ts`
- Create: `sidecar/tests/sentry-workflow.test.ts`
- Modify: `sidecar/src/pupitre-mcp.ts`
- Modify: `sidecar/tests/pupitre-mcp.test.ts`
- Modify: `sidecar/src/server.ts`
- Modify: `sidecar/src/stores/conversations.ts`

**Interfaces:**
- Produces: `SentryWorkflow.startScout(issueId): Promise<Conversation>`.
- Produces: `SentryWorkflow.report(conversationId, input: TriageReport): SentryTriage`.
- Adds MCP tool `report_sentry_triage` with verdict enum and required `summary`, `evidence[]`, `impact`, `probable_cause`, `fix_strategy` fields.

- [ ] **Step 1: Write workflow and MCP tests**

Verify one active scout per issue, completed scout reuse, project default preset, redacted bounded preamble, `$matching-system` injection only when classification contains that skill, report rejection from an unrelated conversation, and persistence of all four verdicts.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd sidecar && bun test tests/sentry-workflow.test.ts tests/pupitre-mcp.test.ts`

- [ ] **Step 3: Implement scout creation**

Extract the minimal reusable conversation-launch operation currently embedded in `POST /api/conversations`; keep the existing route behavior unchanged. The scout uses the project’s default preset, project root cwd, no branch, and this intent:

```text
Analyse cette issue Sentry en lecture seule. Vérifie dans le code si elle est réelle,
attendue ou insuffisamment documentée. Ne crée ni ticket ni branche. Termine en appelant
report_sentry_triage avec un verdict et des preuves concrètes.
```

- [ ] **Step 4: Implement the MCP report tool and routes**

Add `POST /api/sentry/issues/:id/scout` and authenticated-local `POST /api/sentry/triages/report`; validate that `PUPITRE_CONVERSATION_ID` owns the triage before accepting the report.

- [ ] **Step 5: Run tests and commit**

Run: `cd sidecar && bun test tests/sentry-workflow.test.ts tests/pupitre-mcp.test.ts tests/conversations.test.ts`

```bash
git add sidecar/src/sentry-workflow.ts sidecar/src/stores/conversations.ts sidecar/src/pupitre-mcp.ts sidecar/src/server.ts sidecar/tests/sentry-workflow.test.ts sidecar/tests/pupitre-mcp.test.ts
git commit -m "feat(sentry): lancer et enregistrer les scouts"
```

### Task 8: Confirmation ClickUp et conversation de correction

**Files:**
- Modify: `sidecar/src/integrations/clickup.ts`
- Modify: `sidecar/tests/clickup.test.ts`
- Modify: `sidecar/src/sentry-workflow.ts`
- Modify: `sidecar/tests/sentry-workflow.test.ts`
- Modify: `sidecar/src/server.ts`
- Modify: `sidecar/src/stores/tickets.ts`
- Modify: `ui/src/SentryInbox.tsx`
- Modify: `ui/src/SentryInbox.test.tsx`
- Modify: `ui/src/api.ts`
- Modify: `ui/src/ProjectSettingsDialog.tsx`
- Modify: `ui/src/ProjectSettingsDialog.test.tsx`

**Interfaces:**
- Adds: `ClickUpClient.createTask({listId, name, description}): Promise<ClickUpTask>`.
- Adds: `SentryWorkflow.confirmFix(issueId): Promise<{ticket: Ticket; conversation: Conversation}>`.
- Adds route: `POST /api/sentry/issues/:id/create-fix` requiring body `{confirmed: true}`.

- [ ] **Step 1: Write ClickUp creation tests**

Assert `POST /list/{listId}/task`, authorization header, bounded Markdown description, parsing of `custom_id`, and explicit error when no `creationListId` exists in the project ClickUp config.

- [ ] **Step 2: Write workflow confirmation tests**

Reject non-`real_fixable`, missing/false confirmation, duplicate concurrent creation, absent ClickUp integration, and issue from another project. Success must create the ClickUp task once, upsert the local ticket, attach a `sentry_issue` ref, create/reuse `issue/TECH-XXXXX`, and start the correction conversation with the scout brief.

- [ ] **Step 3: Implement ClickUp creation and workflow transaction boundaries**

Perform the external ClickUp call before the local transaction. Persist the returned ClickUp id/key immediately, then make worktree/conversation creation retryable from that ticket so a local failure never creates a second ClickUp task.

- [ ] **Step 4: Add UI confirmation**

Add `creationListId` to the existing ClickUp project form (default to the first configured list id but persist the explicit choice). Show `Créer et corriger` only for `real_fixable`. Use `window.confirm` with ticket title and destination list; navigate to the returned correction conversation. Do not expose any MR creation action in this workflow—the existing agent/MR flow retains its confirmation gate.

- [ ] **Step 5: Run tests and commit**

Run: `cd sidecar && bun test tests/clickup.test.ts tests/sentry-workflow.test.ts tests/tickets-store.test.ts`

Run: `cd ui && bun test SentryInbox.test.tsx ProjectSettingsDialog.test.tsx && bunx tsc --noEmit`

```bash
git add sidecar/src/integrations/clickup.ts sidecar/src/sentry-workflow.ts sidecar/src/server.ts sidecar/src/stores/tickets.ts sidecar/tests/clickup.test.ts sidecar/tests/sentry-workflow.test.ts ui/src/SentryInbox.tsx ui/src/SentryInbox.test.tsx ui/src/api.ts ui/src/ProjectSettingsDialog.tsx ui/src/ProjectSettingsDialog.test.tsx
git commit -m "feat(sentry): créer la correction après confirmation"
```

### Task 9: Documentation, régression et vérification dans l’application

**Files:**
- Modify: `README.md`
- Modify: `docs/help/tableau-de-bord.md`
- Create: `docs/help/sentry.md`
- Modify: help index registration in `sidecar/src/server.ts`

**Interfaces:**
- Documents token par projet, scopes read-only, cadence, filtres, scout, confirmations et dépannage.

- [ ] **Step 1: Write documentation**

Document exact setup: project settings → Sentry, base URL, org slug, project slugs, production-only, token read scopes, domains, ClickUp `creationListId`, scan manual, verdicts, and guarantees read-only.

- [ ] **Step 2: Run all automated verification**

Run: `cd sidecar && bun test`

Run: `cd ui && bun test`

Run: `cd ui && bunx tsc --noEmit`

Expected: all commands PASS.

- [ ] **Step 3: Verify the running UI without restarting the sidecar**

Open `http://localhost:5173`, configure a fixture/test Sentry integration, and inspect the DOM for: three project badges, exact tab counts, one stable detail panel, no duplicate rows after two manual scans, masked token, and disabled refresh while pending. Capture the result for the handoff.

- [ ] **Step 4: Verify the acceptance scenario**

Use a fixture equivalent to `POST /matching/search`; confirm it appears in `Toutes` and `Mes domaines`, cites `matching-system`, opens detail without a scout, launches one scout, stores its verdict, and requires confirmation before ClickUp. Do not create a real ClickUp ticket during fixture verification.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/help/tableau-de-bord.md docs/help/sentry.md sidecar/src/server.ts
git commit -m "docs(sentry): documenter l'inbox et le scout"
```

- [ ] **Step 6: Final repository review**

Run: `git status --short && git log --oneline -10`

Expected: clean worktree and one focused commit per task.

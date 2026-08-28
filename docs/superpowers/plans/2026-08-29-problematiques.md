# Problématiques Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter le cycle complet de capture, structuration, résurgence et clôture automatique des problématiques dans Pupitre.

**Architecture:** Un `ProblemStore` SQLite possède les captures et les problématiques. Un `ProblemService` séquentiel persiste d'abord le collage, exécute un tour Luna invisible, valide atomiquement sa sortie et diffuse le snapshot projet. Les conversations utilisent l'origine `problem`; un détecteur commun ferme les IDs exacts observés après un tour ou dans le changelog.

**Tech Stack:** Bun, TypeScript, bun:sqlite, serveur HTTP/WebSocket Bun, React 19, happy-dom, Testing Library, Vite.

**Spec:** `docs/superpowers/specs/2026-08-29-problematiques-design.md`

## Global Constraints

- Un collage est persisté avant tout appel fournisseur et mesure au plus 50 000 caractères.
- Une capture utilise une seule invocation `codex` / `gpt-5.6-luna` / effort `medium` / vitesse `fast`.
- Une capture crée au plus 20 problématiques ; chaque problématique contient une à cinq propositions.
- Les IDs publics suivent exactement `PB-[0-9A-HJKMNP-TV-Z]{6}` et sont globalement uniques.
- Les seuls états métier persistés sont `open` et `closed`.
- ClickUp reste en lecture seule ; une clé absente du catalogue local devient `null`.
- Le sidecar ne doit pas être redémarré depuis cette conversation Pupitre.
- Chaque changement de comportement suit RED → GREEN et les deux suites complètes sont lancées avant livraison.

---

### Task 1: Persistance des captures et problématiques

**Files:**
- Modify: `sidecar/src/db.ts`
- Create: `sidecar/src/stores/problems.ts`
- Create: `sidecar/tests/problems-store.test.ts`

**Interfaces:**
- Produces: `ProblemStore`, `ProblemCapture`, `Problem`, `ProblemPlan`, `ProblemDraft`.
- Produces: `createCapture`, `queuedCaptures`, `markProcessing`, `completeCapture`, `markError`, `listProject`, `setTicket`, `close`, `reopen`, `delete`.

- [ ] **Step 1: Write the failing store tests**

```ts
test("persiste le collage avant ses résultats puis écrit le lot atomiquement", () => {
  const capture = store.createCapture(project.id, "Bug A et retour B")
  expect(store.queuedCaptures().map(({ id }) => id)).toEqual([capture.id])
  store.completeCapture(capture.id, [{
    publicId: "PB-7K3M9Q", title: "Bug A", context: "Contexte",
    resolution: "Corriger", ticketId: null,
    plans: [{ title: "Corriger le bug", instruction: "Diagnostiquer puis corriger." }],
  }])
  expect(store.listProject(project.id, "open").problems[0]?.public_id).toBe("PB-7K3M9Q")
  expect(store.getCapture(capture.id)?.status).toBe("done")
})

test("ferme, rouvre, change le ticket du même projet et supprime", () => {
  expect(store.setTicket(problem.id, ticket.id)?.ticket_id).toBe(ticket.id)
  expect(store.close(problem.id, "abc")?.status).toBe("closed")
  expect(store.reopen(problem.id)?.closed_commit_sha).toBeNull()
  expect(store.delete(problem.id)).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify RED**

Run: `cd sidecar && bun test tests/problems-store.test.ts`
Expected: FAIL because `stores/problems.ts` does not exist.

- [ ] **Step 3: Add schema and minimal store**

```sql
CREATE TABLE IF NOT EXISTS problem_captures (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  raw_text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','processing','done','error')),
  error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS problems (
  id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE,
  capture_id TEXT NOT NULL REFERENCES problem_captures(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  title TEXT NOT NULL, context TEXT NOT NULL, resolution TEXT NOT NULL,
  plans_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','closed')),
  closed_at TEXT, closed_commit_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

`completeCapture` wraps all inserts and the capture transition in one SQLite transaction. `setTicket` refuses a ticket from another project. `close` is idempotent; `reopen` clears both closure fields.

- [ ] **Step 4: Run store tests to verify GREEN**

Run: `cd sidecar && bun test tests/problems-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/db.ts sidecar/src/stores/problems.ts sidecar/tests/problems-store.test.ts
git commit -m "feat(problems): persist captures and problem lifecycle"
```

### Task 2: Traitement Luna asynchrone

**Files:**
- Create: `sidecar/src/problems.ts`
- Create: `sidecar/tests/problems.test.ts`
- Modify: `sidecar/src/index.ts`

**Interfaces:**
- Consumes: `ProblemStore`, `ProjectStore`, `TicketStore`, `DebriefGenerator`.
- Produces: `ProblemService.capture(projectId, rawText)`, `processCapture(captureId)`, `retry(captureId)`, `resume()`, `parseProblemDrafts(raw, tickets)`, `problemPublicId()`.

- [ ] **Step 1: Write failing parser and service tests**

```ts
test("sauvegarde puis traite une capture avec Luna medium fast", async () => {
  const calls: DebriefGenerationInput[] = []
  const service = setup(async (input) => { calls.push(input); return validJson })
  const capture = service.capture(project.id, "deux sujets")
  expect(store.getCapture(capture.id)?.status).toBe("queued")
  await service.processCapture(capture.id)
  expect(calls[0]).toEqual(expect.objectContaining({
    provider: "codex", model: "gpt-5.6-luna", effort: "medium", speed: "fast",
  }))
  expect(store.listProject(project.id, "open").problems).toHaveLength(2)
})

test("une sortie invalide garde le texte et ne crée aucun résultat partiel", async () => {
  const service = setup(async () => '[{"title":"incomplet"}]')
  const capture = service.capture(project.id, "texte conservé")
  await service.processCapture(capture.id)
  expect(store.getCapture(capture.id)).toMatchObject({ status: "error", raw_text: "texte conservé" })
  expect(store.listProject(project.id, "all").problems).toEqual([])
})
```

- [ ] **Step 2: Run tests to verify RED**

Run: `cd sidecar && bun test tests/problems.test.ts`
Expected: FAIL because `ProblemService` is missing.

- [ ] **Step 3: Implement validator, queue and recovery**

```ts
export class ProblemService {
  capture(projectId: string, rawText: string): ProblemCapture
  processCapture(captureId: string): Promise<void>
  retry(captureId: string): ProblemCapture
  resume(): void
}
export function parseProblemDrafts(raw: string, tickets: TicketRow[]): ProblemDraft[]
export function problemPublicId(random?: () => number): string
```

The queue is a single promise chain. `capture` validates the project and the 1..50,000 character range, calls `store.createCapture`, schedules work and returns without awaiting the provider. The parser extracts one JSON array, enforces 1..20 rows, title/context/resolution limits, 1..5 plans and resolves ticket keys through a `Map`.

- [ ] **Step 4: Run service tests to verify GREEN**

Run: `cd sidecar && bun test tests/problems.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/problems.ts sidecar/src/index.ts sidecar/tests/problems.test.ts
git commit -m "feat(problems): structure captures asynchronously with Luna"
```

### Task 3: API, dashboard et origine de conversation

**Files:**
- Modify: `sidecar/src/server.ts`
- Modify: `sidecar/src/dashboard.ts`
- Modify: `sidecar/src/stores/conversations.ts`
- Modify: `sidecar/src/index.ts`
- Create: `sidecar/tests/problems-routes.test.ts`
- Modify: `sidecar/tests/conversations.test.ts`

**Interfaces:**
- Consumes: `ProblemService`, `ProblemStore`.
- Produces: routes exactes de la spécification, `DashboardPayload.problems`, origine conversation `problem`, `problemPlanIndex`.

- [ ] **Step 1: Write failing route tests**

```ts
test("capture, liste et relance par HTTP", async () => {
  const created = await post(`/api/projects/${project.id}/problem-captures`, { text: "vrac" })
  expect(created.status).toBe(202)
  expect((await get(`/api/projects/${project.id}/problems?status=all`)).captures).toHaveLength(1)
})

test("une conversation problem prend le contexte et le ticket depuis le serveur", async () => {
  const response = await post("/api/conversations", {
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna",
    effort: "medium", speed: "fast", orchestrator: true,
    originType: "problem",
    originKey: "PB-7K3M9Q", problemPlanIndex: 0, message: "Commencer",
  })
  expect(response.status).toBe(201)
  expect((await response.json()).origin_type).toBe("problem")
  expect(readProviderPrompt()).toContain("[PB-7K3M9Q]")
})
```

- [ ] **Step 2: Run tests to verify RED**

Run: `cd sidecar && bun test tests/problems-routes.test.ts tests/conversations.test.ts`
Expected: FAIL with 404 and invalid origin.

- [ ] **Step 3: Implement routes and server-owned preamble**

Extend `ServerDeps` with `problems` and `problemStore`. Build dashboard snapshots with `problems: store.listProject(projectId, "all")`. Accept `originType` in `"sentry" | "problem"`; for `problem`, resolve `originKey` and `problemPlanIndex`, force its ticket, and prepend the structured context and exact commit marker instruction.

- [ ] **Step 4: Run route tests to verify GREEN**

Run: `cd sidecar && bun test tests/problems-routes.test.ts tests/conversations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/server.ts sidecar/src/dashboard.ts sidecar/src/stores/conversations.ts sidecar/src/index.ts sidecar/tests/problems-routes.test.ts sidecar/tests/conversations.test.ts
git commit -m "feat(problems): expose lifecycle and conversation context"
```

### Task 4: Fermeture automatique depuis Git

**Files:**
- Modify: `sidecar/src/git.ts`
- Modify: `sidecar/src/runner.ts`
- Modify: `sidecar/src/changelog.ts`
- Modify: `sidecar/src/stores/changelog.ts`
- Modify: `sidecar/src/index.ts`
- Modify: `sidecar/tests/git.test.ts`
- Modify: `sidecar/tests/changelog.test.ts`
- Modify: `sidecar/tests/runner.test.ts`
- Create: `sidecar/tests/problem-commits.test.ts`

**Interfaces:**
- Produces: `problemIdsInCommit(message)`, `ProblemStore.closeFromCommit(projectId, message, sha)`.
- Changes: `GitProjectService.finishTurn` returns new SHAs; `GitChangelogCommit.message` carries the full message.

- [ ] **Step 1: Write failing exact-match and integration tests**

```ts
test("ferme chaque ID exact du même projet une seule fois", () => {
  expect(problemIdsInCommit("fix [PB-7K3M9Q] et [PB-ABC123]")).toEqual(["PB-7K3M9Q", "PB-ABC123"])
  expect(problemIdsInCommit("PB-7K3M9Q ou [PB-OOOOOO]")).toEqual([])
  expect(store.closeFromCommit(project.id, "fix [PB-7K3M9Q]", "abc")).toBe(1)
  expect(store.closeFromCommit(project.id, "fix [PB-7K3M9Q]", "abc")).toBe(0)
})

test("readGitHistory conserve aussi le corps du commit", async () => {
  expect(history[0]?.message).toContain("[PB-7K3M9Q]")
})
```

- [ ] **Step 2: Run tests to verify RED**

Run: `cd sidecar && bun test tests/problem-commits.test.ts tests/changelog.test.ts tests/runner.test.ts`
Expected: FAIL because messages and detector are missing.

- [ ] **Step 3: Implement one idempotent detector and both hooks**

Use the literal regex `/\[\b(PB-[0-9A-HJKMNP-TV-Z]{6})\b\]/g` without fuzzy matching. `finishTurn` returns the recorded SHA list and the runner gives each full message to `closeFromCommit`. `ChangelogService.refresh` invokes the same callback for imported commits after persistence.

- [ ] **Step 4: Run Git tests to verify GREEN**

Run: `cd sidecar && bun test tests/problem-commits.test.ts tests/git.test.ts tests/changelog.test.ts tests/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/git.ts sidecar/src/runner.ts sidecar/src/changelog.ts sidecar/src/stores/changelog.ts sidecar/src/index.ts sidecar/tests/problem-commits.test.ts sidecar/tests/git.test.ts sidecar/tests/changelog.test.ts sidecar/tests/runner.test.ts
git commit -m "feat(problems): close problem IDs observed in commits"
```

### Task 5: Capture et catalogue dans le tableau de bord

**Files:**
- Modify: `ui/src/types.ts`
- Modify: `ui/src/api.ts`
- Create: `ui/src/ProblemsPanel.tsx`
- Create: `ui/src/ProblemsPanel.test.tsx`
- Modify: `ui/src/DashboardView.tsx`
- Modify: `ui/src/DashboardView.test.tsx`
- Modify: `ui/src/styles/dashboard.css`

**Interfaces:**
- Produces: UI types matching sidecar, API functions, `ProblemsPanel`.
- Changes: dashboard tab union gains `problems`; header gains `Capturer`.

- [ ] **Step 1: Write failing component and dashboard tests**

```tsx
test("capture en deux gestes puis montre le traitement", async () => {
  render(<DashboardView project={project} onStartConversation={() => {}} />)
  fireEvent.click(await screen.findByRole("button", { name: "Capturer" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Texte à structurer" }), { target: { value: "vrac" } })
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true })
  expect(await screen.findByText("Traitement en cours")).toBeTruthy()
})

test("ferme, rouvre, supprime et corrige le ticket depuis une carte", async () => {
  render(<ProblemsPanel projectId="p1" payload={fixture} tickets={tickets} onChange={setPayload} onStartConversation={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "Fermer PB-7K3M9Q" }))
  expect(closeRequest).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run UI tests to verify RED**

Run: `cd ui && bun test src/ProblemsPanel.test.tsx src/DashboardView.test.tsx`
Expected: FAIL because the component and fifth tab are missing.

- [ ] **Step 3: Implement accessible modal, tab and actions**

Keep interaction-driven requests in event handlers, not effects. Derive filtered problems during render. The modal uses a controlled textarea, `maxLength={50_000}`, `aria-modal`, visible shortcut hint and disabled submit for whitespace-only text. The panel renders pending/error captures before cards and confirms only permanent deletion.

- [ ] **Step 4: Run UI tests to verify GREEN**

Run: `cd ui && bun test src/ProblemsPanel.test.tsx src/DashboardView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/types.ts ui/src/api.ts ui/src/ProblemsPanel.tsx ui/src/ProblemsPanel.test.tsx ui/src/DashboardView.tsx ui/src/DashboardView.test.tsx ui/src/styles/dashboard.css
git commit -m "feat(problems): add capture and dashboard catalogue"
```

### Task 6: Résurgence dans Nouvelle conversation

**Files:**
- Create: `ui/src/ProblemSuggestions.tsx`
- Create: `ui/src/ProblemSuggestions.test.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/Chat.tsx`
- Modify: `ui/src/Composer.tsx`
- Modify: `ui/src/conversationDraft.ts`
- Modify: `ui/src/api.ts`
- Modify: `ui/src/styles/chat.css`
- Modify: `ui/src/Chat.test.tsx`

**Interfaces:**
- Produces: `ProblemSuggestions` limited to five, sorted unlaunched then newest.
- Changes: conversation seed gains `originType: "problem"`, `originKey`, `problemPlanIndex`, prefilled draft and ticket.

- [ ] **Step 1: Write failing suggestion tests**

```tsx
test("propose cinq problématiques non lancées en priorité", () => {
  render(<ProblemSuggestions problems={fixtureOfSix} onSelect={onSelect} onSeeAll={onSeeAll} />)
  expect(screen.getAllByRole("button", { name: /Lancer/ })).toHaveLength(5)
  fireEvent.click(screen.getByRole("button", { name: "Lancer Corriger le bug" }))
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
    originType: "problem", originKey: "PB-7K3M9Q", problemPlanIndex: 0,
  }))
})
```

- [ ] **Step 2: Run UI tests to verify RED**

Run: `cd ui && bun test src/ProblemSuggestions.test.tsx src/Chat.test.tsx`
Expected: FAIL because suggestions and problem origin types are missing.

- [ ] **Step 3: Implement derived suggestions and seed propagation**

Fetch the project list only while the new-conversation screen is mounted using the existing abortable data-loading pattern. Do not synchronize derived selection with an effect: the click handler writes the seed, draft and ticket together. `Composer` forwards `problemPlanIndex` in `CreateConversationInput`.

- [ ] **Step 4: Run UI tests to verify GREEN**

Run: `cd ui && bun test src/ProblemSuggestions.test.tsx src/Chat.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/ProblemSuggestions.tsx ui/src/ProblemSuggestions.test.tsx ui/src/App.tsx ui/src/Chat.tsx ui/src/Composer.tsx ui/src/conversationDraft.ts ui/src/api.ts ui/src/styles/chat.css ui/src/Chat.test.tsx
git commit -m "feat(problems): resurface work when starting conversations"
```

### Task 7: Documentation et vérification système

**Files:**
- Modify: `docs/help/tableau-de-bord.md`
- Modify: `docs/superpowers/plans/2026-08-29-problematiques.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: user-facing help and verified delivery.

- [ ] **Step 1: Document the exact user flow**

Add sections describing `Capturer`, `Ctrl + Entrée`, error retry, problem actions, suggestions in Nouvelle conversation and `[PB-XXXXXX]` closure.

- [ ] **Step 2: Run fresh full verification**

Run: `cd sidecar && bun test`
Expected: all sidecar tests pass with 0 failures.

Run: `cd ui && bun test && bun run build`
Expected: all UI tests pass with 0 failures and Vite exits 0.

- [ ] **Step 3: Verify the running UI in the browser**

Open `http://localhost:5173`, measure that five dashboard tabs exist, open the capture modal, verify the 50,000-character limit and `Ctrl + Entrée` hint, then capture the dashboard. Because the live sidecar cannot be restarted from this conversation, use the current UI for DOM assertions and report that backend activation requires an app restart.

- [ ] **Step 4: Review repository state and commit documentation**

Run: `git diff --check && git status --short && git log --oneline --max-count=10`

```bash
git add docs/help/tableau-de-bord.md docs/superpowers/plans/2026-08-29-problematiques.md
git commit -m "docs: explain the problem capture workflow"
```

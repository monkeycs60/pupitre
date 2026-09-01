# Product Audit One-Shot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved product-audit refactor, centered on durable problem-axis lifecycle, a reliable Inbox, clean supervision surfaces, and independent same-worktree `@sidequest` conversations.

**Architecture:** Add additive SQLite state for problem-axis runs, attention items, and conversation provenance. Keep problem and mission display states as projections, then expose focused REST contracts consumed by Inbox, Problems, Fleet, Dashboard, navigation, and notifications. Preserve existing conversation execution paths and explicitly leave autonomy/YOLO and Progression/gamification behavior unchanged.

**Tech Stack:** Bun, TypeScript, bun:sqlite, Hapi-compatible sidecar HTTP server, React 18, Vite, Vitest, Testing Library, CSS.

**Spec:** `docs/superpowers/specs/2026-09-02-product-audit-one-shot-design.md`

## Global Constraints

- Use the development sidecar only on port 4821 with `~/.local/share/pupitre-dev`; never restart or bind the stable port 4820.
- Do not change YOLO/autonomy behavior, defaults, labels, approval handling, or permission-mode selection.
- Do not change Progression, levels, thresholds, rewards, or gamification calculations.
- Use additive, replay-safe database migrations and preserve historical records.
- A sidequest is an independent conversation sharing the exact project, branch, worktree, and cwd of its source conversation.
- Verify UI behavior in the running app at `http://localhost:5173`, inspect the DOM, and attach a final screenshot.
- Run both `cd sidecar && bun test` and `cd ui && bun test` before completion.

---

### Task 1: Durable axis lifecycle schema and store

**Files:**
- Modify: `sidecar/src/db.ts`
- Create: `sidecar/src/stores/problem-axis-runs.ts`
- Create: `sidecar/tests/problem-axis-runs-store.test.ts`
- Modify: `sidecar/src/stores/problems.ts`
- Modify: `sidecar/src/stores/problem-missions.ts`

**Interfaces:**
- Produces `ProblemAxisRunStatus = "pending" | "running" | "interrupted" | "failed" | "awaiting_validation" | "completed" | "abandoned"`.
- Produces `ProblemAxisRunStore.createMissionRuns`, `bindTurn`, `transition`, `completeProblem`, `listForProblem`, and `listForMission`.
- Extends hydrated problems and missions with projected progress state and axis runs.

- [ ] **Step 1: Write failing migration and transition tests**

Create fixtures proving that historical closed problems hydrate completed axes, open historical problems hydrate pending axes, a late `done` event cannot overwrite `completed`, and mission projection only includes selected plan indices.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `cd sidecar && bun test tests/problem-axis-runs-store.test.ts`

Expected: FAIL because the table and store do not exist.

- [ ] **Step 3: Add additive tables and indexes**

Add `problem_axis_runs` with stable `(problem_id, plan_index, conversation_id)` identity, optional mission and turn identifiers, status, error, and timestamps. Add indexes for problem, mission, conversation, and actionable status.

- [ ] **Step 4: Implement guarded transitions and projections**

Use a single transition function that refuses regression from `completed` and `abandoned`. Implement the priority projection documented in the spec and return axis state from problem/mission queries.

- [ ] **Step 5: Run focused and existing problem tests**

Run: `cd sidecar && bun test tests/problem-axis-runs-store.test.ts tests/problems-store.test.ts tests/problem-missions-store.test.ts tests/problem-commits.test.ts`

- [ ] **Step 6: Commit the lifecycle store**

Run: `git add sidecar/src/db.ts sidecar/src/stores/problem-axis-runs.ts sidecar/src/stores/problems.ts sidecar/src/stores/problem-missions.ts sidecar/tests && git commit -m "feat: persist problem axis lifecycle"`

### Task 2: Bind conversation turns to axis lifecycle

**Files:**
- Modify: `sidecar/src/server.ts`
- Modify: `sidecar/src/runner.ts`
- Modify: `sidecar/src/index.ts`
- Modify: `sidecar/src/problems.ts`
- Test: `sidecar/tests/problem-missions.test.ts`
- Create: `sidecar/tests/problem-axis-lifecycle.test.ts`

**Interfaces:**
- Consumes `ProblemAxisRunStore` from Task 1.
- Produces lifecycle updates from conversation creation, run start, user abort, error, normal completion, manual validation, abandonment, and marked commits.

- [ ] **Step 1: Write failing end-to-end lifecycle tests**

Cover selected axis creation, turn binding, abort to `interrupted`, technical error to `failed`, normal completion to `awaiting_validation`, validation to `completed`, resume creating a new run, and `[PB-XXXXXX]` completion.

- [ ] **Step 2: Confirm the tests fail**

Run: `cd sidecar && bun test tests/problem-axis-lifecycle.test.ts`

- [ ] **Step 3: Wire lifecycle events transactionally**

Create axis runs in the same transaction as the mission link. Pass an explicit completion reason from `Runner` so user abort is distinguishable from adapter failure. Add validate, abandon, resume, and history routes under `/api/problems/:id/axes/:index`.

- [ ] **Step 4: Preserve compatibility**

Continue accepting `originKey`, `problemPlanIndex`, `problemIds`, and `problemPlanIndices`. Do not change runner permission inputs.

- [ ] **Step 5: Run lifecycle and runner tests**

Run: `cd sidecar && bun test tests/problem-axis-lifecycle.test.ts tests/problem-missions.test.ts tests/runner.test.ts`

- [ ] **Step 6: Commit lifecycle wiring**

Run: `git add sidecar/src sidecar/tests && git commit -m "feat: connect turns to problem lifecycle"`

### Task 3: Persistent attention-item store and producers

**Files:**
- Modify: `sidecar/src/db.ts`
- Create: `sidecar/src/stores/attention-items.ts`
- Create: `sidecar/src/attention.ts`
- Modify: `sidecar/src/index.ts`
- Modify: `sidecar/src/server.ts`
- Modify: `sidecar/src/runner.ts`
- Modify: `sidecar/src/routines.ts`
- Modify: `sidecar/src/reviews.ts`
- Create: `sidecar/tests/attention-items-store.test.ts`
- Create: `sidecar/tests/attention.test.ts`

**Interfaces:**
- Produces `AttentionItem`, `AttentionTarget`, `AttentionItemStore.upsertCondition`, `resolveCondition`, `acknowledge`, and list filters.
- Produces `GET /api/attention`, `POST /api/attention/:id/acknowledge`, and project/global filtering.

- [ ] **Step 1: Write failing versioning tests**

Prove unique type/source keys, repeated identical signals staying acknowledged, changed condition versions reappearing, resolved conditions disappearing, and dangling targets remaining readable.

- [ ] **Step 2: Confirm failure**

Run: `cd sidecar && bun test tests/attention-items-store.test.ts tests/attention.test.ts`

- [ ] **Step 3: Implement the store and REST API**

Persist structured JSON targets, severity, condition version, state, and timestamps. Keep source facts outside this table.

- [ ] **Step 4: Add initial producers**

Produce items for actionable axes, failed turns, open TODO blocks, red Guardian flags, failed routines, relevant failed pipelines, and relevant new Sentry issues. Resolve each item when its source condition clears.

- [ ] **Step 5: Run store, producer, routine, and review tests**

Run: `cd sidecar && bun test tests/attention-items-store.test.ts tests/attention.test.ts tests/routines.test.ts tests/reviews.test.ts`

- [ ] **Step 6: Commit attention infrastructure**

Run: `git add sidecar/src sidecar/tests && git commit -m "feat: add persistent attention inbox"`

### Task 4: Independent sidequest provenance and parser

**Files:**
- Modify: `sidecar/src/db.ts`
- Create: `sidecar/src/sidequests.ts`
- Create: `sidecar/src/stores/conversation-links.ts`
- Modify: `sidecar/src/server.ts`
- Modify: `sidecar/src/stores/conversations.ts`
- Modify: `sidecar/src/events.ts`
- Create: `sidecar/tests/sidequests.test.ts`
- Create: `sidecar/tests/conversation-links-store.test.ts`

**Interfaces:**
- Produces `parseSidequestDirective(text)` and `createSidequest({ sourceConversationId, sourceEventId, instruction, model? })`.
- Produces provenance lookup by source and destination conversation.

- [ ] **Step 1: Write failing parser and creation tests**

Cover minimal syntax, quoted model syntax, malformed parameters, unknown models, last-exchange context only, exact branch/worktree/cwd reuse, independent deletion/archival, creation success followed by launch failure, and duplicate-submit idempotency.

- [ ] **Step 2: Confirm failure**

Run: `cd sidecar && bun test tests/sidequests.test.ts tests/conversation-links-store.test.ts`

- [ ] **Step 3: Implement parsing and provenance storage**

Parse only a leading directive, keep the instruction editable on validation failure, resolve model names against the existing catalog, and copy the source model when omitted.

- [ ] **Step 4: Create and launch through existing conversation APIs**

Reuse the source project, worktree path, branch, ticket, problems, permission mode, and compatible model settings. Build a compact context from the directive, preceding user-assistant exchange, linked metadata, and the shared-worktree warning.

- [ ] **Step 5: Run sidequest and conversation suites**

Run: `cd sidecar && bun test tests/sidequests.test.ts tests/conversation-links-store.test.ts tests/conversations-store.test.ts`

- [ ] **Step 6: Commit sidequest backend**

Run: `git add sidecar/src sidecar/tests && git commit -m "feat: create independent sidequest conversations"`

### Task 5: Reliable changelog and Sentry signals

**Files:**
- Modify: `sidecar/src/db.ts`
- Modify: `sidecar/src/stores/changelog.ts`
- Modify: `sidecar/src/integrations/refresher.ts`
- Modify: `sidecar/src/integrations/sentry.ts`
- Modify: `sidecar/src/integrations/git.ts`
- Test: `sidecar/tests/changelog-store.test.ts`
- Test: `sidecar/tests/integration-refresher.test.ts`
- Test: `sidecar/tests/sentry-classification.test.ts`

**Interfaces:**
- Produces canonical changelog identity `(project_id, commit_sha)` and stricter Sentry relevance reasons.
- Preserves last successful integration data and clears degraded status after success.

- [ ] **Step 1: Add failing regressions for every audited false signal**

Cover six worktrees containing the same SHA, one enrichment per project/SHA, generic four-letter word mismatch, explicit identifier match, two-signal match, domain filter behavior, and degraded-to-healthy recovery.

- [ ] **Step 2: Confirm failure**

Run: `cd sidecar && bun test tests/changelog-store.test.ts tests/integration-refresher.test.ts tests/sentry-classification.test.ts`

- [ ] **Step 3: Implement canonical repository and classification rules**

Exclude Git worktrees from project repository discovery, migrate duplicate changelog rows deterministically, and require explicit or two independent Sentry signals.

- [ ] **Step 4: Implement integration freshness state**

Track failing call, failure time, last success, actionable configuration hint, and clear current error on the next success.

- [ ] **Step 5: Run integration tests**

Run the command from Step 2 and confirm all pass.

- [ ] **Step 6: Commit signal fixes**

Run: `git add sidecar/src sidecar/tests && git commit -m "fix: remove false dashboard signals"`

### Task 6: Frontend contracts and Inbox surface

**Files:**
- Modify: `ui/src/types.ts`
- Modify: `ui/src/api.ts`
- Create: `ui/src/AttentionInbox.tsx`
- Create: `ui/src/useAttention.ts`
- Create: `ui/src/AttentionInbox.test.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/Rail.tsx`
- Modify: `ui/src/styles.css`

**Interfaces:**
- Consumes attention REST contracts from Task 3.
- Produces global/project Inbox filtering, typed cards, `Ouvrir`, `Traité`, and structured navigation callbacks.

- [ ] **Step 1: Write failing Inbox rendering and interaction tests**

Cover type labels, severity, empty state, project filtering, acknowledgement, reappeared version, conversation/message target, problem-axis target, dashboard target, and badge count.

- [ ] **Step 2: Confirm failure**

Run: `cd ui && bun test AttentionInbox.test.tsx Rail.test.tsx`

- [ ] **Step 3: Add types, API, polling/revalidation hook, and view**

Keep navigation targets structured; do not parse URLs inside cards. Add Inbox to `WorkspaceView` and route it through App callbacks.

- [ ] **Step 4: Add rail badge and accessibility**

Expose the actionable count, keyboard focus, visible labels, and stable empty/loading/error states.

- [ ] **Step 5: Run focused UI tests**

Run the command from Step 2.

- [ ] **Step 6: Commit Inbox UI**

Run: `git add ui/src && git commit -m "feat: add attention inbox UI"`

### Task 7: Problem lifecycle UI and resume flow

**Files:**
- Modify: `ui/src/types.ts`
- Modify: `ui/src/api.ts`
- Modify: `ui/src/ProblemsPanel.tsx`
- Modify: `ui/src/ProblemSuggestions.tsx`
- Modify: `ui/src/problemMission.ts`
- Modify: `ui/src/ProblemsPanel.test.tsx`
- Modify: `ui/src/ProblemSuggestions.test.tsx`
- Modify: `ui/src/styles.css`

**Interfaces:**
- Consumes axis run projections and transition routes from Tasks 1–2.
- Produces per-axis status, history link, and Launch/Open/Resume/Retry/Validate/Abandon actions.

- [ ] **Step 1: Replace open/closed-only test fixtures with axis lifecycle fixtures**

Add failing cases for all seven states, mission aggregate state, selected indices, and the exact actionable subset in `À reprendre`.

- [ ] **Step 2: Confirm failure**

Run: `cd ui && bun test ProblemsPanel.test.tsx ProblemSuggestions.test.tsx`

- [ ] **Step 3: Render states and actions from server projections**

Stop inferring resumability from `conversation_count`. Keep closed historical problems readable and make interruption neutral rather than red.

- [ ] **Step 4: Wire mutations and refresh**

Validate, abandon, resume, and retry through typed API functions; refresh Dashboard and Inbox after success.

- [ ] **Step 5: Run focused tests**

Run the command from Step 2.

- [ ] **Step 6: Commit problem lifecycle UI**

Run: `git add ui/src && git commit -m "feat: expose problem axis lifecycle"`

### Task 8: Sidequest composer and provenance cards

**Files:**
- Modify: `ui/src/types.ts`
- Modify: `ui/src/api.ts`
- Modify: `ui/src/Composer.tsx`
- Create: `ui/src/SidequestCard.tsx`
- Create: `ui/src/SidequestOrigin.tsx`
- Create: `ui/src/sidequestDirective.ts`
- Create: `ui/src/SidequestCard.test.tsx`
- Create: `ui/src/sidequestDirective.test.ts`
- Modify: `ui/src/Chat.tsx`
- Modify: `ui/src/styles.css`

**Interfaces:**
- Consumes sidequest contracts from Task 4.
- Produces directive preview/validation, source card, destination backlink, retry, and concurrent-write warning.

- [ ] **Step 1: Write failing directive and card tests**

Cover inherited model, explicit model, unknown model retaining draft text, independent conversation navigation, launch failure retry, source archival, and same-worktree warning.

- [ ] **Step 2: Confirm failure**

Run: `cd ui && bun test sidequestDirective.test.ts SidequestCard.test.tsx`

- [ ] **Step 3: Parse for preview and submit atomically through the sidequest endpoint**

Do not send the directive as a normal parent turn after successful sidequest creation. On validation failure, focus the unchanged composer draft.

- [ ] **Step 4: Render provenance in both independent conversations**

Display source card status and destination backlink without nesting either conversation’s event stream.

- [ ] **Step 5: Run focused tests**

Run the command from Step 2.

- [ ] **Step 6: Commit sidequest UI**

Run: `git add ui/src && git commit -m "feat: launch sidequests from the composer"`

### Task 9: Fleet supervision cleanup and clickable notifications

**Files:**
- Modify: `ui/src/useFleet.ts`
- Modify: `ui/src/FleetView.tsx`
- Modify: `ui/src/useFleet.test.ts`
- Modify: `ui/src/FleetView.test.tsx`
- Modify: `ui/src/useAppNotifications.ts`
- Modify: `ui/src/App.tsx`
- Create: `ui/src/attentionNavigation.ts`
- Create: `ui/src/attentionNavigation.test.ts`

**Interfaces:**
- Fleet produces only active and recent-history views.
- Notification clicks consume the same structured target navigation as Inbox.

- [ ] **Step 1: Write failing Fleet and notification tests**

Assert no `À traiter` tab, no `needsAttention`, no generic backend-limit copy, bounded recent history, native notification click navigation, and acknowledgement sharing.

- [ ] **Step 2: Confirm failure**

Run: `cd ui && bun test useFleet.test.ts FleetView.test.tsx attentionNavigation.test.ts`

- [ ] **Step 3: Simplify Fleet history and centralize target navigation**

Retain local recent history only. Route notification clicks and Inbox buttons through one target dispatcher owned by App.

- [ ] **Step 4: Run focused tests**

Run the command from Step 2.

- [ ] **Step 5: Commit supervision cleanup**

Run: `git add ui/src && git commit -m "refactor: separate Fleet from attention"`

### Task 10: Ticket-centered Dashboard and integration flux

**Files:**
- Modify: `ui/src/DashboardView.tsx`
- Modify: `ui/src/useDashboard.ts`
- Modify: `ui/src/DashboardView.test.tsx`
- Modify: `ui/src/SentryInbox.tsx`
- Create: `ui/src/DashboardFlux.tsx`
- Create: `ui/src/DashboardFlux.test.tsx`
- Modify: `ui/src/styles.css`

**Interfaces:**
- Produces default `tickets` tab, ticket badges for relevant Sentry/changelog/environment facts, and a chronological Flux tab.

- [ ] **Step 1: Write failing default-tab, deduplication, freshness, and Flux tests**

Assert `Mes tickets` opens first, redundant Changelog menu is absent, one refresh control exists, integration failure is compact, last success is visible, and Flux sorts mixed events chronologically.

- [ ] **Step 2: Confirm failure**

Run: `cd ui && bun test DashboardView.test.tsx DashboardFlux.test.tsx SentryInbox.test.tsx`

- [ ] **Step 3: Reshape the Dashboard without removing Problems**

Keep Problems as a dedicated tab, fold relevant facts into ticket rows, add Flux, and present actionable integration status in the header.

- [ ] **Step 4: Run focused tests**

Run the command from Step 2.

- [ ] **Step 5: Commit Dashboard refactor**

Run: `git add ui/src && git commit -m "refactor: center dashboard on tickets"`

### Task 11: Rail grouping, vocabulary, presets, and contextual help

**Files:**
- Modify: `ui/src/Rail.tsx`
- Modify: `ui/src/Rail.test.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/ModelConfigSelector.tsx`
- Modify: `sidecar/src/stores/presets.ts`
- Create: `ui/src/ProductTerm.tsx`
- Create: `ui/src/ProductTerm.test.tsx`
- Modify: `ui/src/styles.css`
- Modify: `docs/help/*.md`

**Interfaces:**
- Produces four visible rail groups while keeping Progression intact.
- Produces consistent intention-first preset labels without changing model or permission values.

- [ ] **Step 1: Write failing rail, preset-label, and help-popover tests**

Assert group order, Inbox placement, non-overlapping expanded rail, Claude Design contextual availability, unchanged Progression target, consistent casing, technical subtext, and help navigation.

- [ ] **Step 2: Confirm failure**

Run: `cd ui && bun test Rail.test.tsx ModelConfigSelector.test.tsx ProductTerm.test.tsx`

- [ ] **Step 3: Implement grouping and vocabulary components**

Preserve all existing callbacks. Rename only built-in display labels; do not alter provider, model, effort, or permission mode payloads.

- [ ] **Step 4: Update touched help pages**

Correct Gardien and add contextual anchors for Gardien, Scout, Luna, Sol, Fable, axes, missions, Fleet, Handoff, Débrief, and Répétition. YOLO help remains unchanged.

- [ ] **Step 5: Run focused tests**

Run the command from Step 2.

- [ ] **Step 6: Commit navigation and language**

Run: `git add ui/src sidecar/src/stores/presets.ts docs/help && git commit -m "refactor: organize navigation by use"`

### Task 12: Audited UI quick wins

**Files:**
- Modify: `ui/src/ConversationAssetsDrawer.tsx`
- Modify: `ui/src/Composer.tsx`
- Modify: `ui/src/Sidebar.tsx`
- Create: `ui/src/useDismissable.ts`
- Create: `ui/src/useDismissable.test.tsx`
- Modify: `ui/src/CommandPalette.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/DocumentsView.tsx`
- Modify: `ui/src/CostsView.tsx`
- Modify: `ui/src/RoutinesView.tsx`
- Modify: `ui/src/AppSettingsView.tsx`
- Modify: `ui/src/SkillsLibrary.tsx`
- Modify: `ui/src/styles.css`
- Test: corresponding existing `ui/src/*.test.tsx` files

**Interfaces:**
- Produces one shared dismissable-layer behavior, stable message anchors, grouped skills, corrected empty defaults, and relocated notification threshold.

- [ ] **Step 1: Add one failing regression per audited quick win**

Cover zero attachments, new-conversation slash placeholder, Escape/outside/concurrent popover dismissal, help-hash cleanup and reload, search source anchoring plus Actions/Aide results, all-project Documents default, last-used Costs month, routine timezone/next occurrences/settings location, grouped skill sources, and delayed sidebar summary placement.

- [ ] **Step 2: Run the focused tests and confirm failures**

Run the affected test files explicitly with `cd ui && bun test <files>`.

- [ ] **Step 3: Implement shared primitives first**

Add `useDismissable` and stable message navigation, then apply small view fixes without unrelated refactors.

- [ ] **Step 4: Implement data/default corrections**

Group skills by invocation name with explicit sources, move the long-task threshold, expose routine occurrence previews and timezone, and select useful empty-state defaults.

- [ ] **Step 5: Run all affected tests**

Run the same explicit list and confirm zero failures.

- [ ] **Step 6: Commit quick wins**

Run: `git add ui/src && git commit -m "fix: resolve audited interface inconsistencies"`

### Task 13: Documentation consistency and full automated verification

**Files:**
- Modify: `README.md`
- Modify: `docs/help/gardien.md`
- Modify: other help files touched by the final UI
- Modify: tests only when verification exposes a real contract gap

**Interfaces:**
- No new runtime interface; documents the reachable UI only.

- [ ] **Step 1: Remove stale Code-view claims and verify help links**

Search: `rg -n "Code › Changements|onglet Changements|vue Git|#help/" README.md docs/help ui/src`

- [ ] **Step 2: Run sidecar suite**

Run: `cd sidecar && bun test`

Expected: zero failed tests.

- [ ] **Step 3: Run UI suite**

Run: `cd ui && bun test`

Expected: zero failed tests.

- [ ] **Step 4: Run builds and static checks defined by package scripts**

Run: `bun run build` from the repository root, plus any lint/typecheck script reported by `bun run`.

- [ ] **Step 5: Inspect exclusions explicitly**

Run: `git diff b0ed695 -- ui/src/ProgressionView.tsx sidecar/src/adapters/codex-app-server.ts ui/src/ProjectSettingsDialog.tsx`

Expected: no functional diff touching Progression or autonomy handling.

- [ ] **Step 6: Commit documentation/test corrections**

Run: `git add README.md docs ui/src sidecar/src sidecar/tests && git commit -m "docs: align help with product refactor"`

### Task 14: Browser contradiction checks and final delivery commit

**Files:**
- Modify: only files required by defects observed in the running app
- Create outside repository: final screenshot under `/tmp`, then expose its absolute path

**Interfaces:**
- Validates all user-visible contracts in the same frontend and development sidecar used by the Tauri app.

- [ ] **Step 1: Start or restart the development sidecar and Vite safely**

Use `bun run dev:sidecar` or `bun run dev:sidecar:watch` for port 4821 and the existing Vite command for port 5173. Never touch port 4820.

- [ ] **Step 2: Exercise the lifecycle path in Chrome**

Measure DOM states for pending, running, interrupted, failed, awaiting-validation, and completed axes. Confirm an interruption is neutral and Inbox contains exactly one matching item.

- [ ] **Step 3: Exercise Inbox/Fleet and sidequest paths**

Confirm Fleet has exactly two tabs, acknowledgement removes one version, a changed condition reappears, deep links target the exact element, and a sidequest is a separate sidebar conversation with identical branch/worktree metadata and correct inherited or explicit model.

- [ ] **Step 4: Exercise Dashboard, navigation, and quick wins**

Count duplicate changelog entries, inspect Sentry relevance, verify default ticket tab, rail groups, popover dismissal, search anchors, and useful empty defaults.

- [ ] **Step 5: Capture evidence and rerun both complete suites after browser fixes**

Run: `cd sidecar && bun test`, then `cd ui && bun test`, then the relevant build command. Save a screenshot showing the completed supervision/lifecycle flow.

- [ ] **Step 6: Inspect and commit the final verified state**

Run `git status --short`, `git diff --check`, and review every remaining diff. Commit only in-scope corrections with `git commit -m "feat: complete product audit refactor"`.


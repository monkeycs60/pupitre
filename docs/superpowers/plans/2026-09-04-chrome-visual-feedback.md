# Chrome Visual Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Annoter des éléments d'une page localhost dans Chrome et envoyer un panier contextualisé à une conversation Pupitre sur la branche choisie.

**Architecture:** Une extension Manifest V3 collecte des annotations DOM et dialogue avec un service dédié du sidecar par une API authentifiée. Le sidecar résout le projet, prépare le worktree et la conversation, importe les captures, démarre le tour, puis diffuse une demande de navigation à l'UI Pupitre.

**Tech Stack:** TypeScript, Bun, React 18, Chrome Extensions Manifest V3, SQLite, APIs HTTP/WebSocket Pupitre.

**Spec:** `docs/superpowers/specs/2026-09-04-chrome-visual-feedback-design.md`

## Global Constraints

- L'extension ne s'exécute que sur `localhost`, `127.0.0.1` et les sous-domaines de `localhost`.
- Aucun projet inspecté n'est modifié.
- Les paniers sont séparés par projet et persistent jusqu'à l'accusé de réception du sidecar.
- Pupitre ne change jamais la branche du dépôt principal ; il réutilise ou crée un worktree.
- Les valeurs de formulaire, mots de passe et contenus éditables ne sont jamais collectés.
- Le port stable 4820 n'est jamais occupé par les commandes de développement ; les vérifications utilisent le sidecar dev 4821.

---

### Task 1: Domaine de retours visuels du sidecar

**Files:**
- Create: `sidecar/src/visual-feedback.ts`
- Test: `sidecar/tests/visual-feedback.test.ts`

**Interfaces:**
- Produces: `VisualFeedbackService`, `sanitizeVisualFeedbackSubmission`, `visualFeedbackPrompt`, et les types `VisualFeedbackAnnotation`, `VisualFeedbackSubmission`, `VisualFeedbackResolution`.
- Consumes: `ProjectStore`, `ConversationStore`, `GitProjectService`, `PresetStore`, `MediaStore`, `ConversationRunner`.

- [ ] **Step 1: Write failing domain tests**

Tester avec `bun:test` que la validation refuse les champs sensibles et charges hors bornes, que `visualFeedbackPrompt` conserve l'ordre des numéros, et que deux appels avec le même `submissionId` renvoient le même résultat.

- [ ] **Step 2: Verify the tests fail**

Run: `cd sidecar && bun test tests/visual-feedback.test.ts`
Expected: FAIL because `../src/visual-feedback` does not exist.

- [ ] **Step 3: Implement the service**

Définir :

```ts
export interface VisualFeedbackSubmission {
  version: 1;
  submissionId: string;
  projectId: string;
  branch: string;
  conversationId?: string;
  generalInstruction?: string;
  page: { url: string; title: string; viewport: { width: number; height: number; devicePixelRatio: number } };
  annotations: VisualFeedbackAnnotation[];
}

export class VisualFeedbackService {
  resolveOrigin(input: { hostname: string; port: number; pathname: string }): VisualFeedbackResolution;
  destinations(projectId: string): { branches: string[]; conversations: Conversation[] };
  submit(input: VisualFeedbackSubmission): Promise<{ conversationId: string; projectId: string }>;
}
```

La soumission valide les bornes, réutilise/crée le worktree via `createWorktree`, choisit une conversation compatible ou en crée une avec le preset par défaut du projet, importe les captures depuis leurs data URLs, puis appelle `runner.runTurn`. Mémoriser les résultats par `submissionId` dans une table dédiée.

- [ ] **Step 4: Run domain tests**

Run: `cd sidecar && bun test tests/visual-feedback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/visual-feedback.ts sidecar/tests/visual-feedback.test.ts
git commit -m "feat: add visual feedback domain"
```

### Task 2: Persistance, appairage et résolution des origines

**Files:**
- Modify: `sidecar/src/db.ts`
- Modify: `sidecar/src/stores/settings.ts`
- Modify: `sidecar/src/index.ts`
- Modify: `sidecar/src/visual-feedback.ts`
- Test: `sidecar/tests/visual-feedback.test.ts`

**Interfaces:**
- Produces: réglage `visual-feedback-token`, tables `visual_feedback_submissions` et `visual_feedback_origins`, `pairingState()`, `rotatePairingToken()`, `associateOrigin()`.
- Consumes: interfaces de Task 1.

- [ ] **Step 1: Add failing persistence tests**

Tester la génération/révocation du jeton, la persistance de l'idempotence et l'association exacte `origin + pathPrefix -> projectId`, avec préférence pour le préfixe le plus long.

- [ ] **Step 2: Verify failure**

Run: `cd sidecar && bun test tests/visual-feedback.test.ts`
Expected: FAIL on missing migrations and methods.

- [ ] **Step 3: Add additive migrations and persistence**

Créer des tables additives avec unicité sur `submission_id` et sur `(origin, path_prefix)`. Stocker uniquement le hash SHA-256 du jeton ; le jeton brut n'est rendu qu'à sa création ou rotation.

- [ ] **Step 4: Implement process-to-project resolution**

Sur Linux, résoudre le PID écoutant via `ss -ltnp`, lire `/proc/<pid>/cwd`, canonicaliser le chemin et choisir le projet dont la racine ou un worktree contient ce cwd. En cas d'échec, utiliser l'association mémorisée ; sinon renvoyer `unresolved` ou `ambiguous` sans deviner.

- [ ] **Step 5: Run tests and commit**

Run: `cd sidecar && bun test tests/visual-feedback.test.ts`
Expected: PASS.

```bash
git add sidecar/src/db.ts sidecar/src/stores/settings.ts sidecar/src/index.ts sidecar/src/visual-feedback.ts sidecar/tests/visual-feedback.test.ts
git commit -m "feat: persist visual feedback pairing"
```

### Task 3: API HTTP et canal de navigation

**Files:**
- Modify: `sidecar/src/server.ts`
- Modify: `ui/src/api.ts`
- Modify: `ui/src/types.ts`
- Test: `sidecar/tests/visual-feedback-routes.test.ts`

**Interfaces:**
- Produces: `GET /api/visual-feedback/pairing`, `POST /api/visual-feedback/pairing/rotate`, `POST /api/visual-feedback/resolve`, `PUT /api/visual-feedback/origins`, `GET /api/visual-feedback/projects/:id/destinations`, `POST /api/visual-feedback/submissions`, `WS /ws/navigation`.
- Consumes: `VisualFeedbackService` de Tasks 1–2.

- [ ] **Step 1: Write failing route tests**

Vérifier CORS pour l'origine `chrome-extension://<id>`, refus sans Bearer token, validation JSON, association manuelle, succès idempotent et message de navigation `{ type: "open-conversation", projectId, conversationId }`.

- [ ] **Step 2: Verify failure**

Run: `cd sidecar && bun test tests/visual-feedback-routes.test.ts`
Expected: FAIL with 404 routes.

- [ ] **Step 3: Add authenticated routes**

Autoriser une origine Chrome uniquement sur le préfixe `/api/visual-feedback/`, répondre aux preflights avec les en-têtes CORS requis, vérifier le Bearer token avec comparaison constante, et appliquer une limite de corps dédiée.

- [ ] **Step 4: Add navigation WebSocket**

Étendre `WebSocketData` avec `{ channel: "navigation" }`, publier après acceptation de la soumission et consommer cet événement dans l'UI via une fonction d'API typée.

- [ ] **Step 5: Run tests and commit**

Run: `cd sidecar && bun test tests/visual-feedback-routes.test.ts`
Expected: PASS.

```bash
git add sidecar/src/server.ts sidecar/tests/visual-feedback-routes.test.ts ui/src/api.ts ui/src/types.ts
git commit -m "feat: expose visual feedback bridge"
```

### Task 4: Extension Chrome — domaine, inspecteur et panier

**Files:**
- Create: `chrome-extension/manifest.json`
- Create: `chrome-extension/package.json`
- Create: `chrome-extension/tsconfig.json`
- Create: `chrome-extension/src/types.ts`
- Create: `chrome-extension/src/dom.ts`
- Create: `chrome-extension/src/cart.ts`
- Create: `chrome-extension/src/content.ts`
- Create: `chrome-extension/src/content.css`
- Test: `chrome-extension/tests/dom.test.ts`
- Test: `chrome-extension/tests/cart.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `inspectElement(element, click, viewport)`, `redactElementClone(element)`, `VisualFeedbackCart`, messages `START_INSPECTION`, `ADD_ANNOTATION`, `CART_CHANGED`.
- Consumes: submission types compatibles avec Task 1.

- [ ] **Step 1: Write failing DOM and cart tests**

Avec happy-dom, vérifier la génération de plusieurs sélecteurs, les limites de profondeur/taille, la suppression des valeurs sensibles, la numérotation, la suppression et l'isolation par `projectId`.

- [ ] **Step 2: Verify failure**

Run: `cd chrome-extension && bun test`
Expected: FAIL because modules are missing.

- [ ] **Step 3: Implement pure DOM and cart modules**

Créer des fonctions sans dépendance Chrome pour rendre l'extraction et le stockage testables. Limiter l'extrait HTML à 12 KiB, les sélecteurs à 5 et les propriétés calculées à une liste blanche.

- [ ] **Step 4: Implement content overlay**

Ajouter un Shadow DOM isolé, contour de survol temporaire, croix numérotées persistantes, bulle texte, raccourci `Alt+Shift+P`, annulation `Escape`, boutons `Ajouter au panier` et `Envoyer`.

- [ ] **Step 5: Run tests and commit**

Run: `cd chrome-extension && bun test`
Expected: PASS.

```bash
git add chrome-extension package.json bun.lock
git commit -m "feat: add Chrome annotation inspector"
```

### Task 5: Extension Chrome — service worker et panneau

**Files:**
- Create: `chrome-extension/src/background.ts`
- Create: `chrome-extension/src/popup.html`
- Create: `chrome-extension/src/popup.ts`
- Create: `chrome-extension/src/popup.css`
- Create: `chrome-extension/scripts/build.ts`
- Test: `chrome-extension/tests/client.test.ts`
- Test: `chrome-extension/tests/submission.test.ts`

**Interfaces:**
- Produces: `PupitreClient`, stockage `chrome.storage.local` pour jeton, origine, destinations et paniers, build dans `chrome-extension/dist`.
- Consumes: routes de Task 3 et messages de Task 4.

- [ ] **Step 1: Write failing client tests**

Mocker `fetch` et vérifier l'en-tête Bearer, le fallback 4820/4821 configurable, la conservation du panier sur erreur, sa suppression après succès et la stabilité du `submissionId` pendant les retries.

- [ ] **Step 2: Verify failure**

Run: `cd chrome-extension && bun test tests/client.test.ts tests/submission.test.ts`
Expected: FAIL on missing client.

- [ ] **Step 3: Implement background service worker**

Centraliser réseau, captures via `chrome.tabs.captureVisibleTab`, recadrage avec `OffscreenCanvas`, résolution de projet, destinations et soumission. Ne jamais exposer le jeton au content script.

- [ ] **Step 4: Implement popup**

Afficher connexion, projet/origine, panier, branche, conversation optionnelle, consigne générale, association manuelle et actions inspecter/envoyer/réessayer.

- [ ] **Step 5: Build, test and commit**

Run: `cd chrome-extension && bun test && bun run build`
Expected: PASS and `dist/manifest.json` plus compiled assets exist.

```bash
git add chrome-extension package.json bun.lock
git commit -m "feat: connect Chrome annotations to Pupitre"
```

### Task 6: Réglages d'appairage et navigation Pupitre

**Files:**
- Create: `ui/src/VisualFeedbackSettings.tsx`
- Test: `ui/src/VisualFeedbackSettings.test.tsx`
- Modify: `ui/src/AppSettingsView.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/api.ts`
- Modify: `ui/src/types.ts`
- Modify: `ui/src/index.css`

**Interfaces:**
- Produces: panneau « Retours visuels Chrome », rotation/copie du jeton et abonnement au canal `/ws/navigation`.
- Consumes: API de Task 3.

- [ ] **Step 1: Write failing UI tests**

Vérifier l'affichage de l'état d'appairage, la confirmation avant rotation, la copie du nouveau jeton et la conversion d'un événement WebSocket en sélection de la bonne conversation.

- [ ] **Step 2: Verify failure**

Run: `cd ui && bun test src/VisualFeedbackSettings.test.tsx`
Expected: FAIL because component is missing.

- [ ] **Step 3: Implement settings and navigation**

Ajouter les fonctions API typées, intégrer le panneau aux réglages et établir un abonnement WebSocket unique dans `App.tsx` qui appelle le chemin de navigation existant.

- [ ] **Step 4: Run UI tests and commit**

Run: `cd ui && bun test src/VisualFeedbackSettings.test.tsx src/AppSettingsView.test.tsx`
Expected: PASS.

```bash
git add ui/src/VisualFeedbackSettings.tsx ui/src/VisualFeedbackSettings.test.tsx ui/src/AppSettingsView.tsx ui/src/App.tsx ui/src/api.ts ui/src/types.ts ui/src/index.css
git commit -m "feat: manage Chrome feedback pairing"
```

### Task 7: Documentation et vérification intégrée

**Files:**
- Create: `docs/help/retours-visuels.md`
- Modify: `README.md`
- Modify: `ui/src/HelpView.tsx`
- Modify: `chrome-extension/README.md`

**Interfaces:**
- Consumes: toutes les interfaces précédentes.
- Produces: instructions d'installation, d'appairage et de recette.

- [ ] **Step 1: Document installation and operation**

Décrire le build, le chargement de `chrome-extension/dist` via `chrome://extensions`, la rotation du jeton et les limites localhost.

- [ ] **Step 2: Run all automated checks**

Run: `cd sidecar && bun test`
Expected: PASS.

Run: `cd ui && bun test`
Expected: PASS.

Run: `cd chrome-extension && bun test && bun run build`
Expected: PASS.

- [ ] **Step 3: Verify in Chrome**

Lancer `bun run dev:sidecar` sur 4821 et le front sur `http://localhost:5173`. Charger l'extension non empaquetée, créer deux annotations, confirmer deux croix dans le DOM, sélectionner une branche, envoyer, puis confirmer la conversation et les médias reçus. Répéter avec une seconde origine locale pour confirmer l'isolation des paniers. Capturer l'écran final.

- [ ] **Step 4: Review and final commit**

Run: `git diff --check && git status --short`
Expected: no whitespace errors and only scoped files.

```bash
git add README.md docs/help/retours-visuels.md ui/src/HelpView.tsx chrome-extension/README.md
git commit -m "docs: explain Chrome visual feedback"
```

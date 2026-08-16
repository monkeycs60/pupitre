# Gardien — boucle simple : relire → corriger → relire — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Réduire le Gardien à une seule boucle de feedback visible dans la vue Code : le diff de la conversation avec, inline, la raison de chaque signalement et ses actions (Corriger / OK vu / Ignorer), un bouton « Relire » qui rescanne (incrémental) et un rescan automatique quand les corrections sont terminées.

**Architecture:** Le moteur `ReviewRunner` (scan par zones, ancrage strict, incrémental par `hunk_hash`, dispatch en sous‑tâche) est conservé tel quel. On retire ce qui n'a jamais servi (contre‑avis, `auto_counter_red`, config de review par conversation, `auto_review` par conversation) et ce qui n'apporte rien à la boucle (explorateur de fichiers, quick‑open, lecture à une ref, sélecteurs de modèle dans les vues). La configuration devient unique : preset de review et preset de correction **du projet** (déjà réglables dans `ProjectSettingsDialog`), résolus côté sidecar. La vue Code garde deux onglets — **Changements** (diff de la conversation + calque Gardien) et **Historique** (commits + review par commit) — et le fil de conversation ne garde qu'une ligne d'état.

**Tech Stack:** Bun + SQLite (sidecar/), React 19 + Vite (ui/). Tests : `cd sidecar && bun test`, `cd ui && bun test`, `cd ui && bunx tsc --noEmit`.

**Constat qui motive le plan (base locale du 16 août) :** 36 reviews, 81 signalements dont 77 encore `open`, 0 contre‑avis lancé, 0 review incrémentale (l'UI n'envoie jamais `incremental: true`), `auto_review = 0` partout, `auto_counter_red = 0` partout. Les signalements d'une review « worktree » (27/36) n'apparaissent **jamais** inline dans la vue Code : l'onglet Changements affiche le diff brut sans calque.

**Règles du dépôt à respecter (CLAUDE.md) :**
- Ne jamais lancer `bun run dev:sidecar` ; pour recharger le sidecar après un changement backend : `pkill -f "sidecar/src/index.ts"` (il sort 143, Tauri le relance depuis les sources). Vérifier avant que rien ne tourne : `curl -s localhost:4820/api/fleet` doit montrer aucun tour actif.
- Vérifier l'UI dans le navigateur (`http://localhost:5173`, Vite est déjà lancé) avec Claude in Chrome : compter les éléments dans le DOM, joindre une capture.
- Un commit par tâche, message descriptif en français, sans mélanger de changements hors périmètre.
- Pas de commentaire qui paraphrase le code ; le pourquoi seulement quand le code seul induirait en erreur.

---

## Vue d'ensemble des tâches

| # | Tâche | Couche |
|---|---|---|
| 1 | Retirer le contre‑avis et `auto_counter_red` (moteur, store, routes, colonnes) | sidecar |
| 2 | Retirer la config de review par conversation et `auto_review` ; config = presets du projet, résolue côté serveur | sidecar |
| 3 | Rescan automatique incrémental quand toutes les corrections d'une review sont terminées | sidecar |
| 4 | Endpoint `GET /api/conversations/:id/diff` = exactement le diff que lit le Gardien | sidecar |
| 5 | `api.ts` + `types.ts` : retirer les fonctions/champs morts, simplifier `startReview` | ui |
| 6 | `DiffViewer` : cartes de signalement ouvertes par défaut, sans contre‑avis, statuts fermés compacts | ui |
| 7 | Nouvelle vue Code : onglets Changements / Historique, calque toujours visible, Relire, Corriger les N ouverts, commit | ui |
| 8 | Ligne Gardien dans le fil (remplace `ConversationReviewPanel`) | ui |
| 9 | Suppression des fichiers morts + CSS mort ; tests UI verts | ui |
| 10 | Docs (`docs/help/gardien.md`, README, CONTEXT.md) | docs |
| 11 | Vérification navigateur de la boucle complète + capture | vérif |

---

### Task 1 : Retirer le contre‑avis et `auto_counter_red`

**Files:**
- Modify: `sidecar/src/reviews.ts` (supprimer `CounterOpinionConfig`, `CounterOpinionDefaults`, `CounterSubtasks` → remplacer par `Pick<SubtaskRunner, "start" | "waitResult">` inline, `counterDefaults`, `startCounterOpinions`, `waitCounter`, `executeCounterBatch`, `executeCounter`, `parseCounterOpinionOutput`, `counterResultError`, `counterOpinionPrompt`, `oppositeProvider` si plus utilisé ; dans `execute()`, retirer le bloc `if (project?.auto_counter_red && this.subtasks)` ; dans `dispatchFlag`/`dispatchAll`, la condition devient `flag.status !== "open"`)
- Modify: `sidecar/src/stores/reviews.ts` (supprimer `queueCounters`, `beginCounter`, `completeCounter`, `failCounter`, `CounterAlreadyRunningError`, `setFlagCodeProvider` ; `setFlagStatus` accepte les 5 statuts restants ; ne plus lire ni écrire les colonnes `counter_*` dans `flagRow`/`create`/`copyFlags`/`complete`)
- Modify: `sidecar/src/db.ts` (ne plus créer les colonnes `counter_*` ni `projects.auto_counter_red` ; ajouter à la migration existante — celle qui fait déjà `dropColumn(db, "review_flags", "decision")` — : `UPDATE review_flags SET status = 'open' WHERE status = 'countered'`, puis `dropColumn` pour `counter_state`, `counter_verdict`, `counter_text`, `counter_provider`, `counter_model`, `counter_effort`, `counter_subtask_id`, `counter_error`, puis `dropColumn(db, "projects", "auto_counter_red")` ; le `CHECK (status IN (...))` de la table `review_flags` créée à neuf ne liste plus `countered` — SQLite ne permet pas de modifier un CHECK existant : laisser la contrainte historique en place sur les bases existantes, elle accepte un sur‑ensemble, c'est sans effet)
- Modify: `sidecar/src/stores/projects.ts` (retirer `auto_counter_red` du type et de `setAutoCounterRed`)
- Modify: `sidecar/src/server.ts` (supprimer les routes `PUT /api/projects/:id/auto-counter-red`, `POST /api/reviews/:id/counter-opinions`, `POST /api/review-flags/:id/counter-opinion` ; dans `PATCH /api/review-flags/:id`, retirer le champ `codeProvider` et l'import `CounterAlreadyRunningError`)
- Modify: `sidecar/src/events.ts` et tout autre fichier qui référence `countered`/`counter_` (`grep -rn "counter" sidecar/src`)
- Test: `sidecar/tests/reviews.test.ts` (supprimer les tests contre‑avis : « re-contre-avis », « l'option projet lance automatiquement les contre-avis rouges », et tout test qui appelle `startCounterOpinions`/`queueCounters`), `sidecar/tests/server.test.ts` (idem pour les routes), `sidecar/tests/db-gardien-residues.test.ts` (ajouter l'assertion que `review_flags` n'a plus de colonne `counter_state` et `projects` plus de `auto_counter_red` — suivre le pattern existant du fichier)

**Step 1 : Repérer toutes les références**

Run: `grep -rn "counter\|auto_counter_red\|oppositeProvider" sidecar/src sidecar/tests | grep -v node_modules | wc -l`
Noter le compte ; il doit tomber à 0 en fin de tâche (hors mot « encounter » éventuel).

**Step 2 : Écrire d'abord le test de migration**

Dans `sidecar/tests/db-gardien-residues.test.ts`, ajouter (en suivant le style des tests existants du fichier, qui ouvrent une base et lisent `PRAGMA table_info`) :

```ts
test("le contre-avis et auto_counter_red ne laissent aucune colonne", () => {
  const db = openTestDb(); // utiliser le helper déjà présent dans ce fichier
  const flagColumns = db.query("PRAGMA table_info(review_flags)").all().map((row: any) => row.name);
  for (const name of ["counter_state", "counter_verdict", "counter_text", "counter_provider", "counter_model", "counter_effort", "counter_subtask_id", "counter_error"]) {
    expect(flagColumns).not.toContain(name);
  }
  const projectColumns = db.query("PRAGMA table_info(projects)").all().map((row: any) => row.name);
  expect(projectColumns).not.toContain("auto_counter_red");
});
```

Run: `cd sidecar && bun test tests/db-gardien-residues.test.ts` → FAIL (les colonnes existent encore).

**Step 3 : Appliquer les suppressions listées dans Files**

Ordre conseillé : `db.ts` → `stores/projects.ts` → `stores/reviews.ts` → `reviews.ts` → `server.ts` → tests. À chaque étape, `bun run typecheck` (dans `sidecar/`) pour suivre les erreurs.

Point d'attention dans `stores/reviews.ts` : la fonction qui hydrate un flag (`flagRow` ou équivalent) construit l'objet `ReviewFlag` avec les champs `counter_*` — les retirer de l'interface `ReviewFlag` (`sidecar/src/stores/reviews.ts` ou `sidecar/src/events.ts`, là où le type est déclaré) et de toutes les requêtes `SELECT`.

**Step 4 : Vérifier**

Run: `cd sidecar && bun run typecheck && bun test`
Expected: tout vert. `grep -rn "counter" sidecar/src` ne remonte plus rien lié au contre‑avis.

**Step 5 : Commit**

```bash
git add -A sidecar
git commit -m "Retirer le contre-avis et auto_counter_red du Gardien

Jamais utilisés (0 contre-avis lancé sur 81 signalements, option projet à 0
partout) : 8 colonnes, 3 routes, un statut et ~300 lignes de moteur en moins."
```

---

### Task 2 : Une seule configuration — les presets du projet

**Files:**
- Modify: `sidecar/src/server.ts`
  - Supprimer la route `PUT /api/conversations/:id/review-config` (vers la ligne 2076) et les helpers `reviewModelConfig`, `reviewSpeed` s'ils n'ont plus d'appelant (garder `reviewModel` : il valide les presets).
  - Supprimer le bloc « rescan automatique au statut `done` d'un tour » (vers les lignes 990‑1040, celui qui lit `conversation.auto_review`) et la map `lastAutoRescanAt` si elle devient inutile.
  - `POST /api/reviews` : n'accepter que `conversationId`, `scope` (`"worktree"` par défaut, ou `"comparison"`), `gitRefBase`, `gitRefHead`, `incremental` (défaut **`true`** pour `worktree`, `false` pour `comparison`). Refuser `reviewProvider`/`reviewModel`/`reviewEffort`/`reviewSpeed`/`presetId`/`codeProvider` par un `400 "configuration de review portée par le projet"` si présents (évite un client qui croirait encore les envoyer). La config vient de `resolveReviewConfig(project, conversation)` :

```ts
function resolveReviewConfig(
  project: { default_review_preset_id: string | null; default_preset_id: string | null },
  conversation: { provider: Provider },
  presets: PresetStore,
): { provider: Provider; model: string; effort: string; speed: "standard" | "fast" } {
  const presetId = project.default_review_preset_id ?? project.default_preset_id;
  const preset = presetId ? presets.get(presetId) : null;
  if (!preset) return { ...defaultReviewConfig(conversation.provider), speed: "standard" };
  return {
    provider: preset.review_provider,
    model: preset.review_model,
    effort: preset.review_effort,
    speed: preset.review_provider === "codex" && preset.speed === "fast" ? "fast" : "standard",
  };
}
```

  - `POST /api/review-flags/:id/dispatch` et `POST /api/reviews/:id/dispatch-all` : ne plus lire `provider/model/effort/speed` du body. La config de correction est résolue côté serveur :

```ts
function resolveCorrectionConfig(
  project: { default_correction_preset_id: string | null },
  conversation: Conversation,
  codeProvider: Provider,
  presets: PresetStore,
): CorrectionAgentConfig {
  const preset = project.default_correction_preset_id ? presets.get(project.default_correction_preset_id) : null;
  if (!preset) return dispatchAgentConfig(conversation, codeProvider);
  return {
    provider: preset.provider,
    model: preset.model,
    effort: preset.effort ?? defaultReviewConfig(preset.provider).effort,
    speed: preset.provider === "codex" ? (preset.speed ?? "standard") : null,
  };
}
```

    et passée à `dispatchFlag(id, message, agentConfig)` / `dispatchAll(reviewId, severities, agentConfig)` (signatures inchangées).
- Modify: `sidecar/src/db.ts` : ne plus créer `conversations.auto_review`, `review_provider`, `review_model`, `review_effort`, `review_speed` ; les `dropColumn` dans la migration résiduelle.
- Modify: `sidecar/src/stores/conversations.ts` : retirer ces champs du type `Conversation`, de `create`, `update`, du `SELECT`, et la méthode qui les écrivait (`setReviewConfig` ou équivalent).
- Modify: `sidecar/src/reviews.ts` : dans `dispatchFlag`, `dispatchAll`, `executeDispatch`, `agentConfig` devient **obligatoire** (le serveur le résout toujours) ; supprimer le fallback `dispatchAgentConfig(conversation, flag.code_provider)` dans `executeDispatch` mais garder la fonction exportée `dispatchAgentConfig` (utilisée par `resolveCorrectionConfig`).
- Test: `sidecar/tests/server.test.ts` (adapter les appels `POST /api/reviews` qui envoyaient un modèle ; ajouter : « POST /api/reviews sans corps de modèle utilise le preset de review du projet » et « un corps avec reviewModel est refusé 400 » ; « dispatch utilise le preset de correction du projet » — vérifier via le fake `SubtaskRunner` déjà utilisé dans ce fichier que le `provider/model` de la sous‑tâche créée est celui du preset), `sidecar/tests/conversations.test.ts` (retirer ce qui teste `auto_review`/`review_*`), `sidecar/tests/db-gardien-residues.test.ts` (ajouter l'assertion sur les colonnes `conversations`).

**Step 1 : Test de migration en premier** (même pattern que Task 1, colonnes `auto_review`, `review_provider`, `review_model`, `review_effort`, `review_speed` absentes de `conversations`). Run → FAIL.

**Step 2 : Tests serveur** : écrire les deux tests `POST /api/reviews` décrits ci‑dessus (chercher dans `server.test.ts` un test existant qui crée projet + preset + conversation, le dupliquer). Run → FAIL.

**Step 3 : Implémenter** dans l'ordre `db.ts` → `stores/conversations.ts` → `reviews.ts` → `server.ts`.

**Step 4 : Vérifier** : `cd sidecar && bun run typecheck && bun test` → vert.

**Step 5 : Commit**

```bash
git add -A sidecar
git commit -m "Gardien : une seule configuration, les presets du projet

Plus de modèle de review par conversation ni d'override par appel : le
serveur résout le preset de review et le preset de correction du projet.
Le rescan automatique par tour disparaît (jamais activé) au profit du
rescan après correction (tâche suivante)."
```

---

### Task 3 : Rescan automatique quand les corrections sont finies

**Files:**
- Modify: `sidecar/src/reviews.ts`
- Test: `sidecar/tests/reviews.test.ts`

**Comportement :** quand la dernière sous‑tâche de correction d'une review se termine (succès ou échec), si aucune review ne tourne déjà sur le projet, le runner démarre une review `worktree` **incrémentale** sur la même conversation avec la même config (`review_provider/model/effort/speed`, `code_provider`) que la review parente. Ainsi les hunks corrigés sont rescannés et les signalements dispatchés dont le hunk a changé passent `resolved` (mécanique déjà en place dans `execute()`).

**Step 1 : Test**

Dans `reviews.test.ts`, à côté de « un dispatch terminé passe en traité jusqu'au prochain scan » (ligne ~1230, qui montre comment construire runner + fake subtasks + fake scanner), ajouter :

```ts
test("la fin de la dernière correction relance une review incrémentale", async () => {
  // même mise en place que le test précédent : review done avec 2 flags open,
  // fake SubtaskRunner dont waitResult résout { status: "done" }.
  runner.dispatchAll(review.id, ["red", "orange"], config);
  await Bun.sleep(50); // laisser les deux dispatches finir
  const reviews = runner.listByProject(project.id);
  expect(reviews.length).toBe(2);
  const rescan = reviews.find((item) => item.id !== review.id)!;
  expect(rescan.parent_review_id).toBe(review.id);
  expect(rescan.scope).toBe("worktree");
  expect(rescan.review_model).toBe(review.review_model);
});

test("une correction isolée ne relance qu'une fois tous les dispatches finis", async () => {
  // dispatchFlag sur flag A puis flag B ; tant que B tourne, aucune nouvelle review.
});
```

Run: `cd sidecar && bun test tests/reviews.test.ts -t "relance"` → FAIL.

**Step 2 : Implémenter**

Dans `ReviewRunner` :

```ts
private pendingDispatches = new Map<string, number>(); // reviewId → corrections en vol

private trackDispatch(reviewId: string, delta: number): number {
  const next = (this.pendingDispatches.get(reviewId) ?? 0) + delta;
  if (next <= 0) this.pendingDispatches.delete(reviewId); else this.pendingDispatches.set(reviewId, next);
  return next;
}
```

- `dispatchFlag` : `this.trackDispatch(review.id, 1)` avant de lancer `executeDispatch`.
- `dispatchAll` : `this.trackDispatch(review.id, flags.length)` **avant** la boucle (sinon la première fournée finie déclencherait le rescan alors que la suivante n'a pas commencé).
- `executeDispatch` : dans un `finally`, `if (this.trackDispatch(review.id, -1) === 0) this.rescanAfterCorrections(review)`.

```ts
private rescanAfterCorrections(review: Review): void {
  const runningHere = [...this.progress.values()].some((item) => item.projectId === review.project_id);
  if (runningHere) return;
  try {
    this.start({
      projectId: review.project_id,
      conversationId: review.conversation_id,
      gitRefBase: CONVERSATION_BASE_REF,
      gitRefHead: WORKTREE_HEAD_REF,
      provider: review.review_provider,
      model: review.review_model,
      effort: review.review_effort,
      speed: review.review_speed,
      codeProvider: review.code_provider,
      scope: "worktree",
      incremental: true,
    });
  } catch (error) {
    console.error("Rescan après corrections impossible", error);
  }
}
```

Attention : `start()` lève si la conversation a disparu — d'où le `try`.

**Step 3 : Vérifier** : `cd sidecar && bun test` → vert.

**Step 4 : Commit** : `git commit -am "Gardien : relire automatiquement le diff quand les corrections sont terminées"`

---

### Task 4 : `GET /api/conversations/:id/diff` — le diff que lit le Gardien

**Files:**
- Modify: `sidecar/src/reviews.ts` : rendre publique une méthode

```ts
async conversationDiff(conversationId: string): Promise<{ base: string; head: string; diff: string }> {
  const conversation = this.conversations.get(conversationId);
  if (!conversation) throw new Error("conversation inconnue");
  const project = this.projects.get(conversation.project_id);
  if (!project) throw new Error("projet inconnu");
  const maxBytes = positiveEnv("PUPITRE_REVIEW_DIFF_MAX_BYTES", DEFAULT_DIFF_MAX_BYTES);
  return this.captureWorktree(conversationCwd(project, conversation), {
    projectId: project.id, conversationId, gitRefBase: CONVERSATION_BASE_REF, gitRefHead: WORKTREE_HEAD_REF,
  } as StartReviewInput, maxBytes);
}
```

  (si `captureWorktree` n'utilise de `input` que `gitRefBase`, `projectId`, `conversationId`, réduire son type de paramètre à `Pick<StartReviewInput, ...>` plutôt que caster).
- Modify: `sidecar/src/server.ts` : route `GET /api/conversations/:id/diff` → `json(await deps.reviews.conversationDiff(id))`, `404` si conversation inconnue, `400` si le message d'erreur contient « trop volumineux » ou « HEAD a changé ».
- Test: `sidecar/tests/server.test.ts` : « GET /api/conversations/:id/diff rend le même diff que la review worktree » (créer un dépôt temporaire comme le font les tests de `reviews.test.ts` — chercher `mkdtempSync` — écrire un fichier, appeler la route, comparer `diff` avec `review.diff_text` d'une review lancée juste après avec un scanner factice qui rend `{"flags":[]}`).

**Steps :** test → FAIL → implémenter → `bun test` vert → commit `"Exposer le diff de conversation tel que le Gardien le lit"`.

**Après cette tâche, recharger le sidecar** (les tâches UI en dépendent) : vérifier qu'aucun tour ne tourne (`curl -s localhost:4820/api/fleet`), puis `pkill -f "sidecar/src/index.ts"` ; attendre 3 s ; `curl -s localhost:4820/api/health` → `{"ok":true}`.

---

### Task 5 : `api.ts` et `types.ts`

**Files:**
- Modify: `ui/src/api.ts`
  - Supprimer : `setConversationReviewConfig`, `setReviewFlagCodeProvider`, `setProjectAutoCounterRed`, `startFlagCounterOpinion`, `startReviewCounterOpinions`, `listProjectWorktrees`, `removeProjectWorktree` (vérifier avec `grep -rn` qu'aucun composant ne les appelle après les tâches 7‑9 ; sinon les traiter là), `getProjectGitFile`.
  - `startReview(input: { conversationId: string; scope?: 'worktree' | 'comparison'; gitRefBase?: string; gitRefHead?: string; incremental?: boolean })`.
  - `dispatchFlag(flagId, message?)` et `dispatchAllFlags(reviewId, severities?)` sans paramètre de config.
  - Ajouter `getConversationDiff(conversationId, signal?): Promise<{ base: string; head: string; diff: string }>` → `GET /api/conversations/:id/diff`.
- Modify: `ui/src/types.ts` : `ReviewFlagStatus = 'open' | 'agent_running' | 'treated' | 'ignored' | 'resolved'` ; supprimer `CounterState`, `CounterVerdict` et les champs `counter_*` de `ReviewFlag` ; supprimer `auto_review`, `review_provider`, `review_model`, `review_effort`, `review_speed` de `Conversation` ; supprimer `auto_counter_red` de `Project`.

**Step 1 :** appliquer. **Step 2 :** `cd ui && bunx tsc --noEmit` — les erreurs restantes listent exactement les composants à traiter dans les tâches 6‑9 ; les noter, ne pas les corriger ici sauf s'il s'agit d'un usage trivial. **Step 3 :** pas de commit isolé si `tsc` est rouge — cette tâche est committée avec la tâche 9. (Alternative acceptable : committer quand même avec le message « wip » interdit — donc non : attendre.)

---

### Task 6 : `DiffViewer` — la raison et les actions, visibles

**Files:**
- Modify: `ui/src/DiffViewer.tsx`
- Modify: `ui/src/reviewDiff.ts` (aucun changement attendu ; `parseUnifiedDiff` reste)
- Test: `sidecar/tests/ui-review-diff.test.ts` (les helpers purs de l'UI y sont testés — y ajouter si un helper pur est extrait, sinon rien)

**Changements :**
1. Props : `{ diff: string; flags?: ReviewFlag[]; label: string; selectedFlagId?: string | null; onFlagUpdated?: (flag: ReviewFlag) => void }` — plus de `correction`.
2. `FlagCard` : retirer `requestCounterOpinion`, le bouton « Contre‑avis », l'affichage `counter_text`, l'import `startFlagCounterOpinion`. `sendAgent` appelle `dispatchFlag(flag.id, message.trim() || undefined)`. Le `SubtaskCard` reste (il montre la correction en cours). Le libellé de la carte pendant `agent_running` : « Correction en cours… » (le modèle est décidé par le projet, on ne le connaît pas ici : ne rien afficher de faux).
3. **Cartes ouvertes par défaut** : dans `DiffViewer`, l'état devient `collapsed: Set<string>` (ids repliés) au lieu de `expandedFlagId`. Une carte est visible si `flag.status === 'open' || flag.status === 'agent_running'` et non repliée, **ou** si son id est `selectedFlagId`, **ou** si l'utilisateur l'a dépliée (`expanded: Set<string>` pour les fermées). Cliquer la ligne teintée bascule le pli. Pour les statuts fermés (`treated`/`ignored`/`resolved`), rendre à la place de la carte une ligne compacte `div.diff-flag-closed` : `✓ traité · <message tronqué à 90 caractères>` (ou « ignoré », « résolu par relecture »), cliquable pour déplier la carte complète (sans actions).
4. Un compteur en haut du composant n'est pas nécessaire ; c'est la vue Code qui l'affiche.

**Step 1 :** appliquer. **Step 2 :** `bunx tsc --noEmit` — plus d'erreur dans `DiffViewer.tsx`. Commit groupé avec la tâche 9.

---

### Task 7 : La vue Code, réécrite

**Files:**
- Rewrite: `ui/src/GitView.tsx` (garder le nom du fichier et l'export `GitView` pour ne pas toucher au routage d'`App.tsx`)
- Modify: `ui/src/App.tsx` : props passées à `GitView` → `{ project, conversation, focusedFlagId, reviewStatus, onConversationBack }` (retirer `quotas`, `focusedReviewId`, `onConversationSelect`, `onReviewSelected` et l'état `focusedReviewId` s'il ne sert plus qu'à ça ; `handleGitSelect(flagId?)` reste ; `startWorktreeReview` et l'action palette `review` appellent `startReview({ conversationId, scope: 'worktree' })` puis `handleGitSelect()`).
- Modify: `ui/src/styles/git.css` et `ui/src/styles/diff.css` (les classes `code-*` qui disparaissent doivent être retirées — le test `deadCss.test.ts` échoue sinon).
- Reuse: `ui/src/reviewFileTree.ts` (`buildFileTree(diff, flags)` donne la liste des fichiers avec pastilles), `ui/src/reviewStatus.ts` (`isScanRunning`), `ui/src/DiffViewer.tsx`, `ui/src/SurfaceSwitch.tsx`.

**Structure cible (un seul composant de ~150 lignes normalement formatées, pas de lignes de 1 000 caractères) :**

```
<div class="git-workspace code-workspace">
  <header class="code-header">  titre conversation · branche · <SurfaceSwitch/>  </header>
  <nav class="code-tabs">  [Changements (N fichiers · R rouges / O orange)]  [Historique (M commits)]  </nav>
  {tab === 'changes' ? <ChangesTab/> : <HistoryTab/>}
</div>
```

**`ChangesTab`** — état : `live` (`getConversationDiff`), `review` (dernière review `scope === 'worktree'` de cette conversation, via `listProjectReviews` filtré), `busy`, `error`, `commitMessage`, `filter: 'open' | 'all'`, `selectedFile: string | null`.
- Chargement : au montage et **quand `reviewStatus.running` passe de non‑null à null** (fin de scan poussée par le WS Fleet — c'est ce qui remplace tout polling), recharger `live` et `review`. Un seul `setInterval` toléré : 2 s, **uniquement** tant que `review.flags.some(status === 'agent_running')` (les sous‑tâches ne sont pas poussées par le canal Fleet review).
- Diff affiché : `review?.diff_text ?? live.diff` — le diff gelé de la review garantit que les ancres sont justes. Bandeau au‑dessus si `review && live && review.diff_text !== live.diff` : « Le worktree a changé depuis la relecture — Relire ». Si `!review` : « Pas encore relu — Relire ».
- Colonne gauche : `buildFileTree(diffAffiché, flags)` → liste cliquable (fichier + pastilles rouge/orange/gris ouvertes) ; « Tous les fichiers » en tête ; cliquer un fichier restreint le `DiffViewer` à ce fichier (réutiliser la fonction `diffForPath` de l'ancien `GitView` — la déplacer dans `reviewDiff.ts` avec un test dans `sidecar/tests/ui-review-diff.test.ts`).
- Barre d'en‑tête du diff : « Relire » (→ `startReview({ conversationId, scope: 'worktree' })`, désactivé si `isScanRunning(reviewStatus)` ; affiche « zone n/m » pendant le scan), « Corriger les N ouverts » (→ `dispatchAllFlags(review.id, ['red','orange','grey'])` après `window.confirm`), filtre Ouverts / Tous (le filtre « Ouverts » ne passe au `DiffViewer` que les flags `open`/`agent_running`).
- Bas de colonne gauche : `input` message + bouton « Committer » (→ `commitProjectGit(project.id, { conversationId, paths: <tous les fichiers du diff live>, message })`, puis recharger). Pas de cases à cocher, pas de « committer et faire relire ».
- `DiffViewer` reçoit `flags = review?.flags ?? []`, `selectedFlagId = focusedFlagId`, `onFlagUpdated` met à jour `review` localement.

**`HistoryTab`** — reprend `CommitList` (existant, avec le bouclier « relu / non relu » et « Faire relire ») et, pour le commit sélectionné, un `DiffViewer` sur `review.diff_text` de la review `comparison` liée à ce commit si elle existe (`reviews.find(r => r.scope === 'comparison' && r.git_ref_head === commit.sha)`) sinon `getProjectGitDiff(project.id, parent, sha)`. « Faire relire » → `startReview({ conversationId, scope: 'comparison', gitRefBase: commit.parents[0] ?? \`${commit.sha}^\`, gitRefHead: commit.sha })`. Pas de sélecteur de modèle.

**Supprimé de l'ancien fichier :** scopes `tree`/`master`/`branches`, `ViewMode`, `RefPicker`, `FileTree`, `QuickOpen`, `CodeFilePanel`, `CodeRail`, `DirtyFileList`, `CommitBar` à cases, raccourcis clavier globaux (`⌘P`, `⇧⌘F`, `⌘1`, `⌘2`), `ReviewConfigSelector`, `CorrectionConfigSelector`, `readCorrectionSelection`, `presets`.

**Étapes :** 1) écrire le test de `diffForPath` dans `sidecar/tests/ui-review-diff.test.ts` → FAIL → déplacer la fonction → PASS. 2) Réécrire `GitView.tsx`. 3) Adapter `App.tsx`. 4) `bunx tsc --noEmit` propre pour ces fichiers. Commit groupé avec la tâche 9.

---

### Task 8 : La ligne Gardien dans le fil

**Files:**
- Create: `ui/src/GuardianLine.tsx`
- Modify: `ui/src/Chat.tsx` (remplacer `<ConversationReviewPanel …/>` par `<GuardianLine conversation project reviewStatus onOpenCode onRelire />` ; retirer `launchRequest`/`reviewLaunchRequest` si son seul usage était le panneau — sinon garder et le brancher sur `onRelire`)
- Delete: `ui/src/ConversationReviewPanel.tsx`, `ui/src/GuardianSettingsPopover.tsx`
- Modify: `ui/src/styles/chat.css` (les classes `guardian-*` de l'ancien panneau : ne garder que celles que `GuardianLine` utilise)

**`GuardianLine`** (~70 lignes) : une seule ligne.

```
[bouclier]  Gardien   <état>                                   [Relire] [Ouvrir le code]
```

- `<état>` : si `isScanRunning(reviewStatus)` → « relit · zone n/m » ; sinon depuis la dernière review `worktree` de la conversation (chargée une fois au montage et rechargée quand `reviewStatus.running` passe à null) : `error` → « relecture interrompue » ; `done` avec ouverts → « 2 rouges · 3 orange · 1 gris » (n'afficher que les non nuls) ; `done` sans ouverts → « rien à signaler » ; pas de review → « pas encore relu ».
- « Relire » → `startReview({ conversationId, scope: 'worktree' })` (désactivé pendant un scan). « Ouvrir le code » → `onOpenCode()`.
- Aucun `setInterval`. Aucune liste de signalements (elle vit dans la vue Code).

Commit groupé avec la tâche 9.

---

### Task 9 : Nettoyage, tests UI verts, commit UI

**Files:**
- Delete: `ui/src/CounterOpinionDialog.tsx`, `ui/src/ReviewConfigSelector.tsx`, `ui/src/ReviewConfigSelector.test.ts`, `ui/src/CorrectionConfigSelector.tsx`, `ui/src/correctionConfig.ts`, `ui/src/correctionConfig.test.ts`, `ui/src/reviewLaunch.ts` (si plus utilisé — vérifier `sidecar/tests/ui-review-launch.test.ts` et le supprimer avec), `ui/src/gitGraph.ts` + `sidecar/tests/ui-git-graph.test.ts` (le graphe n'était plus rendu depuis la vue Code du 16 août ; s'il l'est de nouveau dans `HistoryTab`, garder), `ui/src/worktrees.ts` si plus importé.
- Modify: `ui/src/ConfigPanel.tsx` : ce fichier importe `worktrees.ts` — vérifier ce qu'il en fait ; s'il s'agit du choix de branche à la création (ADR 0001), **garder** `worktrees.ts`.
- Modify: `ui/src/ProjectSettingsDialog.tsx` : garder tel quel (presets de review et de correction : c'est LA config). Retirer un éventuel toggle `auto_counter_red`.
- Modify: `ui/src/styles/*.css` : retirer les classes mortes jusqu'à ce que `deadCss.test.ts` passe.
- Modify: `ui/src/CommandPalette.tsx` : l'action `review` garde son libellé « Relire le diff ».

**Steps :**
1. `cd ui && bunx tsc --noEmit` → 0 erreur.
2. `cd ui && bun test` → vert (dont `deadCss.test.ts`, `Sidebar.test.ts`).
3. `cd sidecar && bun test` → vert (les tests `ui-*` y vivent).
4. `cd ui && bun run build` → OK.
5. Commit :

```bash
git add -A ui sidecar/tests
git commit -m "Vue Code : une boucle Gardien lisible — diff, raison, correction, relecture

Deux onglets (Changements, Historique), signalements ouverts affichés inline
avec leurs actions, Relire incrémental, ligne d'état unique dans le fil.
Disparaissent : explorateur de fichiers, quick-open, lecture à une ref,
sélecteurs de modèle dans les vues, panneau Gardien du fil, contre-avis."
```

---

### Task 10 : Docs

**Files:**
- Modify: `docs/help/gardien.md` — réécrire (≤ 25 lignes) : la boucle en 4 phrases (Relire → signalements inline dans Code › Changements → Corriger / OK vu / Ignorer → relecture automatique après corrections, incrémentale) ; où se règle le modèle (Réglages du projet › preset de review / preset de correction) ; les trois sévérités (texte actuel à garder).
- Modify: `README.md` — section « Contrôle des changements (M3) », puce Gardien : retirer contre‑avis et « signalements rouges peuvent recevoir automatiquement un contre‑avis » ; ajouter la relecture automatique après corrections ; puce Git : « Historique des commits avec review par commit ».
- Modify: `CONTEXT.md` — entrée **Contre‑avis** : la retirer ; entrée **Atelier Git** : décrire les deux onglets ; entrée **Carte de review** : préciser qu'il n'y a plus de triage dans le fil (ligne d'état seulement).
- Modify: `docs/help/*.md` : `grep -rln "contre-avis\|Contre-avis" docs README.md CONTEXT.md` et corriger chaque occurrence.

Commit : `"Docs : Gardien en boucle simple, sans contre-avis"`.

---

### Task 11 : Vérification dans le navigateur (obligatoire — CLAUDE.md)

Prérequis : sidecar rechargé (voir fin de la tâche 4 ; le refaire si des changements backend sont intervenus depuis), Vite sur `http://localhost:5173`.

Avec Claude in Chrome (`ToolSearch "select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__tabs_close_mcp"`) :

1. Ouvrir `http://localhost:5173`, sélectionner le projet **pupitre**, puis une conversation qui possède une review `worktree` terminée avec des signalements ouverts (la base en contient : chercher dans la sidebar la conversation la plus récente ; sinon lancer « Relire » sur une conversation avec un diff non vide — un scan Luna prend ~1 min).
2. Dans le fil : la ligne Gardien affiche l'état et les deux boutons. **Mesurer dans le DOM** (`javascript_tool`) : `document.querySelectorAll('.guardian-line').length === 1`, aucun `.guardian-findings`.
3. Cliquer « Ouvrir le code » : onglet Changements. Mesurer : `document.querySelectorAll('.diff-flag-card').length` ≥ 1 et égal au nombre de signalements `open`/`agent_running` de la review (comparer avec `curl -s localhost:4820/api/reviews/<id> | jq '[.flags[]|select(.status=="open" or .status=="agent_running")]|length'`) ; chaque carte contient un `p.diff-flag-message` non vide et les boutons « Corriger », « OK, vu », « Ignorer » ; **aucun** bouton « Contre‑avis » dans la page.
4. Cliquer « OK, vu » sur un signalement : la carte devient une ligne compacte `.diff-flag-closed` ; le compteur de l'onglet décrémente ; recharger la page : le statut persiste.
5. Cliquer « Corriger » sur un signalement : la carte passe en « Correction en cours… » avec la `SubtaskCard` ; attendre la fin (≤ 3 min avec Luna fast) ; vérifier ensuite qu'une nouvelle review apparaît (`curl -s localhost:4820/api/projects/<id>/reviews | jq '.[0].parent_review_id'` non null) et que la vue se met à jour sans rechargement.
6. Onglet Historique : la liste des commits s'affiche ; « Faire relire » sur un commit lance un scan et le diff annoté apparaît.
7. Prendre une capture de l'onglet Changements avec au moins une carte ouverte (`computer` `screenshot` avec `save_to_disk: true`) et la joindre au rapport final.

Si un point échoue : corriger, re‑tester, puis un commit `fix:` dédié.

---

## Vérification finale

```bash
cd sidecar && bun run typecheck && bun test
cd ui && bunx tsc --noEmit && bun test && bun run build
git status --short   # vide
git log --oneline -8
```

Rapport attendu du sous‑agent : liste des commits, sortie des suites de tests (nombre de tests), chemin de la capture, et tout écart au plan avec sa raison.

# Fiabilisation du calque Git / Gardien — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Corriger les quatre bugs confirmés du calque Git (rattachement du dispatch, bouton bloqué, carte répétée, graphe jamais dessiné), purger les résidus de l'ancien mode Gardien, et aligner l'UI et les docs sur le glossaire (`CONTEXT.md`).

**Architecture:** Aucun nouveau concept. Suppression de code mort (`linkedConversationId`, colonnes `decision`/`gardien_mode`), corrections locales dans `GitView.tsx`/`DiffViewer.tsx`/`reviewDiff.ts`, branchement du rendu SVG sur `layoutGitGraph` déjà écrit, textes UI et docs mis à jour.

**Tech Stack:** React 19 + TypeScript (ui/), Bun + SQLite (sidecar/). Tests : `bun test` dans `sidecar/` (les helpers purs de l'UI y sont testés — voir `sidecar/tests/ui-review-diff.test.ts`).

**Contraintes du dépôt (CLAUDE.md) :** ne jamais lancer `dev:sidecar` depuis une conversation Pupitre ; tout se vérifie par `bun test` dans `sidecar/`. Un changement backend (tâches 1 et 5) exige un redémarrage du sidecar pour être actif — à signaler dans le TODO final.

**Décisions de référence :** `CONTEXT.md` (glossaire : signalement vs zone, sévérité red-flag), `docs/adr/0001-worktree-par-conversation.md`, décision D2 (dispatch rattaché à `review.conversation_id`).

---

### Task 1: Rattacher le dispatch à la conversation de la review (supprimer `linkedConversationId`)

`linkedConversationId` est doublement cassé (regex à un seul groupe lu via `match[2]`, et hash de *blob* joints sur des SHA de commit) : il retourne toujours `null` et tout retombe déjà de fait sur `review.conversation_id`. Décision D2 : on assume ce comportement et on supprime le code mort.

**Files:**
- Modify: `sidecar/src/stores/reviews.ts:164-178` (méthode `linkedConversationId`)
- Modify: `sidecar/src/reviews.ts:198-199` et `:218-219` (les deux call sites)
- Test: `sidecar/tests/reviews.test.ts`

**Step 1: Vérifier les usages existants**

Run: `grep -rn "linkedConversationId" sidecar/ ui/`
Expected: uniquement `sidecar/src/stores/reviews.ts` (définition) et `sidecar/src/reviews.ts` (2 call sites). Si un test l'utilise, il sera adapté à l'étape 2.

**Step 2: Écrire le test du comportement cible**

Dans `sidecar/tests/reviews.test.ts`, ajouter (en réutilisant les helpers de setup du fichier — lis d'abord comment les tests existants construisent `ReviewRunner`/store/subtasks factices) :

```ts
test("dispatchFlag rattache la sous-tâche à la conversation de la review", () => {
  // setup identique aux tests de dispatch existants du fichier :
  // une review créée sur conversationId "conv-review", un flag open.
  // Espionner subtasks.start et vérifier :
  const call = subtaskStartCalls.at(-1);
  expect(call?.conversationId).toBe("conv-review");
});
```

S'il existe déjà un test de dispatch qui asserte le `conversationId`, le mettre à jour plutôt qu'en créer un second (DRY).

**Step 3: Lancer le test**

Run: `cd sidecar && bun test tests/reviews.test.ts`
Expected: PASS si le test asserte le fallback (déjà effectif), ou FAIL si le setup simulait `commit_links` — dans ce cas c'est le comportement mort qu'on supprime.

**Step 4: Supprimer le code mort**

Dans `sidecar/src/stores/reviews.ts`, supprimer entièrement la méthode `linkedConversationId` (lignes 164-178, y compris son commentaire JSDoc).

Dans `sidecar/src/reviews.ts`, remplacer dans `dispatchFlag` :

```ts
const conversationId = this.store.linkedConversationId(review.project_id, review.diff_text)
  ?? review.conversation_id;
```

par :

```ts
const conversationId = review.conversation_id;
```

et dans `dispatchAll` :

```ts
const targetConversation = this.store.linkedConversationId(review.project_id, review.diff_text)
  ?? review.conversation_id;
```

par :

```ts
const targetConversation = review.conversation_id;
```

**Step 5: Vérifier**

Run: `cd sidecar && bun test`
Expected: tout PASS, plus aucune occurrence : `grep -rn "linkedConversationId" sidecar/ ui/` ne retourne rien.

**Step 6: Commit**

```bash
git add sidecar/src/stores/reviews.ts sidecar/src/reviews.ts sidecar/tests/reviews.test.ts
git commit -m "Rattacher le dispatch à la conversation de la review

linkedConversationId retournait toujours null (regex à un seul groupe
lu via match[2], hash de blob joints sur des SHA de commit) : le
fallback était déjà le comportement réel. Décision D2 : on l'assume."
```

---

### Task 2: Corriger la logique « scan en cours » (`running !== null`)

`reviewStatus` peut être `null`/`undefined` tant qu'aucun push WS n'est arrivé ; `reviewStatus?.running !== null` vaut alors `true` (`undefined !== null`), ce qui désactive « Relire ce diff » et fausse `wasScanning`.

**Files:**
- Create: `ui/src/reviewStatus.ts`
- Test: `sidecar/tests/ui-review-status.test.ts`
- Modify: `ui/src/GitView.tsx:68,159`

**Step 1: Écrire le test du helper**

Créer `sidecar/tests/ui-review-status.test.ts` (même pattern d'import que `ui-review-diff.test.ts`, qui importe depuis `../../ui/src/`) :

```ts
import { describe, expect, test } from "bun:test";
import { isScanRunning } from "../../ui/src/reviewStatus";

describe("isScanRunning", () => {
  test("false quand le statut n'est pas encore connu", () => {
    expect(isScanRunning(null)).toBe(false);
    expect(isScanRunning(undefined)).toBe(false);
  });

  test("false quand aucun scan ne tourne", () => {
    expect(isScanRunning({ running: null, openBySeverity: { red: 0, orange: 0, grey: 0 } })).toBe(false);
  });

  test("true quand un scan tourne", () => {
    expect(isScanRunning({
      running: { reviewId: "r1", zoneDone: 1, zoneTotal: 3 },
      openBySeverity: { red: 0, orange: 0, grey: 0 },
    })).toBe(true);
  });
});
```

Note : vérifie la forme exacte de `ReviewStatusSnapshot` dans `ui/src/types.ts:404` et ajuste `openBySeverity` si le champ diffère.

**Step 2: Lancer le test**

Run: `cd sidecar && bun test tests/ui-review-status.test.ts`
Expected: FAIL — `reviewStatus.ts` n'existe pas.

**Step 3: Implémenter le helper**

Créer `ui/src/reviewStatus.ts` :

```ts
import type { ReviewStatusSnapshot } from './types'

/** Un scan tourne seulement si un statut est connu ET porte un run. */
export function isScanRunning(status: ReviewStatusSnapshot | null | undefined): boolean {
  return status?.running != null
}
```

**Step 4: Lancer le test**

Run: `cd sidecar && bun test tests/ui-review-status.test.ts`
Expected: PASS

**Step 5: Brancher dans GitView**

Dans `ui/src/GitView.tsx` :

- ajouter l'import : `import { isScanRunning } from './reviewStatus'`
- ligne 68 : `const scanning = reviewStatus?.running !== null` → `const scanning = isScanRunning(reviewStatus)`
- ligne 159 : `disabled={!conversation || isReviewing || reviewStatus?.running !== null}` → `disabled={!conversation || isReviewing || isScanRunning(reviewStatus)}`

**Step 6: Vérifier et committer**

Run: `cd sidecar && bun test && cd ../ui && bunx tsc --noEmit`
Expected: PASS des tests, zéro erreur TypeScript.

```bash
git add ui/src/reviewStatus.ts ui/src/GitView.tsx sidecar/tests/ui-review-status.test.ts
git commit -m "Ne plus désactiver « Relire ce diff » quand le statut est inconnu

running !== null valait true pour un statut null/undefined : bouton
bloqué avant le premier push WS, et wasScanning faussé au montage."
```

---

### Task 3: Ancrer la carte de signalement sur une seule ligne

`DiffViewer.tsx:112` rend la carte sous **chaque** ligne du range `line_start–line_end` (côtés ancien et nouveau). On introduit `cardFlags` dans `parseUnifiedDiff` : chaque flag n'est porteur de carte que sur la **dernière** ligne du diff qui le matche.

**Files:**
- Modify: `ui/src/reviewDiff.ts`
- Modify: `ui/src/DiffViewer.tsx:112`
- Test: `sidecar/tests/ui-review-diff.test.ts`

**Step 1: Écrire le test**

Lire d'abord `sidecar/tests/ui-review-diff.test.ts` pour réutiliser ses fixtures de diff et de flags. Ajouter :

```ts
test("un flag multi-lignes n'est porteur de carte que sur sa dernière ligne", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " contexte",
    "+ligne un",
    "+ligne deux",
  ].join("\n");
  const flag = makeFlag({ file: "src/a.ts", line_start: 2, line_end: 3 });
  const lines = parseUnifiedDiff(diff, [flag]);
  const carriers = lines.filter((line) => line.cardFlags.length > 0);
  expect(carriers).toHaveLength(1);
  expect(carriers[0]?.text).toBe("+ligne deux");
  // le surlignage, lui, reste sur toutes les lignes du range :
  expect(lines.filter((line) => line.flags.length > 0)).toHaveLength(2);
});
```

(`makeFlag` : réutiliser ou créer un petit constructeur de fixture conforme à `ReviewFlag`.)

**Step 2: Lancer le test**

Run: `cd sidecar && bun test tests/ui-review-diff.test.ts`
Expected: FAIL — `cardFlags` n'existe pas sur `DiffLine`.

**Step 3: Implémenter**

Dans `ui/src/reviewDiff.ts` :

1. Ajouter au type `DiffLine` :

```ts
export interface DiffLine {
  kind: DiffLineKind
  text: string
  file: string | null
  oldLine: number | null
  newLine: number | null
  flags: ReviewFlag[]
  /** Flags dont cette ligne est l'ancre de carte (dernière ligne du range). */
  cardFlags: ReviewFlag[]
  severity: ReviewSeverity | null
}
```

2. Dans `parseUnifiedDiff`, initialiser `cardFlags: []` dans l'objet retourné par le `.map()`, puis ajouter une post-passe avant le `return` final :

```ts
export function parseUnifiedDiff(diff: string, flags: ReviewFlag[]): DiffLine[] {
  // ... boucle existante, avec cardFlags: [] dans chaque ligne ...
  const lines = diff.split('\n').map(/* ... existant ... */)

  for (const flag of flags) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].flags.includes(flag)) {
        lines[index].cardFlags.push(flag)
        break
      }
    }
  }
  return lines
}
```

(Restructurer le `return diff.split(...)` existant en variable `lines` + post-passe + `return lines`.)

3. Dans `ui/src/DiffViewer.tsx` ligne 112, remplacer :

```tsx
{row.line.flags.filter((flag) => flag.id === activeFlagId).map((flag) => ...)}
```

par :

```tsx
{row.line.cardFlags.filter((flag) => flag.id === activeFlagId).map((flag) => ...)}
```

(le reste du JSX de la ligne est inchangé — seuls les porteurs de carte changent ; les marqueurs de la ligne 110 continuent d'utiliser `row.line.flags` pour surligner tout le range).

**Step 4: Vérifier et committer**

Run: `cd sidecar && bun test && cd ../ui && bunx tsc --noEmit`
Expected: PASS partout.

```bash
git add ui/src/reviewDiff.ts ui/src/DiffViewer.tsx sidecar/tests/ui-review-diff.test.ts
git commit -m "Ancrer la carte de signalement sur la dernière ligne de son range

La carte était rendue sous chaque ligne matchée (anciens et nouveaux
numéros), donc dupliquée à l'écran pour tout signalement multi-lignes."
```

---

### Task 4: Dessiner le graphe de commits

`layoutGitGraph` (`ui/src/gitGraph.ts:48-83`) calcule lanes et segments mais `GitView.tsx:167` n'affiche que `row.commit`. On ajoute un helper de géométrie pur (testable) et une cellule SVG par ligne de commit.

**Files:**
- Modify: `ui/src/gitGraph.ts` (ajout `gitGraphCellGeometry`)
- Modify: `ui/src/GitView.tsx:167`
- Modify: `ui/src/styles/git.css`
- Test: `sidecar/tests/ui-git-graph.test.ts`

**Step 1: Écrire le test de géométrie**

Créer `sidecar/tests/ui-git-graph.test.ts` :

```ts
import { describe, expect, test } from "bun:test";
import { gitGraphCellGeometry, layoutGitGraph } from "../../ui/src/gitGraph";
import type { GitCommit } from "../../ui/src/types";

function commit(sha: string, parents: string[]): GitCommit {
  return { sha, parents, subject: sha, conversations: [], guardian: [] } as unknown as GitCommit;
}

describe("gitGraphCellGeometry", () => {
  test("place le point au centre de sa lane", () => {
    const [row] = layoutGitGraph([commit("a", ["b"]), commit("b", [])]);
    const geometry = gitGraphCellGeometry(row);
    expect(geometry.dot).toEqual({ x: 7, y: 22 });   // lane 0, laneWidth 14, height 44
    expect(geometry.width).toBe(14);                  // 1 lane
  });

  test("trace un segment vers chaque parent", () => {
    const rows = layoutGitGraph([
      commit("m", ["a", "b"]),   // merge : deux parents
      commit("a", []),
      commit("b", []),
    ]);
    const geometry = gitGraphCellGeometry(rows[0]);
    expect(geometry.paths.filter((path) => path.kind === "parent")).toHaveLength(2);
    for (const path of geometry.paths) expect(path.d.startsWith("M ")).toBe(true);
  });
});
```

Vérifie la forme réelle de `GitCommit` dans `ui/src/types.ts` et ajuste la fixture (le cast `as unknown as GitCommit` couvre les champs non pertinents pour le layout).

**Step 2: Lancer le test**

Run: `cd sidecar && bun test tests/ui-git-graph.test.ts`
Expected: FAIL — `gitGraphCellGeometry` n'existe pas.

**Step 3: Implémenter la géométrie**

Ajouter à `ui/src/gitGraph.ts` :

```ts
export interface GitGraphCellGeometry {
  width: number
  height: number
  dot: { x: number, y: number }
  paths: Array<{ d: string, kind: 'continuation' | 'parent' }>
}

const LANE_WIDTH = 14
const ROW_HEIGHT = 44

export function gitGraphCellGeometry(row: GitGraphRow): GitGraphCellGeometry {
  const x = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2
  const height = ROW_HEIGHT
  const middle = height / 2
  const paths = row.segments.map((segment) => segment.kind === 'continuation'
    ? {
        kind: segment.kind,
        d: `M ${x(segment.from)} 0 C ${x(segment.from)} ${middle}, ${x(segment.to)} ${middle}, ${x(segment.to)} ${height}`,
      }
    : {
        kind: segment.kind,
        d: `M ${x(row.lane)} ${middle} C ${x(row.lane)} ${height}, ${x(segment.to)} ${middle}, ${x(segment.to)} ${height}`,
      })
  return {
    width: row.laneCount * LANE_WIDTH,
    height,
    dot: { x: x(row.lane), y: middle },
    paths,
  }
}
```

**Step 4: Lancer le test**

Run: `cd sidecar && bun test tests/ui-git-graph.test.ts`
Expected: PASS

**Step 5: Rendre la cellule SVG dans l'historique**

Dans `ui/src/GitView.tsx`, importer `gitGraphCellGeometry` depuis `./gitGraph`, puis modifier la ligne 167 pour préfixer chaque `article` d'une cellule SVG :

```tsx
<section className="git-history"><h2>Commits</h2>{rows.map((row) => {
  const geometry = gitGraphCellGeometry(row)
  return <article className="git-commit" key={row.commit.sha}>
    <svg className="git-graph-cell" width={geometry.width} height={geometry.height} aria-hidden="true">
      {geometry.paths.map((path, index) => <path key={index} className={`git-graph-${path.kind}`} d={path.d} />)}
      <circle cx={geometry.dot.x} cy={geometry.dot.y} r={4} />
    </svg>
    <div className="git-commit-copy">{/* contenu existant inchangé */}</div>
  </article>
})}</section>
```

(Le `<div className="git-commit-copy">` et tout son contenu restent identiques — seul le SVG s'ajoute devant.)

**Step 6: Styler**

Dans `ui/src/styles/git.css`, ajouter (en respectant les variables CSS existantes du fichier — lis les tokens déjà utilisés) :

```css
.git-commit { display: flex; align-items: center; gap: 0.75rem; }
.git-graph-cell { flex: none; }
.git-graph-cell path { fill: none; stroke: var(--border, #2a333d); stroke-width: 2; }
.git-graph-cell path.git-graph-parent { stroke: var(--accent, #e8a33d); }
.git-graph-cell circle { fill: var(--accent, #e8a33d); }
```

Si `.git-commit` a déjà un display défini dans le fichier, fusionner au lieu de dupliquer.

**Step 7: Vérifier et committer**

Run: `cd sidecar && bun test && cd ../ui && bunx tsc --noEmit`
Expected: PASS. Vérification visuelle au prochain lancement de l'app (pas depuis cette session si un sidecar diffuse).

```bash
git add ui/src/gitGraph.ts ui/src/GitView.tsx ui/src/styles/git.css sidecar/tests/ui-git-graph.test.ts
git commit -m "Dessiner le graphe de commits dans l'historique Git

layoutGitGraph calculait lanes et segments depuis la refonte sans
qu'aucun rendu ne les consomme."
```

---

### Task 5: Purger les colonnes résiduelles `review_flags.decision` et `projects.gardien_mode`

Résidus de l'ancien mode informatif/bloquant, supprimés du design par la refonte « calque Git » mais jamais purgés du schéma.

**Files:**
- Modify: `sidecar/src/db.ts:303,315` (les deux `addColumn`), `:496,506` (rebuild `migrateReviewFlagStatuses`), + nouveau helper `dropColumn`
- Test: `sidecar/tests` (suite existante ; vérifier s'il existe un test de migrations)

**Step 1: Vérifier qu'aucun code ne lit ces colonnes**

Run: `grep -rn "gardien_mode\|\bdecision\b" sidecar/src ui/src --include=*.ts --include=*.tsx | grep -v db.ts | grep -v codex-app-server`
Expected: aucune occurrence (le `decision` de `codex-app-server.ts:566` est un champ de protocole Codex, hors sujet).

**Step 2: Retirer la création des colonnes**

Dans `sidecar/src/db.ts` :

- supprimer la ligne 303 : `addColumn(db, "projects", "gardien_mode TEXT NOT NULL DEFAULT 'informatif'");`
- supprimer la ligne 315 : `addColumn(db, "review_flags", "decision TEXT NULL");`
- dans `migrateReviewFlagStatuses` (l.486-517) : retirer `decision TEXT NULL,` du `CREATE TABLE` de reconstruction (l.496) et `decision,` de la liste du `SELECT` de recopie (l.506). Attention à retirer la colonne des DEUX listes, sinon la recopie casse.

**Step 3: Ajouter la migration de suppression**

Ajouter un helper à côté de `addColumn` (`db.ts:396-402`), même style idempotent :

```ts
function dropColumn(db: Database, table: string, column: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}
```

Puis, dans la séquence de migrations, **après** `migrateReviewFlagStatuses(db)` :

```ts
// Résidus de l'ancien mode Gardien informatif/bloquant, supprimé par la
// refonte « calque Git » — les bases historiques les portent encore.
dropColumn(db, "projects", "gardien_mode");
dropColumn(db, "review_flags", "decision");
```

**Step 4: Vérifier**

Run: `cd sidecar && bun test`
Expected: tout PASS — la suite ouvre des bases neuves (colonnes jamais créées) et le `dropColumn` est un no-op dessus ; les bases historiques passeront par le `ALTER TABLE`.

**Step 5: Commit**

```bash
git add sidecar/src/db.ts
git commit -m "Purger les colonnes decision et gardien_mode

Résidus de l'ancien mode Gardien informatif/bloquant : plus aucune
lecture ni écriture depuis la refonte calque Git."
```

---

### Task 6: Renommer « zone » → « signalement » dans l'UI

Le glossaire (`CONTEXT.md`) réserve « zone » au tronçon de scan. Le libellé de progression `Zone N/M` (GitView.tsx:159) est donc **correct et conservé**. À corriger : les usages où « zone » désigne un signalement.

**Files:**
- Modify: `ui/src/GitView.tsx:135`
- Modify: `ui/src/DiffViewer.tsx:73`
- Modify: `ui/src/reviewDiff.ts:15`

**Step 1: Corriger les trois occurrences**

- `GitView.tsx:135` : `` `Traiter les ${openFlags.length} zones ouvertes ?` `` → `` `Traiter les ${openFlags.length} signalements ouverts ?` ``
- `DiffViewer.tsx:73` : `` aria-label={`Zone ${severityLabel(flag)}`} `` → `` aria-label={`Signalement ${severityLabel(flag)}`} ``
- `reviewDiff.ts:15` : `/** Texte initial proposé au sous-agent pour une zone. */` → `/** Texte initial proposé au sous-agent pour un signalement. */`

**Step 2: Balayer le reste**

Run: `grep -rn "zone\|Zone" ui/src --include=*.tsx --include=*.ts | grep -iv "test\|design\|rail\|contenu\|Zone \${reviewStatus\|dernière zone"`
Expected: aucune occurrence résiduelle où « zone » désigne un signalement. (Les mentions « zone de contenu » de DesignView/App et la progression `Zone N/M` sont légitimes.)

**Step 3: Vérifier et committer**

Run: `cd sidecar && bun test && cd ../ui && bunx tsc --noEmit`

```bash
git add ui/src/GitView.tsx ui/src/DiffViewer.tsx ui/src/reviewDiff.ts
git commit -m "Dire « signalement » là où l'UI disait « zone »

Le glossaire (CONTEXT.md) réserve « zone » au tronçon de scan ; la
progression « Zone N/M » est donc conservée telle quelle."
```

---

### Task 7: Mettre à jour les docs sur le comportement actuel

`docs/help/gardien.md`, la section Gardien du `README.md` et `e2e/basic-flow.md:121-169` décrivent encore l'ancien mode informatif/bloquant (« acquitter les décisions une par une »), supprimé par la refonte.

**Files:**
- Modify: `docs/help/gardien.md` (réécriture)
- Modify: `README.md` (section Gardien, l.25-38)
- Modify: `e2e/basic-flow.md:121-169`

**Step 1: Lire les trois textes actuels**

Run: `cat docs/help/gardien.md && sed -n 20,45p README.md && sed -n 115,175p e2e/basic-flow.md`

**Step 2: Réécrire en s'alignant sur le comportement réel et le glossaire**

Points que chaque texte doit refléter (vocabulaire de `CONTEXT.md`) :

- Le Gardien **surligne, l'utilisateur dirige** : plus aucun mode informatif/bloquant, plus d'acquittement obligatoire.
- « Relire ce diff » lance une review depuis la conversation ouverte ; le diff est découpé en **zones** scannées en lecture seule ; progression « Zone N/M ».
- Les **signalements** portent une sévérité red-flag (Rouge = ne devrait jamais apparaître ; Orange = implications potentiellement sérieuses ; Gris = correct mais améliorable) et un cycle : ouvert → contre-avisé → agent en cours → traité | ignoré | résolu.
- Actions par signalement : Envoyer un agent (consigne éditable), Contre-avis (provider opposé), OK vu, Ignorer. « Traiter les N ouverts » dispatche en masse.
- Les reviews sont incrémentales (les hunks inchangés recopient leurs signalements) ; le rescan automatique après chaque tour est un réglage de projet opt-in.
- Garder le ton et le format des autres pages de `docs/help/` (lis-en une autre pour calibrer).

Pour `e2e/basic-flow.md`, remplacer les étapes du protocole qui font acquitter des décisions par : lancer « Relire ce diff », vérifier l'apparition des signalements dans le diff annoté, dispatcher un signalement, constater la carte de sous-tâche inline.

**Step 3: Relire et committer**

Vérifier qu'aucun des trois textes ne mentionne plus `gardien_mode`, « informatif », « bloquant » ni « acquitter » :

Run: `grep -rn "informatif\|bloquant\|acquitt" docs/help/gardien.md README.md e2e/basic-flow.md`
Expected: aucune occurrence.

```bash
git add docs/help/gardien.md README.md e2e/basic-flow.md
git commit -m "Aligner les docs Gardien sur le calque Git

gardien.md, le README et le protocole e2e décrivaient encore le mode
informatif/bloquant et l'acquittement, supprimés par la refonte."
```

---

## Vérification finale

1. `cd sidecar && bun test` — suite complète verte.
2. `cd ui && bunx tsc --noEmit` — zéro erreur.
3. `grep -rn "linkedConversationId\|gardien_mode" sidecar ui` — vide.
4. Rappel TODO utilisateur : les tâches 1 et 5 touchent le sidecar — **redémarrage requis** (`bun run dev:sidecar` hors conversation Pupitre) pour être actives.

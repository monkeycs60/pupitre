# Reprendre la dernière conversation active au démarrage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restaurer au démarrage le dernier projet et la dernière conversation actifs, avec un repli déterministe si l'un n'est plus disponible.

**Architecture:** Un module UI pur lit et valide le snapshot `localStorage`, puis choisit le projet mémorisé et la conversation active la plus récente en repli. `App.tsx` charge les données au montage, applique la sélection et réécrit le snapshot après chaque changement de navigation.

**Tech Stack:** React 19, TypeScript, Vite, Bun test, `localStorage`.

## Global Constraints

- Persister la navigation sous la clé `pupitre.last-active-location`.
- Ne restaurer que les conversations du scope `active`.
- Ignorer les erreurs de lecture et d'écriture du `localStorage`.
- Ne modifier ni le schéma SQLite ni l'API du sidecar.
- Conserver l'état vide lors d'une première ouverture sans snapshot.
- Créer des commits locaux uniquement ; ne jamais exécuter `git push`.

---

### Task 1: Module pur de restauration et tests unitaires

**Files:**
- Create: `ui/src/restoreLocation.ts`
- Test: `ui/src/restoreLocation.test.ts`

**Interfaces:**
- Consumes: `Project` et `Conversation` depuis `ui/src/types.ts`.
- Produces: `LAST_ACTIVE_LOCATION_STORAGE_KEY`, `StorageLike`, `LastActiveLocation`, `readLastActiveLocation`, `writeLastActiveLocation`, `restoreProject` et `restoreConversation`.

- [ ] **Step 1: Write the failing test**

Créer un stockage mémoire minimal et couvrir ces comportements :

```ts
test('lit un snapshot valide et ignore un JSON invalide', () => {
  expect(readLastActiveLocation(storageWith(
    JSON.stringify({ projectId: 'project-1', conversationId: 'conversation-1' }),
  ))).toEqual({ projectId: 'project-1', conversationId: 'conversation-1' })
  expect(readLastActiveLocation(storageWith('{'))).toBeNull()
})

test('ne restaure aucun projet sans snapshot et replie vers le premier projet si nécessaire', () => {
  expect(restoreProject(projects, null)).toBeNull()
  expect(restoreProject(projects, { projectId: 'missing', conversationId: null }))
    .toEqual(projects[0])
})

test('restaure la conversation mémorisée ou la plus récemment mise à jour', () => {
  expect(restoreConversation(conversations, 'conversation-1')?.id)
    .toBe('conversation-1')
  expect(restoreConversation(conversations, 'missing')?.id)
    .toBe('conversation-newest')
  expect(restoreConversation([], null)).toBeNull()
})

test('écrit le snapshot sans propager une erreur de stockage', () => {
  const storage = memoryStorage()
  writeLastActiveLocation(storage, { projectId: 'project-1', conversationId: null })
  expect(readLastActiveLocation(storage)).toEqual({
    projectId: 'project-1',
    conversationId: null,
  })
  expect(() => writeLastActiveLocation(failingStorage(), {
    projectId: 'project-1',
    conversationId: null,
  })).not.toThrow()
})
```

Les fixtures doivent être des objets `Project` et `Conversation` complets
enregistrés dans le test, avec deux dates `updated_at` distinctes afin que le
repli soit observable.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun test src/restoreLocation.test.ts`

Expected: FAIL because `ui/src/restoreLocation.ts` and its exported
interfaces/functions do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Créer les types et fonctions suivants :

```ts
export const LAST_ACTIVE_LOCATION_STORAGE_KEY = 'pupitre.last-active-location'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface LastActiveLocation {
  projectId: string
  conversationId: string | null
}

export function readLastActiveLocation(storage: StorageLike): LastActiveLocation | null
export function writeLastActiveLocation(
  storage: StorageLike,
  location: LastActiveLocation,
): void
export function restoreProject(
  projects: readonly Project[],
  location: LastActiveLocation | null,
): Project | null
export function restoreConversation(
  conversations: readonly Conversation[],
  conversationId: string | null,
): Conversation | null
```

`readLastActiveLocation` doit valider que `projectId` est une chaîne non vide
et que `conversationId` est soit `null`, soit une chaîne non vide. Les erreurs
de `getItem`, `setItem` et `JSON.parse` doivent retourner `null` ou ne rien
faire. `restoreProject` retourne `null` sans snapshot, le projet mémorisé s'il
existe, sinon le premier projet. `restoreConversation` retourne l'identifiant
mémorisé s'il existe, sinon l'élément dont `updated_at` est le plus récent.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun test src/restoreLocation.test.ts`

Expected: PASS for every restoration and stockage case.

- [ ] **Step 5: Commit**

```bash
git add ui/src/restoreLocation.ts ui/src/restoreLocation.test.ts
git commit -m "feat(ui): ajoute la sélection persistante au démarrage"
```

### Task 2: Restaurer et persister la sélection dans App

**Files:**
- Modify: `ui/src/App.tsx:18-24, 76-160`

**Interfaces:**
- Consumes: les fonctions du module `ui/src/restoreLocation.ts`, `listProjects` et `listProjectConversations`.
- Produces: `locationForSelection(project, conversation): LastActiveLocation | null`, une sélection cohérente de `selectedProject` et `selectedConversation` au montage, puis un snapshot local à jour après chaque changement.

- [ ] **Step 1: Write the failing test**

Ajouter au test du module un cas sur la forme du snapshot écrit depuis l'état
de l'interface : une conversation appartenant à un autre projet doit être
ignorée.

```ts
test('n'écrit pas une conversation appartenant à un autre projet', () => {
  expect(locationForSelection(projects[0], conversationsFromAnotherProject[0]))
    .toEqual({ projectId: 'project-1', conversationId: null })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun test src/restoreLocation.test.ts`

Expected: FAIL because `locationForSelection` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Dans `App.tsx` :

1. Importer le module de restauration.
2. Ajouter `const [locationRestored, setLocationRestored] = useState(false)`.
3. Ajouter un effet de montage qui lit le snapshot, charge les projets, ne
   sélectionne rien si le snapshot est absent, sinon sélectionne le projet
   mémorisé ou le premier projet, charge ses conversations actives et restaure
   l'identifiant mémorisé seulement si le projet mémorisé existe encore.
4. Si le chargement des conversations échoue, conserver le projet sélectionné,
   laisser la sidebar gérer son propre chargement et terminer la restauration
   sans faire échouer l'application.
5. Ajouter un effet qui écrit `{ projectId, conversationId }` après la fin de
   l'initialisation. Il doit ignorer l'état sans projet afin de ne pas effacer
   un snapshot lors d'une erreur réseau initiale.
6. Ajouter `locationForSelection(project, conversation): LastActiveLocation | null`
   au module pur ; retourner `null` sans projet et ignorer une conversation
   dont `project_id` ne correspond pas au projet fourni.
7. Utiliser `conversationId: null` quand aucune conversation du projet courant
   n'est sélectionnée ; vérifier la correspondance `project_id` avant d'écrire
   pour éviter un snapshot mélangeant deux projets pendant une transition.

Le squelette attendu pour la persistance est :

```ts
useEffect(() => {
  if (!locationRestored || selectedProject === null) return
  const location = locationForSelection(selectedProject, selectedConversation)
  if (location !== null) writeLastActiveLocation(window.localStorage, location)
}, [locationRestored, selectedProject?.id, selectedConversation?.id])
```

L'effet de restauration doit utiliser un drapeau `ignore` dans son nettoyage
pour ne pas appliquer des réponses asynchrones après démontage.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun test src/restoreLocation.test.ts`

Expected: PASS, avec la logique UI branchée sur les fonctions testées.

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.tsx ui/src/restoreLocation.test.ts
git commit -m "feat(ui): restaure la dernière conversation au lancement"
```

### Task 3: Vérification complète et état Git

**Files:**
- Verify: `ui/src/App.tsx`
- Verify: `ui/src/restoreLocation.ts`
- Verify: `ui/src/restoreLocation.test.ts`

**Interfaces:**
- Consumes: les deux commits de fonctionnalité précédents.
- Produces: build UI valide et dépôt local sans push.

- [ ] **Step 1: Run the targeted tests**

Run: `cd ui && bun test src/restoreLocation.test.ts`

Expected: PASS without test failures.

- [ ] **Step 2: Run the UI typecheck**

Run: `cd ui && bunx tsc --noEmit`

Expected: exit code 0.

- [ ] **Step 3: Run the UI production build**

Run: `cd ui && bun run build`

Expected: exit code 0 and a refreshed `ui/dist` build output.

- [ ] **Step 4: Inspect the final diff and verify no push**

Run: `git diff --check` and `git status -sb`

Expected: no whitespace errors, only the intended local commits represented by
the branch state, and no command invoking `git push`.

- [ ] **Step 5: Commit any verification-only source adjustment**

If the implementation required a source adjustment during verification, run:

```bash
git add ui/src/App.tsx ui/src/restoreLocation.ts ui/src/restoreLocation.test.ts
git commit -m "fix(ui): finalise la reprise de conversation"
```

If no source adjustment was required, keep the existing feature commits and do
not create an empty commit.

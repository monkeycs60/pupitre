# Workflows Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Afficher et utiliser les workflows dans un onglet dédié de la sidebar, à côté des conversations.

**Architecture:** `Sidebar` conserve le chargement des deux collections et choisit leur panneau à partir d'un état local `sidebarTab`. Un petit module pur fournit les libellés, la recherche et l'aperçu des workflows ; la sidebar appelle l'API existante `runWorkflow()` pour créer puis sélectionner la conversation obtenue. `WorkflowDialog` est conservée comme formulaire d'édition.

**Tech Stack:** React 19, TypeScript, Vite, Bun tests, CSS maison.

## Global Constraints

- Ne pas ajouter de valeur à `WorkspaceView` ni créer de vue centrale.
- Réutiliser `runWorkflow(id)` et `WorkflowDialog` ; ne pas modifier le modèle ou l'API workflows.
- Respecter les rôles ARIA `tablist`, `tab` et `tabpanel` pour les deux panneaux.
- Garder les textes UI en français et les métadonnées compactes.

---

### Task 1: Extraire les utilitaires de liste des workflows

**Files:**
- Create: `ui/src/workflowSidebar.ts`
- Create: `ui/src/workflowSidebar.test.ts`

**Interfaces:**
- Consumes: `Workflow` depuis `ui/src/types.ts`.
- Produces: `filterWorkflows(workflows: Workflow[], query: string): Workflow[]` et `workflowSummary(workflow: Workflow): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test'
import { filterWorkflows, workflowSummary } from './workflowSidebar'

const workflow = {
  id: 'review', name: 'Revue de PR', prompt: 'Relis le diff de la branche courante.',
  skill_invocation: 'diff-review', preset_id: 'builtin-quality',
} as never

test('filtre les workflows par nom, skill ou consigne', () => {
  expect(filterWorkflows([workflow], 'diff')).toEqual([workflow])
  expect(filterWorkflows([workflow], 'branche')).toEqual([workflow])
  expect(filterWorkflows([workflow], 'inconnu')).toEqual([])
})

test('construit un aperçu compact de workflow', () => {
  expect(workflowSummary(workflow)).toBe('Relis le diff de la branche courante.')
})

test('compacte les espaces de la consigne', () => {
  expect(workflowSummary({ ...workflow, prompt: '  Décrire   le   résultat. ' } as never))
    .toBe('Décrire le résultat.')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ui/src/workflowSidebar.test.ts`

Expected: FAIL because `./workflowSidebar` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Workflow } from './types'

export function filterWorkflows(workflows: Workflow[], query: string): Workflow[] {
  const needle = query.trim().toLocaleLowerCase('fr-FR')
  if (!needle) return workflows
  return workflows.filter((workflow) =>
    [workflow.name, workflow.skill_invocation, workflow.prompt]
      .join(' ').toLocaleLowerCase('fr-FR').includes(needle),
  )
}

export function workflowSummary(workflow: Workflow): string {
  return workflow.prompt.replace(/\s+/gu, ' ').trim()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ui/src/workflowSidebar.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/workflowSidebar.ts ui/src/workflowSidebar.test.ts
git commit -m "test: cover workflow sidebar helpers"
```

### Task 2: Ajouter les onglets et la liste de workflows à Sidebar

**Files:**
- Modify: `ui/src/Sidebar.tsx`
- Modify: `ui/src/WorkflowDialog.tsx`
- Modify: `ui/src/styles/sidebar.css`

**Interfaces:**
- Consumes: `filterWorkflows`, `workflowSummary`, `runWorkflow(id)`, `WorkflowDialog`.
- Produces: une sidebar avec deux panneaux accessibles et le callback existant `onConversationSelect` déclenché après le lancement d'un workflow.

- [ ] **Step 1: Implement the sidebar interaction**

Dans `Sidebar.tsx`, introduire :

```ts
type SidebarTab = 'conversations' | 'workflows'
const [sidebarTab, setSidebarTab] = useState<SidebarTab>('conversations')
const [workflowFilterText, setWorkflowFilterText] = useState('')

async function handleWorkflowRun(workflow: Workflow) {
  setError(null)
  try {
    const conversation = await runWorkflow(workflow.id)
    onConversationSelect(conversation)
  } catch (runError: unknown) {
    setError(errorMessage(runError))
  }
}
```

Remplacer le titre actuel de la section par les deux onglets. Afficher dans le panneau Workflows le bouton `+ Nouveau workflow`, un champ `Filtrer N workflows…`, et, pour chaque résultat, le nom, `workflowSummary(workflow)`, `$${workflow.skill_invocation}` et `preset` ou le modèle. Ajouter les boutons `Lancer →` et `Modifier`. Réinitialiser `sidebarTab` et les filtres lors du changement de projet.

Dans `WorkflowDialog.tsx`, ajouter la prop optionnelle `initialWorkflow?: Workflow | null`. Quand cette prop est fournie et que la liste de skills a chargé, appeler `edit(initialWorkflow)` une seule fois afin de préremplir le formulaire depuis le bouton Modifier. La création depuis Nouveau workflow ne fournit pas cette prop.

Dans `sidebar.css`, ajouter les styles d'onglets segmentés et des lignes workflow denses, avec actions visibles au survol ou au focus ; conserver les variables de thème existantes.

- [ ] **Step 2: Run test to verify it stays green**

Run: `bun test ui/src/workflowSidebar.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/Sidebar.tsx ui/src/WorkflowDialog.tsx ui/src/styles/sidebar.css ui/src/workflowSidebar.ts ui/src/workflowSidebar.test.ts
git commit -m "feat: add workflow tab to sidebar"
```

### Task 3: Vérifier l'intégration complète

**Files:**
- Modify: `docs/superpowers/specs/2026-08-08-workflows-sidebar-design.md` uniquement si la validation révèle un écart de spécification.

**Interfaces:**
- Consumes: l'application UI compilée et les tests Bun.
- Produces: une build et un lint sans erreur.

- [ ] **Step 1: Exécuter les tests ciblés**

Run: `bun test ui/src/workflowSidebar.test.ts ui/src/restoreLocation.test.ts`

Expected: PASS.

- [ ] **Step 2: Vérifier le lint**

Run: `bun run --cwd ui lint`

Expected: exit code 0.

- [ ] **Step 3: Vérifier la build TypeScript et Vite**

Run: `bun run --cwd ui build`

Expected: exit code 0.

- [ ] **Step 4: Vérifier manuellement le flux**

Ouvrir un projet, sélectionner l'onglet Workflows, filtrer une entrée, lancer un workflow puis vérifier que la conversation créée est ouverte. Créer ou modifier un workflow depuis l'onglet et vérifier qu'il apparaît immédiatement dans la liste.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-08-workflows-sidebar-design.md
git commit -m "docs: record workflow sidebar validation"
```

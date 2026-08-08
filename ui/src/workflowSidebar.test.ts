import { expect, test } from 'bun:test'
import { filterWorkflows, workflowSummary } from './workflowSidebar'
import type { Workflow } from './types'

const reviewWorkflow: Workflow = {
  id: 'review',
  project_id: 'pupitre',
  name: 'Revue de PR',
  skill_id: 'skill-review',
  skill_name: 'Diff review',
  skill_invocation: 'diff-review',
  prompt: 'Relis le diff de la branche courante.',
  preset_id: 'builtin-quality',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  speed: 'standard',
  orchestrator: true,
  created_at: '2026-08-08T08:00:00.000Z',
  updated_at: '2026-08-08T08:00:00.000Z',
}

test('filtre les workflows par nom, skill ou consigne', () => {
  expect(filterWorkflows([reviewWorkflow], 'diff')).toEqual([reviewWorkflow])
  expect(filterWorkflows([reviewWorkflow], 'branche')).toEqual([reviewWorkflow])
  expect(filterWorkflows([reviewWorkflow], 'inconnu')).toEqual([])
})

test('construit un aperçu compact de workflow', () => {
  expect(workflowSummary({ ...reviewWorkflow, prompt: '  Décrire   le   résultat. ' }))
    .toBe('Décrire le résultat.')
})

import type { Workflow } from './types'

export function filterWorkflows(workflows: Workflow[], query: string): Workflow[] {
  const needle = query.trim().toLocaleLowerCase('fr-FR')
  if (!needle) return workflows
  return workflows.filter((workflow) => [
    workflow.name,
    workflow.skill_invocation,
    workflow.prompt,
  ].join(' ').toLocaleLowerCase('fr-FR').includes(needle))
}

export function workflowSummary(workflow: Workflow): string {
  return workflow.prompt.replace(/\s+/gu, ' ').trim()
}

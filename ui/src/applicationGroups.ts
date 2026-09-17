import type { RunningApplication } from './api'

export interface ApplicationGroup {
  id: string
  projectName: string
  label: string
  applications: RunningApplication[]
}

export function groupRunningApplications(items: RunningApplication[]): ApplicationGroup[] {
  const groups = new Map<string, ApplicationGroup>()
  for (const application of items) {
    const label = application.branch ?? application.workspace
    const id = `${application.projectId}:${label}`
    const group = groups.get(id)
    if (group) group.applications.push(application)
    else groups.set(id, {
      id,
      projectName: application.projectName,
      label,
      applications: [application],
    })
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      applications: group.applications.toSorted((left, right) => left.name.localeCompare(right.name) || left.port - right.port),
    }))
    .toSorted((left, right) => left.projectName.localeCompare(right.projectName)
      || right.applications.length - left.applications.length
      || left.label.localeCompare(right.label))
}

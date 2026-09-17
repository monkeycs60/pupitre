import type { RunningApplication } from './api'

export interface BranchApplicationGroup {
  id: string
  label: string
  applications: RunningApplication[]
}

export interface ProjectApplicationGroup {
  id: string
  name: string
  applicationCount: number
  branches: BranchApplicationGroup[]
}

export function groupRunningApplications(items: RunningApplication[]): ProjectApplicationGroup[] {
  const projects = new Map<string, ProjectApplicationGroup>()

  for (const application of items) {
    const label = application.branch ?? application.workspace
    let project = projects.get(application.projectId)
    if (!project) {
      project = {
        id: application.projectId,
        name: application.projectName,
        applicationCount: 0,
        branches: [],
      }
      projects.set(application.projectId, project)
    }

    project.applicationCount += 1
    const branch = project.branches.find((candidate) => candidate.label === label)
    if (branch) branch.applications.push(application)
    else project.branches.push({
      id: `${application.projectId}:${label}`,
      label,
      applications: [application],
    })
  }

  return [...projects.values()]
    .map((project) => ({
      ...project,
      branches: project.branches
        .map((branch) => ({
          ...branch,
          applications: branch.applications.toSorted((left, right) => left.name.localeCompare(right.name) || left.port - right.port),
        }))
        .toSorted((left, right) => right.applications.length - left.applications.length || left.label.localeCompare(right.label)),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name))
}

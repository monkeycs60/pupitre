export type ProjectSection = 'todos' | 'tickets' | 'sentry' | 'changelog' | 'environments'
export type ProjectSurfaceLayout = 'full' | 'docked'

export const PROJECT_SECTIONS: ReadonlyArray<{ id: ProjectSection; label: string }> = [
  { id: 'todos', label: 'Tâches' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'sentry', label: 'Sentry' },
  { id: 'changelog', label: 'Changelog' },
  { id: 'environments', label: 'Environnements' },
]

export function projectSectionStorageKey(projectId: string): string {
  return `pupitre:dashboard-tab:${projectId}`
}

export function storedProjectSection(projectId: string): ProjectSection {
  const stored = window.localStorage.getItem(projectSectionStorageKey(projectId))
  return PROJECT_SECTIONS.some((section) => section.id === stored) ? stored as ProjectSection : 'todos'
}

function projectLayoutStorageKey(projectId: string, section: ProjectSection): string {
  return `pupitre:project-layout:${projectId}:${section}`
}

export function storedProjectLayout(projectId: string, section: ProjectSection): ProjectSurfaceLayout {
  const stored = window.localStorage.getItem(projectLayoutStorageKey(projectId, section))
  if (stored === 'full' || stored === 'docked') return stored
  return section === 'todos' ? 'docked' : 'full'
}

export function storeProjectLayout(projectId: string, section: ProjectSection, layout: ProjectSurfaceLayout): void {
  window.localStorage.setItem(projectLayoutStorageKey(projectId, section), layout)
}

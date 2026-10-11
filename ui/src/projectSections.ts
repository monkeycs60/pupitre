export type ProjectSection = 'todos' | 'tickets' | 'sentry' | 'changelog' | 'environments' | 'code' | 'structure'

export const PROJECT_SECTIONS: ReadonlyArray<{ id: ProjectSection; label: string }> = [
  { id: 'tickets', label: 'Tickets' },
  { id: 'sentry', label: 'Sentry' },
  { id: 'changelog', label: 'Changelog' },
  { id: 'environments', label: 'Environnements' },
  { id: 'todos', label: 'Tâches' },
  { id: 'code', label: 'Code' },
  { id: 'structure', label: 'Structure' },
]

export function projectSectionStorageKey(projectId: string): string {
  return `pupitre:dashboard-tab:${projectId}`
}

export function storedProjectSection(projectId: string): ProjectSection {
  const stored = window.localStorage.getItem(projectSectionStorageKey(projectId))
  return PROJECT_SECTIONS.some((section) => section.id === stored) ? stored as ProjectSection : 'todos'
}

export function projectNavigationIndexForShortcut(event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): number | null {
  if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return null
  const match = /^(?:Digit|Numpad)([1-8])$/.exec(event.code)
  return match ? Number(match[1]) - 1 : null
}

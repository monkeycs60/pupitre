export type ProjectSection = 'todos' | 'tickets' | 'sentry'

export const PROJECT_SECTIONS: ReadonlyArray<{ id: ProjectSection; label: string }> = [
  { id: 'tickets', label: 'Tickets' },
  { id: 'todos', label: 'Tâches' },
  { id: 'sentry', label: 'Sentry' },
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
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)
  const index = match ? Number(match[1]) - 1 : null
  return index !== null && index <= PROJECT_SECTIONS.length ? index : null
}

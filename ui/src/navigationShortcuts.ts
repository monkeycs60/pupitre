export type NavigationShortcutView = 'conversations' | 'fleet' | 'dashboard' | 'documents' | 'design'

export const NAVIGATION_SHORTCUTS: ReadonlyArray<{
  view: NavigationShortcutView
  key: string
  label: string
}> = [
  { view: 'conversations', key: 'c', label: 'Ctrl Alt C' },
  { view: 'fleet', key: 'f', label: 'Ctrl Alt F' },
  { view: 'dashboard', key: 't', label: 'Ctrl Alt T' },
  { view: 'documents', key: 'd', label: 'Ctrl Alt D' },
  { view: 'design', key: 'g', label: 'Ctrl Alt G' },
]

export function navigationShortcutLabel(view: string): string | null {
  return NAVIGATION_SHORTCUTS.find((shortcut) => shortcut.view === view)?.label ?? null
}

export function navigationViewForShortcut(event: KeyboardEvent): NavigationShortcutView | null {
  if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return null
  return NAVIGATION_SHORTCUTS.find((shortcut) => shortcut.key === event.key.toLocaleLowerCase())?.view ?? null
}

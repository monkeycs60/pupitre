export type NavigationShortcutView = 'conversations' | 'fleet' | 'dashboard' | 'documents' | 'design'

export const NAVIGATION_SHORTCUTS: ReadonlyArray<{
  view: NavigationShortcutView
  key: string
  label: string
}> = [
  { view: 'conversations', key: 'c', label: 'Ctrl Maj C' },
  { view: 'fleet', key: 'f', label: 'Ctrl Maj F' },
  { view: 'dashboard', key: 't', label: 'Ctrl Maj T' },
  { view: 'documents', key: 'd', label: 'Ctrl Maj D' },
  { view: 'design', key: 'g', label: 'Ctrl Maj G' },
]

export function navigationShortcutLabel(view: string): string | null {
  return NAVIGATION_SHORTCUTS.find((shortcut) => shortcut.view === view)?.label ?? null
}

export function navigationViewForShortcut(event: KeyboardEvent): NavigationShortcutView | null {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return null
  return NAVIGATION_SHORTCUTS.find((shortcut) => shortcut.key === event.key.toLocaleLowerCase())?.view ?? null
}

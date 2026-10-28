import type { KeyboardEvent } from 'react'
import { useDashboard } from './useDashboard'
import { PROJECT_SECTIONS, type ProjectSection } from './projectSections'

interface ProjectSectionSwitchProps {
  projectId: string
  activeSection: ProjectSection | null
  todoCount: number
  onSelect: (section: ProjectSection | null) => void
}

export function ProjectSectionSwitch({ projectId, activeSection, todoCount, onSelect }: ProjectSectionSwitchProps) {
  const { data } = useDashboard(projectId)
  const counts: Partial<Record<ProjectSection, number>> = {
    todos: todoCount,
    tickets: data?.tickets.length ?? 0,
  }
  const items: Array<{ id: ProjectSection | null; label: string }> = [{ id: null, label: 'Conversations' }, ...PROJECT_SECTIONS]

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % items.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = items.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    onSelect(items[nextIndex]!.id)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[nextIndex]?.focus()
  }

  return (
    <nav className="project-section-switch" aria-label="Sections du projet">
      <div role="tablist" aria-label="Sections du projet">
        {items.map((item, index) => {
          const selected = item.id === activeSection
          const count = item.id === null ? 0 : counts[item.id] ?? 0
          return (
            <button
              key={item.id ?? 'conversations'}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={selected ? 'is-selected' : ''}
              title={`${item.label} · Ctrl ${index + 1}`}
              aria-label={`${item.label}${count > 0 ? ` ${count}` : ''}`}
              onClick={() => onSelect(item.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {item.label}
              {count > 0 ? <span className="project-section-count">{count}</span> : null}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

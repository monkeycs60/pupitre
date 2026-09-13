import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { getSentryInbox } from './api'
import { useDashboard } from './useDashboard'
import { PROJECT_SECTIONS, type ProjectSection } from './projectSections'

const CONVERSATION_ICON = <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z" />

const ICONS: Record<ProjectSection, ReactNode> = {
  todos: <path d="m2.5 4 1.2 1.2L6 2.9M8 4h5M2.5 8h3M8 8h5M2.5 12h3M8 12h5" />,
  tickets: <><rect x="2" y="4" width="12" height="8" rx="1.5" /><path d="M2 7h12" /></>,
  sentry: <path d="M8 2.5 13.5 12H10a2 2 0 0 0-2-2 2 2 0 0 0-2 2H2.5Z" />,
  changelog: <path d="M3 4.5h10M3 8h7M3 11.5h9" />,
  environments: <><rect x="2.5" y="3" width="11" height="4" rx="1" /><rect x="2.5" y="9" width="11" height="4" rx="1" /><path d="M5 5h.01M5 11h.01" /></>,
}

interface ProjectSectionSwitchProps {
  projectId: string
  activeSection: ProjectSection | null
  todoCount: number
  onSelect: (section: ProjectSection | null) => void
}

export function ProjectSectionSwitch({ projectId, activeSection, todoCount, onSelect }: ProjectSectionSwitchProps) {
  const { data } = useDashboard(projectId)
  const [sentryCount, setSentryCount] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void getSentryInbox(projectId, controller.signal)
      .then((payload) => { if (!controller.signal.aborted) setSentryCount(payload.issues.length) })
      .catch(() => {})
    return () => controller.abort()
  }, [projectId])

  const counts: Partial<Record<ProjectSection, number>> = {
    todos: todoCount,
    tickets: data?.tickets.length ?? 0,
    sentry: sentryCount,
  }
  const items = [{ id: null, label: 'Conversation', icon: CONVERSATION_ICON }, ...PROJECT_SECTIONS.map((section) => ({ ...section, icon: ICONS[section.id] }))]

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % items.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = items.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const next = items[nextIndex]!
    onSelect(next.id as ProjectSection | null)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[nextIndex]?.focus()
  }

  return <nav className="project-section-switch" aria-label="Conversation et sections du projet">
    <div role="tablist" aria-label="Conversation et sections du projet">
      {items.map((item, index) => {
        const selected = item.id === activeSection
        const count = item.id === null ? 0 : counts[item.id] ?? 0
        return <button
          key={item.id ?? 'conversation'}
          type="button"
          role="tab"
          aria-selected={selected}
          tabIndex={selected ? 0 : -1}
          className={selected ? 'is-selected' : ''}
          title={`${item.label} (Ctrl ${index + 1})`}
          aria-label={`${item.label}${count > 0 ? ` ${count}` : ''}`}
          onClick={() => onSelect(item.id as ProjectSection | null)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{item.icon}</g></svg>
          <span className="project-section-label">{item.label}</span>
          {count > 0 ? <span className={`project-section-count${item.id === 'sentry' ? ' is-alert' : ''}`}>{count}</span> : null}
        </button>
      })}
    </div>
  </nav>
}

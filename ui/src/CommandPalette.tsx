import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  listProjectConversations,
  listProjectWorkflows,
  listProjects,
  listSkills,
  runWorkflow,
  searchGlobal,
} from './api'
import type {
  Conversation,
  Project,
  SearchResult,
  SkillSummary,
  Workflow,
  WorkspaceView,
} from './types'
import { useDesignPanelSuspend } from './useDesignPanelSuspend'

type PaletteAction = 'test' | 'summary' | 'review'

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentProject: Project | null
  currentConversation: Conversation | null
  onProjectSelect: (project: Project) => void
  onConversationSelect: (projectId: string, conversationId: string) => void | Promise<void>
  onSkillLaunch: (skill: SkillSummary) => void
  onViewSelect: (view: Extract<WorkspaceView, 'dashboard' | 'fleet' | 'routines' | 'documents' | 'library' | 'memory' | 'help'>) => void
  onAction: (action: PaletteAction) => void | Promise<void>
}

interface PaletteItem {
  id: string
  group: string
  label: string
  detail: string
  run: () => void | Promise<void>
}

function normalized(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

function matches(query: string, ...values: string[]): boolean {
  const needle = normalized(query.trim())
  return !needle || values.some((value) => normalized(value).includes(needle))
}

function resultDetail(result: SearchResult): string {
  const source = result.kind === 'debrief' ? 'Débrief' : result.kind === 'event' ? 'Message' : 'Conversation'
  return `${source} · ${result.excerpt}`
}

function resultKindLabel(kind: SearchResult['kind']): string {
  return kind === 'debrief' ? 'Débriefs' : kind === 'event' ? 'Messages' : 'Conversations'
}

export function CommandPalette({
  open,
  onOpenChange,
  currentProject,
  currentConversation,
  onProjectSelect,
  onConversationSelect,
  onSkillLaunch,
  onViewSelect,
  onAction,
}: CommandPaletteProps) {
  // La palette est globale, donc elle peut s'ouvrir par-dessus le panneau Claude
  // Design. Ce panneau est une webview, une surface de l'OS : sans ce masquage,
  // la palette s'ouvrirait derrière lui, quel que soit son `z-index`.
  useDesignPanelSuspend(open)
  const [query, setQuery] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [results, setResults] = useState<SearchResult[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        onOpenChange(!open)
      } else if (event.key === 'Escape') {
        onOpenChange(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onOpenChange, open])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    setError(null)
    let ignore = false
    void listProjects()
      .then(async (loadedProjects) => {
        const [conversationGroups, workflowGroups, loadedSkills] = await Promise.all([
          Promise.all(loadedProjects.map((project) => listProjectConversations(project.id))),
          Promise.all(loadedProjects.map((project) => listProjectWorkflows(project.id))),
          listSkills({ favoriteProjectId: currentProject?.id }),
        ])
        if (ignore) return
        setProjects(loadedProjects)
        setConversations(conversationGroups.flat().sort((left, right) => right.updated_at.localeCompare(left.updated_at)))
        setWorkflows(workflowGroups.flat())
        setSkills(loadedSkills)
      })
      .catch((loadError: unknown) => {
        if (!ignore) setError(loadError instanceof Error ? loadError.message : 'Palette indisponible')
      })
    return () => { ignore = true }
  }, [open, currentProject?.id])

  useEffect(() => {
    if (!open || !query.trim()) {
      setResults([])
      return
    }
    setResults([])
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void searchGlobal(query, undefined, controller.signal)
        .then(setResults)
        .catch((searchError: unknown) => {
          if (!controller.signal.aborted) setError(searchError instanceof Error ? searchError.message : 'Recherche indisponible')
        })
    }, 120)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, query])

  const items = useMemo<PaletteItem[]>(() => {
    const next: PaletteItem[] = []
    const add = (item: PaletteItem) => next.push(item)
    const views = [
      ['dashboard', 'Tableau de bord', 'Tickets, MR, environnements'],
      ['fleet', 'Fleet', 'Runs actifs tous projets'],
      ['routines', 'Routines', 'Planifications et historique'],
      ['documents', 'Documents', 'Livrables HTML et PDF'],
      ['library', 'Skills', 'Compétences et prompts disponibles'],
      ['memory', 'Mémoire', 'Fichiers de mémoire persistante Claude'],
      ['help', 'Aide', 'Comprendre les concepts de Pupitre'],
    ] as const
    for (const [view, label, detail] of views) {
      if (matches(query, label, detail)) add({ id: `view-${view}`, group: 'Aller à', label, detail, run: () => onViewSelect(view) })
    }
    if (currentConversation) {
      const actions: Array<[PaletteAction, string, string]> = [
        ['test', 'Tester', 'Proposer des vérifications ciblées'],
        ['summary', 'Résumé session', 'Lister les changements et les éléments à terminer'],
        ['review', 'Relire le diff', 'Analyser le diff Git avec le modèle de review'],
      ]
      for (const [action, label, detail] of actions) {
        if (matches(query, label, detail)) add({ id: `action-${action}`, group: 'Action', label, detail, run: () => onAction(action) })
      }
    }
    for (const project of projects.filter((item) => matches(query, item.name, item.path)).slice(0, 8)) {
      add({ id: `project-${project.id}`, group: 'Projet', label: project.name, detail: project.path, run: () => onProjectSelect(project) })
    }
    if (!query.trim()) {
      for (const conversation of conversations.slice(0, 10)) {
        const project = projects.find((item) => item.id === conversation.project_id)
        add({
          id: `conversation-${conversation.id}`,
          group: 'Conversation récente',
          label: conversation.title,
          detail: `${conversation.summary || 'Sans résumé'} · ${project?.name ?? 'Projet'} · ${conversation.provider} ${conversation.model}`,
          run: () => onConversationSelect(conversation.project_id, conversation.id),
        })
      }
    }
    const groupedResults = new Map<string, SearchResult[]>()
    for (const result of results) {
      const group = groupedResults.get(result.conversationId) ?? []
      group.push(result)
      groupedResults.set(result.conversationId, group)
    }
    for (const resultGroup of groupedResults.values()) {
      const firstResult = resultGroup[0]
      if (!firstResult) continue
      const project = projects.find((item) => item.id === firstResult.projectId)
      const conversation = conversations.find((item) => item.id === firstResult.conversationId)
      const kinds = [...new Set(resultGroup.map((result) => result.kind))]
        .map(resultKindLabel)
        .join(', ')
      const excerpts = resultGroup.slice(0, 3).map(resultDetail).join(' · ')
      add({
        id: `search-${firstResult.conversationId}`,
        group: 'Recherche',
        label: conversation?.title ?? firstResult.title,
        detail: `${project?.name ?? 'Projet'} · ${resultGroup.length} occurrence${resultGroup.length === 1 ? '' : 's'} · ${kinds} · ${excerpts}`,
        run: () => onConversationSelect(firstResult.projectId, firstResult.conversationId),
      })
    }
    for (const workflow of workflows.filter((item) => matches(query, item.name, item.prompt, item.skill_name)).slice(0, 8)) {
      const project = projects.find((item) => item.id === workflow.project_id)
      add({
        id: `workflow-${workflow.id}`,
        group: 'Workflow',
        label: workflow.name,
        detail: `${project?.name ?? 'Projet'} · $${workflow.skill_invocation}`,
        run: async () => {
          const conversation = await runWorkflow(workflow.id)
          await onConversationSelect(workflow.project_id, conversation.id)
        },
      })
    }
    if (currentProject) {
      for (const skill of skills
        .filter((item) => item.project_id === null || item.project_id === currentProject.id)
        .filter((item) => matches(query, item.name, item.description, ...item.triggers))
        .slice(0, 8)) {
        add({
          id: `skill-${skill.id}`,
          group: 'Skill',
          label: `$${skill.invocation}`,
          detail: skill.description || skill.provenance,
          run: () => onSkillLaunch(skill),
        })
      }
    }
    return next
  }, [conversations, currentConversation, currentProject, onAction, onConversationSelect, onProjectSelect, onSkillLaunch, onViewSelect, projects, query, results, skills, workflows])

  async function execute(item: PaletteItem) {
    if (busyId) return
    setBusyId(item.id)
    setError(null)
    try {
      await item.run()
      onOpenChange(false)
      setQuery('')
      setSelectedIndex(0)
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Action impossible')
    } finally {
      setBusyId(null)
    }
  }

  function handleInputKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex((current) => items.length ? (current + 1) % items.length : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex((current) => items.length ? (current - 1 + items.length) % items.length : 0)
    } else if (event.key === 'Enter' && items.length > 0) {
      event.preventDefault()
      void execute(items[Math.min(selectedIndex, items.length - 1)]!)
    }
  }

  if (!open) return null
  let previousGroup = ''
  const activeItem = items.length > 0 ? items[Math.min(selectedIndex, items.length - 1)] : null
  return (
    <div className="palette-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onOpenChange(false) }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="palette-title">
        <h2 id="palette-title">Palette de commandes <kbd>Ctrl K</kbd></h2>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0) }}
          onKeyDown={handleInputKey}
          placeholder="Rechercher un fil, lancer une action…"
          aria-label="Recherche globale"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="palette-results"
          aria-expanded
          aria-activedescendant={activeItem ? `palette-option-${encodeURIComponent(activeItem.id)}` : undefined}
        />
        {error ? <p className="palette-error" role="alert">{error}</p> : null}
        <div id="palette-results" className="palette-results" role="listbox" aria-label="Résultats de recherche et commandes">
          {items.length === 0 ? <p className="palette-empty">Aucun résultat.</p> : items.map((item, index) => {
            const showGroup = item.group !== previousGroup
            previousGroup = item.group
            return (
              <div key={item.id}>
                {showGroup ? <h3>{item.group}</h3> : null}
                <button
                  type="button"
                  id={`palette-option-${encodeURIComponent(item.id)}`}
                  className={index === selectedIndex ? 'is-selected' : ''}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => void execute(item)}
                  disabled={busyId !== null}
                  role="option"
                  aria-selected={index === selectedIndex}
                >
                  <span>{busyId === item.id ? 'Exécution…' : item.label}</span>
                  <small>{item.detail}</small>
                </button>
              </div>
            )
          })}
        </div>
        <footer><span><kbd>↑↓</kbd> naviguer</span><span><kbd>Entrée</kbd> ouvrir</span><span><kbd>Échap</kbd> fermer</span></footer>
      </section>
    </div>
  )
}

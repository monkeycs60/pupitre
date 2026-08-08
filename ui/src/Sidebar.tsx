import { useEffect, useState } from 'react'
import {
  listProjectConversations,
  listProjectWorkflows,
  renameConversation,
  runWorkflow,
  setConversationArchived,
  setConversationDeleted,
  setConversationPinned,
  setConversationPermissionMode,
} from './api'
import { QuotaStatus } from './QuotaBar'
import type { Conversation, GamificationSnapshot, Project, Workflow, WorkspaceView } from './types'
import type { Quotas } from './useQuotas'
import type { GamificationPulse } from './useGamification'
import { WorkflowDialog } from './WorkflowDialog'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { modelLabel } from './modelOptions'
import { filterWorkflows, workflowSummary } from './workflowSidebar'

declare global {
  interface Window {
    __TAURI__?: Record<string, unknown>
  }
}

interface SidebarProps {
  selectedProject: Project | null
  selectedConversation: Conversation | null
  onProjectSelect: (project: Project) => void
  onConversationSelect: (conversation: Conversation) => void
  onConversationCreate: () => void
  onConversationClosed?: () => void
  conversationListVersion: number
  quotas: Quotas
  /** Sous-tâches en cours dans la conversation ouverte (cf. App). */
  runningSubtasks: number
  workspaceView: WorkspaceView
  onProgressSelect: () => void
  gamification: GamificationSnapshot | null
  xpPulse: GamificationPulse | null
}

function pinnedFirst<T extends { pinned: boolean }>(items: T[]): T[] {
  return [...items].sort((left, right) => Number(right.pinned) - Number(left.pinned))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue.'
}

function conversationRelation(
  conversation: Conversation,
  conversations: Conversation[],
): string | null {
  if (conversation.continued_from) {
    const source = conversations.find((item) => item.id === conversation.continued_from)
    return `↳ suite de ${source?.title ?? 'la conversation précédente'}`
  }
  const continuation = conversations.find(
    (item) => item.continued_from === conversation.id,
  )
  return continuation ? `→ passation vers ${continuation.title}` : null
}

type ConversationScope = 'active' | 'archived' | 'trash'
type SidebarTab = 'conversations' | 'workflows'

function relativeConversationTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value))
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'à l’instant'
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  const days = Math.floor(hours / 24)
  return days < 7 ? `il y a ${days} j` : new Date(value).toLocaleDateString('fr-FR')
}

/** Horodatage compact aligné à droite de chaque conversation (now / 4 min /
 *  2 h / lun / 08/06), comme dans la maquette. */
function shortConversationTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value))
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.floor(hours / 24)
  if (days < 7) {
    return new Date(value).toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '')
  }
  return new Date(value).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
}

type ConversationGroup = { key: string; label: string; items: Conversation[] }

/** Regroupe les conversations par récence (épinglées d'abord), comme la
 *  maquette : Épinglées / Aujourd'hui / Cette semaine / Plus ancien. */
function groupConversations(items: Conversation[]): ConversationGroup[] {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()
  const weekMs = 7 * 86_400_000
  const groups: ConversationGroup[] = [
    { key: 'pinned', label: 'Épinglées', items: [] },
    { key: 'today', label: "Aujourd'hui", items: [] },
    { key: 'week', label: 'Cette semaine', items: [] },
    { key: 'older', label: 'Plus ancien', items: [] },
  ]
  for (const conversation of items) {
    if (conversation.pinned) {
      groups[0]!.items.push(conversation)
      continue
    }
    const updated = Date.parse(conversation.updated_at)
    if (updated >= todayMs) groups[1]!.items.push(conversation)
    else if (Date.now() - updated < weekMs) groups[2]!.items.push(conversation)
    else groups[3]!.items.push(conversation)
  }
  return groups.filter((group) => group.items.length > 0)
}

export function Sidebar({
  selectedProject,
  selectedConversation,
  onProjectSelect,
  onConversationSelect,
  onConversationCreate,
  onConversationClosed,
  conversationListVersion,
  quotas,
  runningSubtasks,
  workspaceView,
  onProgressSelect,
  gamification,
  xpPulse,
}: SidebarProps) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isRunningWorkflow, setIsRunningWorkflow] = useState<string | null>(null)
  const [showWorkflowDialog, setShowWorkflowDialog] = useState(false)
  const [workflowToEdit, setWorkflowToEdit] = useState<Workflow | null>(null)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('conversations')
  const [conversationScope, setConversationScope] = useState<ConversationScope>('active')
  const [filterText, setFilterText] = useState('')
  const [workflowFilterText, setWorkflowFilterText] = useState('')
  const [openConversationMenu, setOpenConversationMenu] = useState<string | null>(null)
  const [renameConversationId, setRenameConversationId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [projectSettingsProject, setProjectSettingsProject] = useState<Project | null>(null)

  useEffect(() => {
    let ignore = false
    setConversations([])
    setWorkflows([])

    if (selectedProject === null) return

    void Promise.all([
      listProjectConversations(selectedProject.id, conversationScope),
      listProjectWorkflows(selectedProject.id),
    ])
      .then(([items, loadedWorkflows]) => {
        if (!ignore) {
          setConversations(pinnedFirst(items))
          setWorkflows(loadedWorkflows)
        }
      })
      .catch((loadError: unknown) => {
        if (!ignore) setError(errorMessage(loadError))
      })

    return () => {
      ignore = true
    }
  }, [selectedProject, conversationListVersion, conversationScope])

  useEffect(() => {
    setSidebarTab('conversations')
    setFilterText('')
    setWorkflowFilterText('')
    setWorkflowToEdit(null)
    setShowWorkflowDialog(false)
  }, [selectedProject?.id])

  function handleProjectSettings(project: Project) {
    setProjectSettingsProject(project)
  }

  function handleProjectSettingsUpdated(updated: Project) {
    if (selectedProject?.id === updated.id) onProjectSelect(updated)
  }

  async function handleConversationPin(conversation: Conversation) {
    setError(null)
    try {
      await setConversationPinned(conversation.id, !conversation.pinned)
      const updated = { ...conversation, pinned: !conversation.pinned }
      setConversations((current) =>
        pinnedFirst(
          current.map((item) => (item.id === conversation.id ? updated : item)),
        ),
      )
      if (selectedConversation?.id === conversation.id) {
        onConversationSelect(updated)
      }
    } catch (pinError: unknown) {
      setError(errorMessage(pinError))
    }
  }

  async function handleConversationYolo(conversation: Conversation) {
    const enabling = conversation.permission_mode !== 'bypassPermissions'
    if (enabling && !window.confirm(
      `Activer YOLO pour « ${conversation.title} » ?\n\nClaude ignorera les demandes de permission pour les tours suivants.`,
    )) return
    setError(null)
    try {
      const updated = await setConversationPermissionMode(
        conversation.id,
        enabling ? 'bypassPermissions' : null,
      )
      setConversations((current) => current.map((item) => item.id === updated.id ? updated : item))
      if (selectedConversation?.id === updated.id) onConversationSelect(updated)
    } catch (permissionError: unknown) {
      setError(errorMessage(permissionError))
    }
  }

  function closeConversationMenu() {
    setOpenConversationMenu(null)
    setRenameConversationId(null)
    setRenameDraft('')
  }

  function startRename(conversation: Conversation) {
    setOpenConversationMenu(null)
    setRenameConversationId(conversation.id)
    setRenameDraft(conversation.title)
  }

  async function handleRenameSubmit(conversation: Conversation) {
    const title = renameDraft.trim()
    if (!title) return
    setError(null)
    try {
      const updated = await renameConversation(conversation.id, title)
      setConversations((current) => current.map((item) => item.id === updated.id ? updated : item))
      if (selectedConversation?.id === updated.id) onConversationSelect(updated)
      closeConversationMenu()
    } catch (renameError: unknown) {
      setError(errorMessage(renameError))
    }
  }

  async function handleArchiveToggle(conversation: Conversation) {
    setError(null)
    try {
      const updated = await setConversationArchived(conversation.id, !conversation.archived)
      setConversations((current) => conversationScope === 'active' && updated.archived
        ? current.filter((item) => item.id !== updated.id)
        : conversationScope === 'archived' && !updated.archived
          ? current.filter((item) => item.id !== updated.id)
          : current.map((item) => item.id === updated.id ? updated : item))
      if (updated.archived && selectedConversation?.id === updated.id) onConversationClosed?.()
      closeConversationMenu()
    } catch (archiveError: unknown) {
      setError(errorMessage(archiveError))
    }
  }

  async function handleTrashToggle(conversation: Conversation) {
    setError(null)
    try {
      const updated = await setConversationDeleted(conversation.id, conversationScope !== 'trash')
      if (conversationScope === 'trash' || updated.deleted_at !== null) {
        setConversations((current) => current.filter((item) => item.id !== updated.id))
      } else {
        setConversations((current) => current.map((item) => item.id === updated.id ? updated : item))
      }
      if (updated.deleted_at !== null && selectedConversation?.id === updated.id) onConversationClosed?.()
      closeConversationMenu()
    } catch (trashError: unknown) {
      setError(errorMessage(trashError))
    }
  }

  function openWorkflowDialog(workflow: Workflow | null = null) {
    setWorkflowToEdit(workflow)
    setShowWorkflowDialog(true)
  }

  async function handleWorkflowRun(workflow: Workflow) {
    if (isRunningWorkflow !== null) return
    setError(null)
    setIsRunningWorkflow(workflow.id)
    try {
      const conversation = await runWorkflow(workflow.id)
      setSidebarTab('conversations')
      onConversationSelect(conversation)
    } catch (runError: unknown) {
      setError(errorMessage(runError))
    } finally {
      setIsRunningWorkflow(null)
    }
  }


  return (
    <aside className="sidebar">
      <div className="conv-sidebar-header">
        <div className="conv-sidebar-project">
          <div className="conv-sidebar-name">
            {selectedProject ? selectedProject.name : 'Aucun projet'}
          </div>
          <div className="conv-sidebar-path" title={selectedProject?.path}>
            {selectedProject ? selectedProject.path : 'Choisis un projet dans le rail'}
          </div>
        </div>
        {selectedProject ? (
          <button
            type="button"
            className="conv-sidebar-gear"
            onClick={() => handleProjectSettings(selectedProject)}
            aria-label={`Paramètres de ${selectedProject.name}`}
            title="Paramètres du projet"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <g stroke="currentColor" strokeWidth="1.25">
                <circle cx="8" cy="8" r="2" />
                <path d="M6.5 2h3l.5 2a4.5 4.5 0 0 1 1.3.8l1.9-.7 1.5 2.6-1.5 1.3a5 5 0 0 1 0 1.6l1.5 1.3-1.5 2.6-1.9-.7a4.5 4.5 0 0 1-1.3.8l-.5 2h-3l-.5-2a4.5 4.5 0 0 1-1.3-.8l-1.9.7-1.5-2.6 1.5-1.3a5 5 0 0 1 0-1.6L1.3 6.7l1.5-2.6 1.9.7A4.5 4.5 0 0 1 6 4l.5-2Z" />
              </g>
            </svg>
          </button>
        ) : null}
      </div>

      <section className="sidebar-section conversations" aria-label="Navigation du projet">
        <div className="sidebar-tabs" role="tablist" aria-label="Contenu de la sidebar">
          <button
            id="sidebar-conversations-tab"
            type="button"
            role="tab"
            aria-selected={sidebarTab === 'conversations'}
            aria-controls="sidebar-conversations-panel"
            className={sidebarTab === 'conversations' ? 'is-selected' : ''}
            onClick={() => setSidebarTab('conversations')}
          >
            Conversations <span>{conversations.length}</span>
          </button>
          <button
            id="sidebar-workflows-tab"
            type="button"
            role="tab"
            aria-selected={sidebarTab === 'workflows'}
            aria-controls="sidebar-workflows-panel"
            className={sidebarTab === 'workflows' ? 'is-selected' : ''}
            onClick={() => setSidebarTab('workflows')}
          >
            Workflows <span>{workflows.length}</span>
          </button>
        </div>

        {sidebarTab === 'conversations' ? (
          <div id="sidebar-conversations-panel" role="tabpanel" aria-labelledby="sidebar-conversations-tab">
        {/* Deux libellés entiers ne tiennent pas à côté du titre dans la largeur
            de la sidebar : ils se tronquaient. Ils ont leur propre rangée. */}
        <div className="section-actions">
          <button
            type="button"
            className="section-action section-action--primary"
            onClick={onConversationCreate}
            disabled={selectedProject === null}
            title="Démarrer une nouvelle conversation dans ce projet"
          >
            <span aria-hidden="true">+</span>
            <span>Nouvelle conversation</span>
          </button>
        </div>

        <div className="conversation-filter-input">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <circle cx="7" cy="7" r="4.2" />
              <path d="m10.2 10.2 3 3" />
            </g>
          </svg>
          <input
            type="text"
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder={`Filtrer ${conversations.length} conversation${conversations.length > 1 ? 's' : ''}…`}
            aria-label="Filtrer les conversations"
          />
        </div>

        <div className="conversation-filters" role="tablist" aria-label="Vue des conversations">
          {([['active', 'Actives'], ['archived', 'Archives'], ['trash', 'Corbeille']] as const).map(([scope, label]) => (
            <button
              type="button"
              key={scope}
              role="tab"
              aria-selected={conversationScope === scope}
              className={conversationScope === scope ? 'is-selected' : ''}
              onClick={() => {
                closeConversationMenu()
                setConversationScope(scope)
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="navigation-list">
          {selectedProject === null ? (
            <p className="list-empty">Sélectionnez un projet</p>
          ) : conversations.length === 0 ? (
            <p className="list-empty">Aucune conversation</p>
          ) : (() => {
            const query = filterText.trim().toLowerCase()
            const filtered = query
              ? conversations.filter((item) => item.title.toLowerCase().includes(query))
              : conversations
            if (filtered.length === 0) {
              return <p className="list-empty">Aucune conversation ne correspond</p>
            }
            return groupConversations(filtered).map((group) => (
              <div className="conv-group" key={group.key}>
                <div className="conv-group-header">
                  <span>{group.label}</span>
                  <span className="conv-group-rule" aria-hidden="true" />
                  <span className="conv-group-count">{group.items.length}</span>
                </div>
                {group.items.map((conversation) => {
                const complexity = gamification?.conversations[conversation.id]
                const isSelected = workspaceView === 'conversations'
                  && selectedConversation?.id === conversation.id
                const isLive = isSelected && runningSubtasks > 0
                return (
              <div
                className={`navigation-row ${isSelected ? 'is-selected' : ''}`}
                key={conversation.id}
              >
                <button
                  type="button"
                  className="navigation-main"
                  onClick={() => onConversationSelect(conversation)}
                  aria-describedby={`conversation-preview-${conversation.id}`}
                >
                  <span className="conv-row-line1">
                    <span
                      className={`conv-row-dot ${isLive ? 'is-live' : ''}`}
                      aria-hidden="true"
                    />
                    <span className="conv-row-title">{conversation.title}</span>
                    <span className="conv-row-time">
                      {shortConversationTime(conversation.updated_at)}
                    </span>
                  </span>
                  <span className="conv-row-line2">
                    <span className={`conversation-prov is-${conversation.provider}`}>
                      {conversation.provider.toUpperCase()}
                    </span>
                    <span className="conv-row-model">
                      {modelLabel(conversation.model)} · {conversation.effort ?? 'default'}
                      {conversation.speed === 'fast' ? ' · rapide' : ''}
                    </span>
                    {complexity ? (
                      <span
                        className="conversation-complexity"
                        title={`${complexity.commits} commit(s) · ×${complexity.multiplier.toLocaleString('fr-FR')}`}
                      >
                        C{complexity.complexity}
                      </span>
                    ) : null}
                  </span>
                  {conversationRelation(conversation, conversations) ? (
                    <span className="conversation-link">
                      {conversationRelation(conversation, conversations)}
                    </span>
                  ) : null}
                </button>
                <div className="conversation-row-actions">
                  <button
                    type="button"
                    className={`pin-button ${conversation.pinned ? 'is-pinned' : ''}`}
                    onClick={() => void handleConversationPin(conversation)}
                    aria-label={conversation.pinned ? `Désépingler ${conversation.title}` : `Épingler ${conversation.title}`}
                    aria-pressed={conversation.pinned}
                    title={conversation.pinned ? 'Désépingler' : 'Épingler'}
                  >
                    <span aria-hidden="true">{conversation.pinned ? '◆' : '◇'}</span>
                  </button>
                  <button
                    type="button"
                    className="conversation-more-button"
                    aria-label={`Actions pour ${conversation.title}`}
                    aria-expanded={openConversationMenu === conversation.id}
                    onClick={() => setOpenConversationMenu((current) => current === conversation.id ? null : conversation.id)}
                  >
                    <span aria-hidden="true">⋯</span>
                  </button>
                  {openConversationMenu === conversation.id ? (
                    <div className="conversation-actions-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => startRename(conversation)}>Renommer</button>
                      <button type="button" role="menuitem" onClick={() => void handleConversationYolo(conversation)}>
                        {conversation.permission_mode === 'bypassPermissions'
                          ? 'Désactiver YOLO'
                          : 'Activer YOLO'}
                      </button>
                      <button type="button" role="menuitem" onClick={() => void handleArchiveToggle(conversation)}>
                        {conversation.archived ? 'Désarchiver' : 'Archiver'}
                      </button>
                      {conversationScope === 'trash' ? (
                        <button type="button" role="menuitem" onClick={() => void handleTrashToggle(conversation)}>Restaurer</button>
                      ) : (
                        <button type="button" role="menuitem" className="is-danger" onClick={() => void handleTrashToggle(conversation)}>Mettre à la corbeille</button>
                      )}
                    </div>
                  ) : null}
                </div>
                {renameConversationId === conversation.id ? (
                  <form className="conversation-rename-form" onSubmit={(event) => { event.preventDefault(); void handleRenameSubmit(conversation) }}>
                    <input
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      aria-label={`Nouveau titre pour ${conversation.title}`}
                      autoFocus
                      onKeyDown={(event) => { if (event.key === 'Escape') closeConversationMenu() }}
                    />
                    <button type="submit">OK</button>
                  </form>
                ) : null}
                <div
                  className="conversation-hover-preview"
                  role="tooltip"
                  id={`conversation-preview-${conversation.id}`}
                >
                  <strong>{conversation.title}</strong>
                  <p>{conversation.summary || conversation.title}</p>
                  <span>{conversation.provider} · {modelLabel(conversation.model)} · {relativeConversationTime(conversation.updated_at)}</span>
                </div>
              </div>
                )
                })}
              </div>
            ))
          })()}
        </div>
          </div>
        ) : (
          <div id="sidebar-workflows-panel" className="workflow-sidebar-panel" role="tabpanel" aria-labelledby="sidebar-workflows-tab">
            <div className="section-actions">
              <button
                type="button"
                className="section-action section-action--primary"
                onClick={() => openWorkflowDialog()}
                disabled={selectedProject === null}
                title="Créer un workflow réutilisable pour ce projet"
              >
                <span aria-hidden="true">+</span>
                <span>Nouveau workflow</span>
              </button>
            </div>

            <div className="conversation-filter-input">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <circle cx="7" cy="7" r="4.2" />
                  <path d="m10.2 10.2 3 3" />
                </g>
              </svg>
              <input
                type="text"
                value={workflowFilterText}
                onChange={(event) => setWorkflowFilterText(event.target.value)}
                placeholder={`Filtrer ${workflows.length} workflow${workflows.length > 1 ? 's' : ''}…`}
                aria-label="Filtrer les workflows"
              />
            </div>

            {selectedProject === null ? (
              <p className="list-empty">Sélectionnez un projet</p>
            ) : workflows.length === 0 ? (
              <p className="list-empty">Aucun workflow. Créez un raccourci pour vos tâches répétitives.</p>
            ) : (() => {
              const filtered = filterWorkflows(workflows, workflowFilterText)
              return filtered.length === 0 ? (
                <p className="list-empty">Aucun workflow ne correspond</p>
              ) : (
                <div className="workflow-sidebar-list">
                  {filtered.map((workflow) => (
                    <article className="workflow-sidebar-row" key={workflow.id}>
                      <div className="workflow-sidebar-copy">
                        <strong>{workflow.name}</strong>
                        <p title={workflowSummary(workflow)}>{workflowSummary(workflow)}</p>
                        <span><code>${workflow.skill_invocation}</code> · {workflow.preset_id ? 'preset' : modelLabel(workflow.model)}</span>
                      </div>
                      <div className="workflow-sidebar-actions">
                        <button type="button" onClick={() => void handleWorkflowRun(workflow)} disabled={isRunningWorkflow !== null}>
                          {isRunningWorkflow === workflow.id ? 'Lancement…' : 'Lancer →'}
                        </button>
                        <button type="button" onClick={() => openWorkflowDialog(workflow)} aria-label={`Modifier ${workflow.name}`} title="Modifier ce workflow">✎</button>
                      </div>
                    </article>
                  ))}
                </div>
              )
            })()}
          </div>
        )}
      </section>

      {error && (
        <p className="sidebar-error" role="alert">
          {error}
        </p>
      )}

      {showWorkflowDialog && selectedProject ? (
        <WorkflowDialog
          key={selectedProject.id}
          project={selectedProject}
          workflows={workflows}
          initialWorkflow={workflowToEdit}
          onClose={() => {
            setShowWorkflowDialog(false)
            setWorkflowToEdit(null)
          }}
          onChanged={setWorkflows}
        />
      ) : null}

      {projectSettingsProject ? (
        <ProjectSettingsDialog
          key={projectSettingsProject.id}
          project={projectSettingsProject}
          onClose={() => setProjectSettingsProject(null)}
          onUpdated={handleProjectSettingsUpdated}
        />
      ) : null}

      <div className="sidebar-footer">
        {gamification ? (
          <button
            type="button"
            className="level-card"
            onClick={onProgressSelect}
            title="Voir la progression et le rapport hebdomadaire"
          >
            {(() => {
              const ringLen = 110
              const offset = ringLen * (1 - Math.max(0, Math.min(1, gamification.progress)))
              const band = Math.max(1, gamification.nextLevelXp - gamification.levelXp)
              const remaining = Math.max(0, Math.round(band * (1 - gamification.progress)))
              const activeMin = Math.floor(gamification.activeMsToday / 60_000)
              return (
                <>
                  <span className="level-ring" aria-hidden="true">
                    <svg width="42" height="42" viewBox="0 0 42 42">
                      <circle cx="21" cy="21" r="17.5" fill="none" stroke="var(--border)" strokeWidth="4" />
                      <circle
                        cx="21"
                        cy="21"
                        r="17.5"
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth="4"
                        strokeLinecap="round"
                        strokeDasharray={ringLen}
                        strokeDashoffset={offset}
                        transform="rotate(-90 21 21)"
                      />
                    </svg>
                    <span className="level-ring-value">{gamification.level}</span>
                  </span>
                  <span className="level-info">
                    <span className="level-info-top">
                      <strong>Niveau {gamification.level}</strong>
                      <span>{remaining.toLocaleString('fr-FR')} XP restants</span>
                    </span>
                    <span className="level-bar" aria-hidden="true">
                      <span className="level-bar-fill" style={{ width: `${gamification.progress * 100}%` }} />
                      <span className="level-bar-sheen" />
                    </span>
                    <span className="level-meta">
                      {activeMin} min · aujourd'hui
                    </span>
                  </span>
                </>
              )
            })()}
            {xpPulse ? (
              <span className="xp-pulse" key={xpPulse.id} aria-live="polite">+{xpPulse.amount} XP</span>
            ) : null}
          </button>
        ) : null}
        <div className="sidebar-quotas">
          <QuotaStatus snapshot={quotas.snapshot} />
        </div>
      </div>
    </aside>
  )
}

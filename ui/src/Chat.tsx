import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { EventStream } from './EventStream'
import { useGroupedEvents } from './useGroupedEvents'
import { retryCountdownSeconds } from './backoff'
import { Lightbox } from './Lightbox'
import { Composer } from './Composer'
import type { ConversationConfig } from './ConfigPanel'
import { modelLabel } from './modelOptions'
import { createSessionSummary, createTestInventory, startReview } from './api'
import type { ComposerAction } from './ComposerPalette'
import type {
  AppEvent,
  Attachment,
  Conversation,
  Project,
  QuotaSnapshot,
  SubtaskStatus,
  ReviewStatusSnapshot,
} from './types'
import { GuardianLine } from './GuardianLine'
import { ContextGauge } from './ContextGauge'
import type { ConnectionState } from './useConversationEvents'
import { useNow } from './useNow'
import { appendDebriefQuestionPrompt } from './debriefQuestion'
import type { DebriefBlock } from './groupEvents'
import { TaskSelectionContext, TaskToggleContext } from './taskToggle'
import type { TaskAction } from './taskToggle'
import { toggleAction, withTaskActions } from './taskDraft'
import { newConversationDraftStorageKey } from './conversationDraft'
import { ThreadSearch } from './ThreadSearch'
import { PushTimeline } from './PushTimeline'
import { ProblemSuggestionsLoader } from './ProblemSuggestions'
import type { ProblemMissionSeed } from './problemMission'
import { collectConversationAssets } from './conversationAssets'
import { ConversationAssetsDrawer } from './ConversationAssetsDrawer'

interface ChatProps {
  events: AppEvent[]
  connection: ConnectionState
  retryAt: number | null
  conversation: Conversation | null
  project: Project
  quotas: QuotaSnapshot
  onConversationCreated: (conversation: Conversation) => void
  onProjectUpdated: (project: Project) => void
  onConversationRead?: () => void
  /** Nombre de sous-tâches en cours dans ce fil (indicateur sidebar). */
  onRunningSubtasksChange?: (count: number) => void
  initialMessage?: string
  initialAttachments?: Attachment[]
  initialConfig?: Partial<ConversationConfig>
  ticketId?: string | null
  originType?: 'sentry' | 'problem' | null
  originKey?: string | null
  problemPlanIndex?: number | null
  problemIds?: string[]
  problemPlanIndices?: Record<string, number[]>
  missionTitle?: string
  onStartProblem?: (seed: ProblemMissionSeed) => void
  onSeeAllProblems?: () => void
  reviewStatus: ReviewStatusSnapshot | null
  onHandoff: () => void
  onSwitchModel: () => void
}

interface LightboxImage {
  src: string
  alt: string
}

function readDraft(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function lastStatusIsRunning(events: AppEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'status') return event.state === 'running'
  }
  return false
}

/** Des réponses sont arrivées depuis le dernier résumé de session. */
export function hasUnsummarizedWork(events: AppEvent[]): boolean {
  let lastSummary = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'session-summary-ref') { lastSummary = index; break }
  }
  return events.slice(lastSummary + 1).some((event) => event.type === 'text-final')
}

function SessionSummaryAction({ conversationId, unsummarized }: {
  conversationId: string
  unsummarized: boolean
}) {
  const [isCreating, setIsCreating] = useState(false)

  async function handleClick() {
    if (isCreating) return
    setIsCreating(true)
    try {
      await createSessionSummary(conversationId)
    } catch {
      // Le fil affiche déjà l'erreur du sidecar ; le bouton redevient actif.
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <span className="turn-summary-actions">
      <button
      type="button"
      className={`turn-summary-button${unsummarized ? ' is-catalog' : ''}`}
      onClick={() => void handleClick()}
      disabled={isCreating}
      title="Résumer la session dans le fil"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <g stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 2.5h6.5L13 5v8.5H4v-11Z" />
          <path d="M6 7h5M6 9.5h5" />
        </g>
      </svg>
      {isCreating ? 'Résumé en cours…' : 'Résumé de session'}
      </button>
    </span>
  )
}

function ReconnectBanner({ retryAt }: { retryAt: number | null }) {
  const now = useNow(1_000)
  const retryIn = retryCountdownSeconds(retryAt, now)
  return (
    <p className="connection-banner" role="status">
      Connexion perdue · nouvelle tentative
      {retryIn === null || retryIn === 0 ? ' maintenant' : ` dans ${retryIn} s`}
    </p>
  )
}

export function Chat({
  events,
  connection,
  retryAt,
  conversation,
  project,
  quotas,
  onConversationCreated,
  onProjectUpdated,
  onConversationRead,
  onRunningSubtasksChange,
  initialMessage = '',
  initialAttachments = [],
  initialConfig,
  ticketId = null,
  originType = null,
  originKey = null,
  problemPlanIndex = null,
  problemIds,
  problemPlanIndices,
  missionTitle,
  onStartProblem,
  onSeeAllProblems,
  reviewStatus,
  onHandoff,
  onSwitchModel,
}: ChatProps) {
  const draftStorageKey = conversation === null
    ? newConversationDraftStorageKey(project.id, ticketId, originType, originKey, problemPlanIndex, problemIds)
    : `pupitre:draft:${conversation.id}`
  const blocks = useGroupedEvents(conversation?.id ?? null, events)
  const isRunning = lastStatusIsRunning(events)
  const unsummarized = useMemo(() => hasUnsummarizedWork(events), [events])
  const viewportRef = useRef<HTMLDivElement>(null)
  const followsBottomRef = useRef(true)
  const scrollFrameRef = useRef<number | null>(null)
  const onConversationReadRef = useRef(onConversationRead)
  onConversationReadRef.current = onConversationRead
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null)
  const [message, setMessage] = useState(() => readDraft(draftStorageKey) ?? initialMessage)
  const [searchOpen, setSearchOpen] = useState(false)
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [focusRequest, setFocusRequest] = useState(0)
  /** Actions *DO THIS* cochées dans le fil, source de la consigne composée. */
  const [selectedActions, setSelectedActions] = useState<TaskAction[]>([])
  // Le premier rendu ne doit rien recomposer : il effacerait le bloc d'un
  // brouillon restauré depuis le stockage local.
  const actionsSynced = useRef(false)
  const [subtaskStatuses, setSubtaskStatuses] = useState<
    Record<string, SubtaskStatus>
  >({})
  const conversationAssets = useMemo(() => collectConversationAssets(events), [events])

  useEffect(() => {
    try {
      if (message.trim().length === 0) localStorage.removeItem(draftStorageKey)
      else localStorage.setItem(draftStorageKey, message)
    } catch {
      // Le brouillon reste disponible en mémoire si le stockage local est bloqué.
    }
  }, [draftStorageKey, message])

  function handleConversationCreated(created: Conversation) {
    try {
      localStorage.removeItem(draftStorageKey)
    } catch {
      // Rien à faire si le stockage local est indisponible.
    }
    onConversationCreated(created)
  }

  // Les cartes remontent leur statut (null = démontée) : le fil est la seule
  // source de vérité sur les sous-tâches en vol, y compris pour la sidebar.
  const handleSubtaskStatusChange = useCallback(
    (subtaskId: string, status: SubtaskStatus | null) => {
      setSubtaskStatuses((current) => {
        if (status === null) {
          if (!(subtaskId in current)) return current
          const { [subtaskId]: _removed, ...rest } = current
          return rest
        }
        if (current[subtaskId] === status) return current
        return { ...current, [subtaskId]: status }
      })
    },
    [],
  )

  const runningSubtasks = Object.values(subtaskStatuses).filter(
    (status) => status === 'running',
  ).length

  useEffect(() => {
    onRunningSubtasksChange?.(runningSubtasks)
    return () => onRunningSubtasksChange?.(0)
  }, [runningSubtasks, onRunningSubtasksChange])

  const scrollToBottomIfFollowing = useCallback(() => {
    const viewport = viewportRef.current
    if (viewport !== null && followsBottomRef.current) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [])

  useLayoutEffect(scrollToBottomIfFollowing, [blocks, scrollToBottomIfFollowing])

  const handleImageOpen = useCallback((src: string, alt: string) => {
    setLightboxImage({ src, alt })
  }, [])

  const handleLightboxClose = useCallback(() => {
    setLightboxImage(null)
  }, [])

  useEffect(() => {
    if (!actionsSynced.current) {
      actionsSynced.current = true
      return
    }
    setMessage((draft) => withTaskActions(draft, selectedActions))
    setFocusRequest((current) => current + 1)
  }, [selectedActions])

  function handleScroll() {
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      const viewport = viewportRef.current
      if (viewport === null) return
      const followsBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 64
      followsBottomRef.current = followsBottom
      setAtBottom((current) => current === followsBottom ? current : followsBottom)
      if (followsBottom) onConversationReadRef.current?.()
    })
  }

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  useEffect(() => {
    function handleSearchShortcut(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handleSearchShortcut)
    return () => window.removeEventListener('keydown', handleSearchShortcut)
  }, [])

  // useCallback obligatoire : une identité instable ici casserait la
  // mémoïsation d'EventStream et annulerait tout le gain.
  const handleDebriefQuestion = useCallback((block: DebriefBlock) => {
    setMessage((current) => appendDebriefQuestionPrompt(current, block))
    setFocusRequest((current) => current + 1)
  }, [])

  function jumpToBottom() {
    followsBottomRef.current = true
    setAtBottom(true)
    scrollToBottomIfFollowing()
    onConversationRead?.()
  }

  /**
   * Case cochée dans un bloc *DO THIS* : la sélection est recomposée en entier
   * pour que l'en-tête du message reste juste (« actions 2 et 4 »).
   */
  const handleTaskToggle = useCallback((action: TaskAction, checked: boolean) => {
    setSelectedActions((current) => toggleAction(current, action, checked))
    onConversationReadRef.current?.()
  }, [])

  function handleMessageChange(next: string) {
    setMessage(next)
    if (next.length === 0) setSelectedActions([])
  }

  const relire = useCallback(() => {
    if (!conversation) return
    void startReview({ conversationId: conversation.id, scope: 'worktree' }).catch(() => {})
  }, [conversation])

  // Identité stable exigée : ce fragment est une prop d'EventStream, et un JSX
  // inline recréé à chaque frappe dans le composer annulait son memo() — le
  // fil entier était reconstruit à chaque touche.
  const turnFooterAction = useMemo(() => (
    conversation !== null && !isRunning ? (
      <>
        <ContextGauge conversation={conversation} events={events} onHandoff={onHandoff} />
        <SessionSummaryAction
          conversationId={conversation.id}
          unsummarized={unsummarized}
        />
      </>
    ) : undefined
  ), [conversation, isRunning, events, unsummarized, onHandoff])

  async function handleComposerAction(action: ComposerAction) {
    if (!conversation) return
    if (action === 'review') {
      await startReview({ conversationId: conversation.id, scope: 'worktree' }).catch(() => {})
      return
    }
    if (action === 'test') {
      await createTestInventory(conversation.id).catch(() => {})
      return
    }
    if (action === 'switch-model') {
      onSwitchModel()
      return
    }
    if (action === 'handoff') {
      onHandoff()
      return
    }
    await createSessionSummary(conversation.id).catch(() => null)
  }
  return (
    <>
      <div
        className="chat-layout"
        onPointerDownCapture={() => onConversationReadRef.current?.()}
        onKeyDownCapture={() => onConversationReadRef.current?.()}
      >
        <div className="chat-main">
          {connection === 'reconnecting' ? (
            <ReconnectBanner retryAt={retryAt} />
          ) : null}

          <div className="events-shell">
            <ThreadSearch
              viewportRef={viewportRef}
              open={searchOpen}
              onOpen={() => setSearchOpen(true)}
              onClose={() => setSearchOpen(false)}
              contentVersion={events.length}
            />
            {!searchOpen ? (
              <ConversationAssetsDrawer
                assets={conversationAssets}
                open={assetsOpen}
                onOpen={() => setAssetsOpen(true)}
                onClose={() => setAssetsOpen(false)}
                onImageOpen={handleImageOpen}
              />
            ) : null}
            {!atBottom ? (
              <button type="button" className="thread-jump" onClick={jumpToBottom} title="Aller au dernier message">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 3v9M4.5 8.5 8 12l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Dernier message
              </button>
            ) : null}
          <div className="events-view" ref={viewportRef} onScroll={handleScroll}>
            <div className="events-list" aria-live="polite">
              {blocks.length === 0 ? (
                <p className="events-empty">
                  {conversation === null
                    ? 'Écrivez un premier message pour créer la conversation.'
                    : 'Aucun événement dans cette conversation.'}
                </p>
              ) : (
                <TaskToggleContext.Provider value={handleTaskToggle}>
                  <TaskSelectionContext.Provider value={selectedActions}>
                    <EventStream
                      blocks={blocks}
                      onImageOpen={handleImageOpen}
                      onImageLoad={scrollToBottomIfFollowing}
                      onSubtaskStatusChange={handleSubtaskStatusChange}
                      onDebriefQuestion={handleDebriefQuestion}
                      turnFooterAction={turnFooterAction}
                      conversationId={conversation?.id}
                    />
                    {conversation ? <PushTimeline projectId={project.id} conversationId={conversation.id} /> : null}
                    {!isRunning && conversation !== null ? (
                      <GuardianLine
                        conversation={conversation}
                        project={project}
                        reviewStatus={reviewStatus}
                        onRelire={relire}
                      />
                    ) : null}
                  </TaskSelectionContext.Provider>
                </TaskToggleContext.Provider>
              )}
            </div>
          </div>
          </div>

          {conversation === null && onStartProblem && onSeeAllProblems ? (
            <ProblemSuggestionsLoader
              projectId={project.id}
              onSelect={onStartProblem}
              onSeeAll={onSeeAllProblems}
            />
          ) : null}

          <Composer
            conversationId={conversation?.id ?? null}
            project={project}
            quotas={quotas}
            isRunning={isRunning}
            onConversationCreated={handleConversationCreated}
            onProjectUpdated={onProjectUpdated}
            message={message}
            onMessageChange={handleMessageChange}
            focusRequest={focusRequest}
            providerLabel={conversation
              ? `${modelLabel(conversation.model)} · ${conversation.effort ?? 'default'}${conversation.speed === 'fast' ? ' · rapide' : ''}`
              : null}
            provider={conversation?.provider ?? null}
            initialConfig={initialConfig}
            initialAttachments={initialAttachments}
            ticketId={ticketId}
            originType={originType}
            originKey={originKey}
            problemPlanIndex={problemPlanIndex}
            problemIds={problemIds}
            problemPlanIndices={problemPlanIndices}
            missionTitle={missionTitle}
            onAction={(action) => void handleComposerAction(action)}
          />
        </div>
      </div>

      {lightboxImage !== null ? (
        <Lightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          onClose={handleLightboxClose}
        />
      ) : null}
    </>
  )
}

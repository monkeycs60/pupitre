import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { EventStream } from './EventStream'
import { groupEvents } from './groupEvents'
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
  ChangelogReview,
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
import { TaskToggleContext } from './taskToggle'
import type { TaskAction } from './taskToggle'
import { toggleAction, withTaskActions } from './taskDraft'
import { newConversationDraftStorageKey } from './conversationDraft'
import { ThreadSearch } from './ThreadSearch'

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
  originType?: 'sentry' | null
  originKey?: string | null
  reviewStatus: ReviewStatusSnapshot | null
  onOpenCode: (flagId?: string) => void
  onHandoff: () => void
  pendingChangelogReview: ChangelogReview | null
  onChangelogReview: (review: ChangelogReview) => void
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

/** Des réponses sont arrivées depuis le dernier résumé : le bouton de fin de
 *  tour passe en mode « Cataloguer » (résumé + revue de changelog). */
export function hasUncataloguedWork(events: AppEvent[]): boolean {
  let lastSummary = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'session-summary-ref') { lastSummary = index; break }
  }
  return events.slice(lastSummary + 1).some((event) => event.type === 'text-final')
}

function SessionSummaryAction({ conversationId, uncatalogued, pendingReview, onChangelogReview }: {
  conversationId: string
  uncatalogued: boolean
  pendingReview: ChangelogReview | null
  onChangelogReview: (review: ChangelogReview) => void
}) {
  const [isCreating, setIsCreating] = useState(false)

  async function handleClick() {
    if (isCreating) return
    setIsCreating(true)
    try {
      const result = await createSessionSummary(conversationId)
      if (result.review) onChangelogReview(result.review)
    } catch {
      // Le fil affiche déjà l'erreur du sidecar ; le bouton redevient actif.
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <span className="turn-summary-actions">
      {pendingReview ? (
        <button type="button" className="turn-summary-button is-catalog" onClick={() => onChangelogReview(pendingReview)}>
          Reprendre la validation
          <span className="turn-summary-pill">{pendingReview.changes.filter((change) => change.selected).length}</span>
        </button>
      ) : null}
      <button
      type="button"
      className={`turn-summary-button${uncatalogued ? ' is-catalog' : ''}`}
      onClick={() => void handleClick()}
      disabled={isCreating}
      title={uncatalogued
        ? 'Résumer la session et cataloguer les changements dans le changelog'
        : 'Résumer la session dans le fil'}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <g stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 2.5h6.5L13 5v8.5H4v-11Z" />
          <path d="M6 7h5M6 9.5h5" />
        </g>
      </svg>
      {isCreating ? 'Résumé en cours…' : 'Résumé de session'}
      {!isCreating && uncatalogued ? <span className="turn-summary-pill">changelog</span> : null}
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
  reviewStatus,
  onOpenCode,
  onHandoff,
  pendingChangelogReview,
  onChangelogReview,
  onSwitchModel,
}: ChatProps) {
  const draftStorageKey = conversation === null
    ? newConversationDraftStorageKey(project.id, ticketId)
    : `pupitre:draft:${conversation.id}`
  const blocks = useMemo(() => groupEvents(events), [events])
  const isRunning = lastStatusIsRunning(events)
  const uncatalogued = useMemo(() => hasUncataloguedWork(events), [events])
  const viewportRef = useRef<HTMLDivElement>(null)
  const followsBottomRef = useRef(true)
  const onConversationReadRef = useRef(onConversationRead)
  onConversationReadRef.current = onConversationRead
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null)
  const [message, setMessage] = useState(() => readDraft(draftStorageKey) ?? initialMessage)
  const [searchOpen, setSearchOpen] = useState(false)
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
    const viewport = viewportRef.current
    if (viewport === null) return

    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    followsBottomRef.current = distanceFromBottom <= 64
    setAtBottom(followsBottomRef.current)
    if (followsBottomRef.current) onConversationRead?.()
  }

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
          uncatalogued={uncatalogued}
          pendingReview={pendingChangelogReview}
          onChangelogReview={onChangelogReview}
        />
      </>
    ) : undefined
  ), [conversation, isRunning, events, uncatalogued, pendingChangelogReview, onHandoff, onChangelogReview])

  async function handleComposerAction(action: ComposerAction) {
    if (!conversation) return
    if (action === 'review') {
      await startReview({ conversationId: conversation.id, scope: 'worktree' }).catch(() => {})
      onOpenCode()
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
    const result = await createSessionSummary(conversation.id).catch(() => null)
    if (result?.review) onChangelogReview(result.review)
  }
  return (
    <>
      <div className="chat-layout">
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
                  <EventStream
                    blocks={blocks}
                    onImageOpen={handleImageOpen}
                    onImageLoad={scrollToBottomIfFollowing}
                    onSubtaskStatusChange={handleSubtaskStatusChange}
                    onDebriefQuestion={handleDebriefQuestion}
                    turnFooterAction={turnFooterAction}
                  />
                  {!isRunning && conversation !== null ? (
                    <GuardianLine
                      conversation={conversation}
                      project={project}
                      reviewStatus={reviewStatus}
                      onOpenCode={onOpenCode}
                      onRelire={relire}
                    />
                  ) : null}
                </TaskToggleContext.Provider>
              )}
            </div>
          </div>
          </div>

          <Composer
            conversationId={conversation?.id ?? null}
            project={project}
            quotas={quotas}
            isRunning={isRunning}
            onConversationCreated={handleConversationCreated}
            onProjectUpdated={onProjectUpdated}
            message={message}
            onMessageChange={setMessage}
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

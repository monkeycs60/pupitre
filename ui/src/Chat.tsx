import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { FormEvent } from 'react'
import { EventStream } from './EventStream'
import { groupEvents } from './groupEvents'
import { retryCountdownSeconds } from './backoff'
import { Lightbox } from './Lightbox'
import { Composer } from './Composer'
import { modelLabel } from './modelOptions'
import type {
  AppEvent,
  Attachment,
  Conversation,
  Project,
  QuotaSnapshot,
  SkillSuggestion,
  SubtaskStatus,
} from './types'
import type { ConnectionState } from './useConversationEvents'
import { useNow } from './useNow'
import { appendDebriefQuestionPrompt } from './debriefQuestion'
import type { DebriefBlock } from './groupEvents'
import { SkillsSuggestionsPanel } from './SkillsSuggestionsPanel'
import { latestUserText, withSkillInvocation } from './skillSuggestionDraft'
import { TaskToggleContext } from './taskToggle'
import type { TaskAction } from './taskToggle'
import { toggleAction, withTaskActions } from './taskDraft'

declare global {
  interface Window {
    find?: (text: string, caseSensitive?: boolean, backwards?: boolean, wrapAround?: boolean) => boolean
  }
}

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
  /** Multiplicateur XP du tour (complexité × focus), voir turnXp.ts. */
  turnXpMultiplier?: number
  onReviewChanges?: () => void
}

interface LightboxImage {
  src: string
  alt: string
}

const SKILLS_PANEL_KEY = 'pupitre:skills-panel-open'

function initialSkillsPanelOpen(): boolean {
  try {
    return localStorage.getItem(SKILLS_PANEL_KEY) === 'true'
  } catch {
    return false
  }
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
  turnXpMultiplier,
  onReviewChanges,
}: ChatProps) {
  const draftStorageKey = `pupitre:draft:${conversation?.id ?? `new:${project.id}`}`
  const blocks = useMemo(() => groupEvents(events), [events])
  const previousUserText = useMemo(() => latestUserText(events), [events])
  const isRunning = lastStatusIsRunning(events)
  const viewportRef = useRef<HTMLDivElement>(null)
  const followsBottomRef = useRef(true)
  const onConversationReadRef = useRef(onConversationRead)
  onConversationReadRef.current = onConversationRead
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null)
  const [message, setMessage] = useState(() => readDraft(draftStorageKey) ?? initialMessage)
  const [findQuery, setFindQuery] = useState('')
  const [focusRequest, setFocusRequest] = useState(0)
  const [skillsPanelOpen, setSkillsPanelOpen] = useState(initialSkillsPanelOpen)
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
    if (followsBottomRef.current) onConversationRead?.()
  }

  // useCallback obligatoire : une identité instable ici casserait la
  // mémoïsation d'EventStream et annulerait tout le gain.
  const handleDebriefQuestion = useCallback((block: DebriefBlock) => {
    setMessage((current) => appendDebriefQuestionPrompt(current, block))
    setFocusRequest((current) => current + 1)
  }, [])

  function handleSkillsPanelToggle() {
    setSkillsPanelOpen((current) => {
      const next = !current
      try {
        localStorage.setItem(SKILLS_PANEL_KEY, String(next))
      } catch {
        // La préférence reste en mémoire si le stockage web est indisponible.
      }
      return next
    })
  }

  function handleFind(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = findQuery.trim()
    if (!query) return
    if (typeof window.find === 'function') window.find(query, false, false, true)
  }

  function jumpToBottom() {
    followsBottomRef.current = true
    scrollToBottomIfFollowing()
    onConversationRead?.()
  }

  function handleSkillLaunch(skill: SkillSuggestion) {
    setMessage((current) => withSkillInvocation(current, skill.invocation))
    setFocusRequest((current) => current + 1)
  }

  /**
   * Case cochée dans un bloc *DO THIS* : la sélection est recomposée en entier
   * pour que l'en-tête du message reste juste (« actions 2 et 4 »).
   */
  const handleTaskToggle = useCallback((action: TaskAction, checked: boolean) => {
    setSelectedActions((current) => toggleAction(current, action, checked))
    onConversationReadRef.current?.()
  }, [])

  const suggestionText = message.trim() || previousUserText

  return (
    <>
      <div className={`chat-layout ${skillsPanelOpen ? 'has-suggestions' : ''}`}>
        <div className="chat-main">
          {connection === 'reconnecting' ? (
            <ReconnectBanner retryAt={retryAt} />
          ) : null}

          <div className="conversation-toolbar" aria-label="Navigation dans la conversation">
            <form className="conversation-search" onSubmit={handleFind}>
              <label className="sr-only" htmlFor="conversation-find">Rechercher dans le fil</label>
              <input
                id="conversation-find"
                value={findQuery}
                onChange={(event) => setFindQuery(event.target.value)}
                placeholder="Rechercher dans le fil"
              />
              <button type="submit" aria-label="Rechercher" title="Rechercher dans le fil">⌕</button>
            </form>
            <button type="button" className="conversation-jump" onClick={jumpToBottom} title="Aller au dernier message">
              Dernier message
            </button>
          </div>

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
                    turnXpMultiplier={turnXpMultiplier}
                    onReviewChanges={onReviewChanges}
                  />
                </TaskToggleContext.Provider>
              )}
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
              ? `${conversation.provider} · ${modelLabel(conversation.model)} · ${conversation.effort ?? 'default'}${conversation.speed === 'fast' ? ' · rapide' : ''}`
              : null}
            initialAttachments={initialAttachments}
          />
        </div>
        <SkillsSuggestionsPanel
          projectId={project.id}
          text={suggestionText}
          open={skillsPanelOpen}
          onToggle={handleSkillsPanelToggle}
          onLaunch={handleSkillLaunch}
        />
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

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
import type {
  AppEvent,
  Conversation,
  Project,
  QuotaSnapshot,
  SubtaskStatus,
} from './types'
import type { ConnectionState } from './useConversationEvents'
import { useNow } from './useNow'

interface ChatProps {
  events: AppEvent[]
  connection: ConnectionState
  retryAt: number | null
  conversation: Conversation | null
  project: Project
  quotas: QuotaSnapshot
  onConversationCreated: (conversation: Conversation) => void
  onProjectUpdated: (project: Project) => void
  /** Nombre de sous-tâches en cours dans ce fil (indicateur sidebar). */
  onRunningSubtasksChange?: (count: number) => void
}

interface LightboxImage {
  src: string
  alt: string
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
  onRunningSubtasksChange,
}: ChatProps) {
  const blocks = useMemo(() => groupEvents(events), [events])
  const isRunning = lastStatusIsRunning(events)
  const viewportRef = useRef<HTMLDivElement>(null)
  const followsBottomRef = useRef(true)
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null)
  const [subtaskStatuses, setSubtaskStatuses] = useState<
    Record<string, SubtaskStatus>
  >({})

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

  function handleScroll() {
    const viewport = viewportRef.current
    if (viewport === null) return

    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    followsBottomRef.current = distanceFromBottom <= 64
  }

  return (
    <>
      {connection === 'reconnecting' ? (
        <ReconnectBanner retryAt={retryAt} />
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
            <EventStream
              blocks={blocks}
              onImageOpen={handleImageOpen}
              onImageLoad={scrollToBottomIfFollowing}
              onSubtaskStatusChange={handleSubtaskStatusChange}
            />
          )}
        </div>
      </div>

      <Composer
        conversationId={conversation?.id ?? null}
        project={project}
        quotas={quotas}
        isRunning={isRunning}
        onConversationCreated={onConversationCreated}
        onProjectUpdated={onProjectUpdated}
      />

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

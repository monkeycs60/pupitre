import { useEffect, useState } from 'react'
import { cancelSubtask, getSubtask } from './api'
import { EventStream, groupEvents } from './EventStream'
import type { SubtaskBlock } from './EventStream'
import type { StoredEvent, Subtask, SubtaskStatus } from './types'
import { useConversationEvents } from './useConversationEvents'
import { useNow } from './useNow'

interface SubtaskCardProps {
  block: SubtaskBlock
  onImageOpen: (src: string, alt: string) => void
  onImageLoad: () => void
  /** Remonte l'état de la carte (null au démontage) : cf. l'indicateur sidebar. */
  onStatusChange?: (subtaskId: string, status: SubtaskStatus | null) => void
}

const STATUS_LABELS: Record<SubtaskStatus, string> = {
  running: 'en cours',
  done: 'terminé',
  error: 'échec',
}

/** Dernier `status` du flux : c'est lui qui fait foi tant que la carte est vivante. */
function lastStatus(events: StoredEvent[]): SubtaskStatus | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'status') return event.state
  }
  return null
}

function totalTokens(events: StoredEvent[]): { input: number; output: number } | null {
  let input = 0
  let output = 0
  let seen = false

  for (const event of events) {
    if (event.type !== 'usage') continue
    seen = true
    input += event.inputTokens
    output += event.outputTokens
  }

  return seen ? { input, output } : null
}

function errorText(events: StoredEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'status' && event.state === 'error') {
      return event.error ?? 'Une erreur est survenue.'
    }
  }
  return null
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`

  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

function elapsedMs(subtask: Subtask | null, isRunning: boolean, now: number): number | null {
  if (subtask === null) return null

  const start = Date.parse(subtask.created_at)
  if (Number.isNaN(start)) return null

  if (isRunning) return now - start

  const end = Date.parse(subtask.updated_at)
  return Number.isNaN(end) ? null : end - start
}

/**
 * Carte inline d'une sous-tâche déléguée, repliée par défaut : badge, label,
 * statut live, durée, annulation. Dépliée, elle affiche le transcript complet de
 * la sous-tâche avec les mêmes blocs que le fil principal.
 *
 * Le flux est abonné même repliée : c'est ce qui rend le statut et la durée
 * vivants sans polling.
 */
export function SubtaskCard({
  block,
  onImageOpen,
  onImageLoad,
  onStatusChange,
}: SubtaskCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [subtask, setSubtask] = useState<Subtask | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [isCancelling, setIsCancelling] = useState(false)
  const { events } = useConversationEvents(block.subtaskId, 'subtask')

  const status = lastStatus(events) ?? subtask?.status ?? 'running'
  const isRunning = status === 'running'
  // Une seconde pendant le tour (la durée défile), une demi-minute ensuite.
  const now = useNow(isRunning ? 1_000 : 30_000)

  // Métadonnées persistées (effort, vitesse, horodatages) : chargées au montage
  // puis rechargées à chaque changement de statut pour récupérer l'heure de fin.
  useEffect(() => {
    const controller = new AbortController()

    void getSubtask(block.subtaskId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSubtask(result.subtask)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.error(error)
      })

    return () => controller.abort()
  }, [block.subtaskId, status])

  // L'indicateur « sous-tâche en cours » de la sidebar se nourrit de cette
  // remontée : l'information vit dans le fil, pas dans une API dédiée.
  useEffect(() => {
    onStatusChange?.(block.subtaskId, status)
    return () => onStatusChange?.(block.subtaskId, null)
  }, [block.subtaskId, status, onStatusChange])

  const blocks = groupEvents(events)
  const tokens = totalTokens(events)
  const duration = elapsedMs(subtask, isRunning, now)
  const failure = status === 'error' ? errorText(events) : null

  const badge = [
    block.provider,
    block.model,
    subtask?.effort ?? null,
    subtask?.speed === 'fast' ? 'rapide' : null,
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ')

  async function handleCancel() {
    setIsCancelling(true)
    setCancelError(null)
    try {
      await cancelSubtask(block.subtaskId)
    } catch (error: unknown) {
      setCancelError(
        error instanceof Error ? error.message : 'Annulation impossible.',
      )
    } finally {
      setIsCancelling(false)
    }
  }

  return (
    <section className={`subtask-card is-${status}`} aria-label={`Sous-tâche ${badge}`}>
      <header className="subtask-card-header">
        <button
          type="button"
          className="subtask-card-toggle"
          onClick={() => setIsExpanded((expanded) => !expanded)}
          aria-expanded={isExpanded}
        >
          <span className="subtask-caret" aria-hidden="true">
            {isExpanded ? '▾' : '▸'}
          </span>
          <span className="subtask-badge">{badge}</span>
          <span className="subtask-label">
            {block.label ?? subtask?.prompt ?? 'Sous-tâche déléguée'}
          </span>
        </button>

        <span className={`subtask-status is-${status}`} role="status">
          <span aria-hidden="true">
            {isRunning ? '●' : status === 'done' ? '✓' : '✗'}
          </span>{' '}
          {STATUS_LABELS[status]}
        </span>

        {duration !== null ? (
          <span className="subtask-duration">{formatDuration(duration)}</span>
        ) : null}

        {isRunning ? (
          <button
            type="button"
            className="subtask-cancel"
            onClick={() => void handleCancel()}
            disabled={isCancelling}
            aria-label="Annuler la sous-tâche"
            title="Annuler la sous-tâche"
          >
            ✕
          </button>
        ) : null}
      </header>

      {failure !== null ? (
        <p className="subtask-error" role="alert">
          {failure}
        </p>
      ) : null}

      {cancelError !== null ? (
        <p className="subtask-error" role="alert">
          {cancelError}
        </p>
      ) : null}

      {isExpanded ? (
        <div className="subtask-transcript">
          {blocks.length === 0 ? (
            <p className="subtask-empty">Aucun événement pour l'instant.</p>
          ) : (
            <EventStream
              blocks={blocks}
              onImageOpen={onImageOpen}
              onImageLoad={onImageLoad}
            />
          )}
        </div>
      ) : null}

      {tokens !== null ? (
        <footer className="subtask-footer">
          <span className="usage">
            {tokens.input.toLocaleString('fr-FR')} →{' '}
            {tokens.output.toLocaleString('fr-FR')} tokens
          </span>
        </footer>
      ) : null}
    </section>
  )
}

import { useEffect, useState } from 'react'
import { cancelSubtask, getSubtask } from './api'
import { EventStream } from './EventStream'
import { groupEvents, type SubtaskBlock } from './groupEvents'
import {
  lastStreamStatus,
  shouldStreamSubtask,
  subtaskFailure,
  subtaskStatus,
} from './subtaskStream'
import type { StoredEvent, Subtask, SubtaskResult, SubtaskStatus } from './types'
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

const STATUS_ICONS: Record<SubtaskStatus, string> = {
  running: '●',
  done: '✓',
  error: '✗',
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
 * L'ordre est important : snapshot HTTP d'abord, WebSocket ENSUITE et seulement
 * si la carte est dépliée ou la sous-tâche encore en vol (cf. subtaskStream).
 * Une conversation qui a délégué trente fois ne tient donc pas trente sockets
 * ouverts sur des flux définitivement muets.
 */
export function SubtaskCard({
  block,
  onImageOpen,
  onImageLoad,
  onStatusChange,
}: SubtaskCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [snapshot, setSnapshot] = useState<SubtaskResult | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [isCancelling, setIsCancelling] = useState(false)

  const subtask: Subtask | null = snapshot?.subtask ?? null
  const isStreaming = shouldStreamSubtask(isExpanded, subtask?.status ?? null)
  const { events } = useConversationEvents(
    isStreaming ? block.subtaskId : null,
    'subtask',
  )

  // null tant que le snapshot n'est pas revenu : état neutre, pas « en cours ».
  const streamStatus = lastStreamStatus(events)
  const status = subtaskStatus(events, subtask?.status ?? null)
  const isRunning = status === 'running'
  // Une seconde pendant le tour (la durée défile), une demi-minute ensuite.
  const now = useNow(isRunning ? 1_000 : 30_000)

  // Métadonnées persistées (effort, vitesse, horodatages, cause d'échec) :
  // chargées au montage, puis rechargées quand le FLUX annonce un nouveau
  // statut — c'est ce qui rapatrie l'heure de fin sans refetch inutile pour une
  // carte qui n'est même pas abonnée.
  useEffect(() => {
    const controller = new AbortController()

    void getSubtask(block.subtaskId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSnapshot(result)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.error(error)
      })

    return () => controller.abort()
  }, [block.subtaskId, streamStatus])

  // L'indicateur « sous-tâche en cours » de la sidebar se nourrit de cette
  // remontée : l'information vit dans le fil, pas dans une API dédiée.
  useEffect(() => {
    onStatusChange?.(block.subtaskId, status)
    return () => onStatusChange?.(block.subtaskId, null)
  }, [block.subtaskId, status, onStatusChange])

  const blocks = groupEvents(events)
  const tokens = totalTokens(events)
  const duration = elapsedMs(subtask, isRunning, now)
  const failure = subtaskFailure(status, events, snapshot?.error ?? null)

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
    <section
      className={`subtask-card is-${status ?? 'loading'}`}
      aria-label={`Sous-tâche ${badge}`}
    >
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
            {block.label ?? 'Sous-tâche déléguée'}
          </span>
        </button>

        <span className={`subtask-status is-${status ?? 'loading'}`} role="status">
          <span aria-hidden="true">{status === null ? '…' : STATUS_ICONS[status]}</span>{' '}
          {status === null ? 'chargement' : STATUS_LABELS[status]}
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

      {subtask?.prompt ? (
        <details className="subtask-prompt">
          <summary>Consigne</summary>
          <p>{subtask.prompt}</p>
        </details>
      ) : null}

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

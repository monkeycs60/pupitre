import { memo } from 'react'
import Markdown from './Markdown'
import type { EventBlock } from './eventBlocks'
import type { Attachment } from './types'
import { mediaUrl } from './transport'
import { useNow } from './useNow'
import { AttachmentPreview } from './AttachmentPreview'
import { tokenXp } from './turnXp'
import { summarizeTurnError } from './turnError'

interface EventViewProps {
  block: EventBlock
  onImageOpen: (src: string, alt: string) => void
  onImageLoad: () => void
  turnXpMultiplier?: number
  onReviewChanges?: () => void
}

function formatPreValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''

  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function ImageGallery({
  images,
  label,
  onImageOpen,
  onImageLoad,
}: {
  images: string[]
  label: string
  onImageOpen: (src: string, alt: string) => void
  onImageLoad: () => void
}) {
  if (images.length === 0) return null

  return (
    <div className="event-images">
      {images.map((name, index) => {
        const src = mediaUrl(name)
        const alt = `${label} ${index + 1}`

        return (
          <button
            type="button"
            className="event-image-button"
            key={`${name}-${index}`}
            onClick={() => onImageOpen(src, alt)}
            aria-label={`Agrandir ${alt.toLocaleLowerCase('fr-FR')}`}
          >
            <img src={src} alt={alt} onLoad={onImageLoad} />
          </button>
        )
      })}
    </div>
  )
}

function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  const files = attachments.filter((attachment) => !attachment.mimeType.startsWith('image/'))
  if (files.length === 0) return null

  return (
    <div className="event-attachments" aria-label="Pièces jointes">
      {files.map((attachment) => <AttachmentPreview key={attachment.name} attachment={attachment} />)}
    </div>
  )
}

function formatDuration(ms: number): string {
  const safeMs = Math.max(0, ms)
  if (safeMs < 10_000) {
    return `${(safeMs / 1000).toLocaleString('fr-FR', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })} s`
  }
  const seconds = Math.round(safeMs / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`
}

function parsedTime(value: string | undefined): number | null {
  if (value === undefined) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

function basename(path: string): string {
  const segments = path.split(/[/\\]/)
  return segments.at(-1) || path
}

function TurnFiles({ files }: { files: Array<{ path: string; added: number; removed: number }> }) {
  if (files.length === 0) return null

  return (
    <div className="turn-files">
      {files.map((file) => (
        <span className="turn-file-chip" key={file.path}>
          <span className="turn-file-dot" aria-hidden="true" />
          {basename(file.path)}
          {file.added > 0 ? <span className="turn-file-added">+{file.added}</span> : null}
          {file.removed > 0 ? <span className="turn-file-removed">-{file.removed}</span> : null}
        </span>
      ))}
    </div>
  )
}

function TurnFooter({
  block,
  turnXpMultiplier,
  onReviewChanges,
}: {
  block: Extract<EventBlock, { kind: 'turn-footer' }>
  turnXpMultiplier?: number
  onReviewChanges?: () => void
}) {
  const isRunning = block.status?.state === 'running'
  const isDone = block.status?.state === 'done'
  const isError = block.status?.state === 'error'
  // Synchronisation avec l'horloge système : seul effet nécessaire au compteur.
  const now = useNow(isRunning ? 1_000 : 30_000)
  const startedAt = parsedTime(block.timing?.startedAt)
  const firstResponseAt = parsedTime(block.timing?.firstResponseAt)
  const completedAt = parsedTime(block.timing?.completedAt)
  const endAt = completedAt ?? (isRunning ? now : null)
  const firstResponseMs = startedAt !== null && firstResponseAt !== null
    ? firstResponseAt - startedAt
    : null
  const totalMs = startedAt !== null && endAt !== null ? endAt - startedAt : null
  const xp = block.usage !== undefined && turnXpMultiplier !== undefined
    ? Math.max(1, Math.round(tokenXp(block.usage.inputTokens, block.usage.outputTokens) * turnXpMultiplier))
    : null
  const turnError = isError
    ? summarizeTurnError(block.status?.error ?? 'Une erreur est survenue.')
    : null

  return (
    <footer className="turn-footer">
      {block.files ? <TurnFiles files={block.files} /> : null}
      {isError ? (
        <div className="turn-error" role="alert">
          <div>
            <span className="turn-error-label">Erreur</span>{' '}
            {turnError?.message}
          </div>
          {turnError?.details ? (
            <details className="turn-error-details">
              <summary>Détails techniques</summary>
              <pre>{turnError.details}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      <div className={`turn-meta${isDone ? ' turn-meta-done' : ''}`}>
        {isRunning ? (
          <span className="running-indicator" role="status">
            <span aria-hidden="true">●</span> en cours
          </span>
        ) : null}
        {isDone ? (
          <span className="done-indicator">
            <span aria-hidden="true">●</span> terminé
          </span>
        ) : null}
        {totalMs !== null ? (
          <span className="turn-timing">
            {firstResponseMs === null
              ? isRunning
                ? `attente ${formatDuration(totalMs)}`
                : `aucun retour · total ${formatDuration(totalMs)}`
              : `1er retour ${formatDuration(firstResponseMs)} · ${
                  isRunning ? 'durée' : 'total'
                } ${formatDuration(totalMs)}`}
          </span>
        ) : null}
        {block.usage ? (
          <span className="usage">
            {block.usage.inputTokens.toLocaleString('fr-FR')} →{' '}
            {block.usage.outputTokens.toLocaleString('fr-FR')} tokens
          </span>
        ) : null}
        {block.subtaskCount !== undefined ? (
          <span className="turn-subtasks" title="Agents délégués lancés depuis ce tour, un par tâche ou signalement">
            {block.subtaskCount} agent{block.subtaskCount > 1 ? 's' : ''} délégué{block.subtaskCount > 1 ? 's' : ''}
          </span>
        ) : null}
        {isDone && onReviewChanges ? (
          <button type="button" className="turn-review-action" onClick={onReviewChanges}>
            Lancer le Gardien
          </button>
        ) : null}
        {xp !== null ? <span className="turn-xp">+{xp} XP</span> : null}
      </div>
    </footer>
  )
}

/**
 * Mémoïsé : la frappe dans le composeur re-rend `Chat`, et sans ce garde-fou
 * chaque touche re-parsait le Markdown de TOUS les messages du fil.
 */
export const EventView = memo(EventViewImpl)

function EventViewImpl({ block, onImageOpen, onImageLoad, turnXpMultiplier, onReviewChanges }: EventViewProps) {
  switch (block.kind) {
    case 'user':
      return (
        <article className="message-row message-row-user">
          <div className="message-bubble user-message">
            {block.text ? <p>{block.text}</p> : null}
            <ImageGallery
              images={block.images}
              label="Image jointe"
              onImageOpen={onImageOpen}
              onImageLoad={onImageLoad}
            />
            <AttachmentList attachments={block.attachments} />
          </div>
        </article>
      )

    case 'assistant':
      return (
        <article className="message-row message-row-assistant">
          <div className="message-bubble assistant-message">
            <Markdown scope={block.id}>{block.text}</Markdown>
            {block.streaming ? (
              <span className="streaming-caret" aria-hidden="true" />
            ) : null}
          </div>
        </article>
      )

    case 'tool':
      return (
        <details className="tool-card">
          <summary>
            <span className="tool-card-chevron" aria-hidden="true" />
            <span className="tool-card-name">{block.toolName}</span>
            {block.output === undefined ? (
              <span className="tool-card-state">en cours</span>
            ) : null}
          </summary>
          <div className="tool-card-content">
            <div className="tool-section">
              <div className="tool-section-label">Entrée</div>
              <pre>{formatPreValue(block.input)}</pre>
            </div>
            {block.output !== undefined ? (
              <div className="tool-section">
                <div className="tool-section-label">Sortie</div>
                <pre>{block.output}</pre>
              </div>
            ) : (
              <p className="tool-running">Exécution en cours…</p>
            )}
            <ImageGallery
              images={block.images}
              label={`Image produite par ${block.toolName}`}
              onImageOpen={onImageOpen}
              onImageLoad={onImageLoad}
            />
          </div>
        </details>
      )

    case 'turn-footer': {
      return <TurnFooter block={block} turnXpMultiplier={turnXpMultiplier} onReviewChanges={onReviewChanges} />
    }
  }
}

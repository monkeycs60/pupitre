import { memo, type ReactNode } from 'react'
import Markdown from './Markdown'
import type { EventBlock } from './eventBlocks'
import type { Attachment } from './types'
import { mediaUrl } from './transport'
import { useNow } from './useNow'
import { AttachmentPreview } from './AttachmentPreview'
import { summarizeTurnError } from './turnError'
import { toolPresentation } from './toolPresentation'

interface EventViewProps {
  block: EventBlock
  onImageOpen: (src: string, alt: string) => void
  onImageLoad: () => void
  turnFooterAction?: ReactNode
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

/**
 * Libellé du tour en cours : « réfléchit » ouvre le tour, puis alterne avec
 * « écrit ». Ambiance temporelle, pas une télémétrie — le flux d'événements
 * ne distingue pas les phases, et la rotation suffit à rendre l'attente
 * vivante sans prétendre plus qu'elle ne sait.
 */
function runningLabel(totalMs: number | null): string {
  if (totalMs === null || totalMs < 6_000) return 'réfléchit…'
  return Math.floor(totalMs / 6_000) % 2 === 1 ? 'écrit…' : 'réfléchit…'
}

function TurnFooter({ block, action }: {
  block: Extract<EventBlock, { kind: 'turn-footer' }>
  action?: ReactNode
}) {
  const isRunning = block.status?.state === 'running'
  const isDone = block.status?.state === 'done'
  const isError = block.status?.state === 'error'
  // Synchronisation avec l'horloge système : seul effet nécessaire au compteur.
  // 100 ms en cours de tour : le dixième de seconde de formatDuration vit.
  const now = useNow(isRunning ? 100 : 30_000)
  const startedAt = parsedTime(block.timing?.startedAt)
  const completedAt = parsedTime(block.timing?.completedAt)
  const endAt = completedAt ?? (isRunning ? now : null)
  const totalMs = startedAt !== null && endAt !== null ? endAt - startedAt : null
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
            <span className="running-dots" aria-hidden="true"><i /><i /><i /></span>
            <span className="running-label" key={runningLabel(totalMs)}>{runningLabel(totalMs)}</span>
          </span>
        ) : null}
        {isDone ? (
          <span className="done-indicator">
            <span aria-hidden="true">●</span> terminé
          </span>
        ) : null}
        {totalMs !== null ? (
          <span className="turn-timing" title="Durée du run">
            {formatDuration(totalMs)}
          </span>
        ) : null}
        {block.subtaskCount !== undefined ? (
          <span className="turn-subtasks" title="Agents délégués lancés depuis ce tour, un par tâche ou signalement">
            {block.subtaskCount} agent{block.subtaskCount > 1 ? 's' : ''} délégué{block.subtaskCount > 1 ? 's' : ''}
          </span>
        ) : null}
        {action}
      </div>
    </footer>
  )
}

/**
 * Mémoïsé : la frappe dans le composeur re-rend `Chat`, et sans ce garde-fou
 * chaque touche re-parsait le Markdown de TOUS les messages du fil.
 */
export const EventView = memo(EventViewImpl)

function EventViewImpl({ block, onImageOpen, onImageLoad, turnFooterAction }: EventViewProps) {
  switch (block.kind) {
    case 'user':
      return (
        <article className="message-row message-row-user">
          <div className="message-bubble user-message">
            {block.steering ? <span className="message-steering-label">Ajouté au tour en cours</span> : null}
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
          {/* Le caret de streaming est un ::after du dernier bloc rendu : il
              suit le texte au caractère près au lieu de flotter dessous. */}
          <div className={`message-bubble assistant-message${block.streaming ? ' is-streaming' : ''}`}>
            <Markdown scope={block.id} onImageOpen={onImageOpen} onImageLoad={onImageLoad}>{block.text}</Markdown>
          </div>
        </article>
      )

    case 'tool': {
      const presentation = toolPresentation(block)
      const running = block.output === undefined
      return (
        <div className={`tool-activity${running ? ' is-running' : ''}`} role={running ? 'status' : undefined}>
          <svg className="tool-activity-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.75 3.25h3.5l1 1.25h6v8.25h-10.5z" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
            <path d="m6 7 1.5 1.5L6 10M9 10h2" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{presentation.label}{running ? ' en cours' : ' terminée'}</span>
          {presentation.detail ? <span className="tool-activity-detail" title={presentation.detail}>{presentation.detail}</span> : null}
        </div>
      )
    }

    case 'turn-footer': {
      return <TurnFooter block={block} action={turnFooterAction} />
    }
  }
}

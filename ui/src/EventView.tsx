import ReactMarkdown from 'react-markdown'
import type { EventBlock } from './eventBlocks'
import { mediaUrl } from './transport'

interface EventViewProps {
  block: EventBlock
  onImageOpen: (src: string, alt: string) => void
  onImageLoad: () => void
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

function ImageGallery({
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

export function EventView({ block, onImageOpen, onImageLoad }: EventViewProps) {
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
          </div>
        </article>
      )

    case 'assistant':
      return (
        <article className="message-row message-row-assistant">
          <div className="message-bubble assistant-message">
            <ReactMarkdown>{block.text}</ReactMarkdown>
            {block.streaming ? (
              <span className="streaming-caret" aria-hidden="true" />
            ) : null}
          </div>
        </article>
      )

    case 'tool':
      return (
        <details className="tool-card">
          <summary>🔧 {block.toolName}</summary>
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
      const isRunning = block.status?.state === 'running'
      const isError = block.status?.state === 'error'

      return (
        <footer className="turn-footer">
          {isError ? (
            <div className="turn-error" role="alert">
              {block.status?.error ?? 'Une erreur est survenue.'}
            </div>
          ) : null}
          <div className="turn-meta">
            {isRunning ? (
              <span className="running-indicator" role="status">
                <span aria-hidden="true">●</span> en cours
              </span>
            ) : null}
            {block.usage ? (
              <span className="usage">
                {block.usage.inputTokens.toLocaleString('fr-FR')} →{' '}
                {block.usage.outputTokens.toLocaleString('fr-FR')} tokens
              </span>
            ) : null}
          </div>
        </footer>
      )
    }
  }
}

import { useCallback, useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export type ZoomedMedia = {
  kind: 'image' | 'video'
  src: string
  alt: string
  time: number
}

export function embeddedPreviewUrl(url: string): string {
  return `${url}&embed=1`
}

function zoomedMediaOf(data: unknown): ZoomedMedia | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as Record<string, unknown>
  if (message.type !== 'pupitre:media-zoom') return null
  const kind = message.kind
  if (kind !== 'image' && kind !== 'video') return null
  if (typeof message.src !== 'string' || !message.src.startsWith(`data:${kind}/`)) return null
  return {
    kind,
    src: message.src,
    alt: typeof message.alt === 'string' ? message.alt : '',
    time: typeof message.time === 'number' && Number.isFinite(message.time) ? message.time : 0,
  }
}

export function useDocumentMediaZoom(iframeRef: RefObject<HTMLIFrameElement | null>) {
  const [media, setMedia] = useState<ZoomedMedia | null>(null)

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow
      if (!frame || event.source !== frame) return
      const next = zoomedMediaOf(event.data)
      if (next) setMedia(next)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [iframeRef])

  const close = useCallback(() => setMedia(null), [])
  return { media, close }
}

export function MediaLightbox({ media, onClose }: { media: ZoomedMedia; onClose: () => void }) {
  const [actualSize, setActualSize] = useState(false)

  useEffect(() => {
    // Capture : Échap ferme la visionneuse sans réduire le document plein écran dessous.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [onClose])

  return createPortal(
    <div
      className={`media-lightbox${actualSize ? ' is-actual-size' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={media.kind === 'image' ? 'Image agrandie' : 'Vidéo agrandie'}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <button type="button" className="media-lightbox-close" onClick={onClose} autoFocus>
        Fermer
      </button>
      {media.kind === 'image' ? (
        <img
          src={media.src}
          alt={media.alt}
          title={actualSize ? 'Ajuster à la fenêtre' : 'Taille réelle'}
          onClick={() => setActualSize((current) => !current)}
        />
      ) : (
        <video
          src={media.src}
          title={media.alt || undefined}
          controls
          autoPlay
          onLoadedMetadata={(event) => {
            event.currentTarget.currentTime = media.time
          }}
        />
      )}
    </div>,
    window.document.body,
  )
}

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export type ZoomedMedia = {
  kind: 'image' | 'video'
  src: string
  alt: string
  time: number
}

export type MediaGallery = {
  items: ZoomedMedia[]
  index: number
}

const MIN_SCALE = 1
const MAX_SCALE = 8
const CLICK_SCALE = 2.5

export function embeddedPreviewUrl(url: string): string {
  return `${url}&embed=1`
}

function mediaOf(data: unknown): ZoomedMedia | null {
  if (typeof data !== 'object' || data === null) return null
  const item = data as Record<string, unknown>
  const kind = item.kind
  if (kind !== 'image' && kind !== 'video') return null
  if (typeof item.src !== 'string' || !item.src.startsWith(`data:${kind}/`)) return null
  return {
    kind,
    src: item.src,
    alt: typeof item.alt === 'string' ? item.alt : '',
    time: typeof item.time === 'number' && Number.isFinite(item.time) ? item.time : 0,
  }
}

export function galleryOf(data: unknown): MediaGallery | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as Record<string, unknown>
  if (message.type !== 'pupitre:media-zoom' || !Array.isArray(message.items)) return null
  if (typeof message.index !== 'number') return null
  const clicked = mediaOf(message.items[message.index])
  if (!clicked) return null
  const items: ZoomedMedia[] = []
  let index = 0
  message.items.forEach((raw, position) => {
    const item = position === message.index ? clicked : mediaOf(raw)
    if (!item) return
    if (position === message.index) index = items.length
    items.push(item)
  })
  return { items, index }
}

export function useDocumentMediaZoom(iframeRef: RefObject<HTMLIFrameElement | null>) {
  const [gallery, setGallery] = useState<MediaGallery | null>(null)

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow
      if (!frame || event.source !== frame) return
      const next = galleryOf(event.data)
      if (next) setGallery(next)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [iframeRef])

  const close = useCallback(() => setGallery(null), [])
  return { gallery, close }
}

type View = { scale: number; x: number; y: number }

const FIT: View = { scale: 1, x: 0, y: 0 }

function zoomAt(view: View, nextScale: number, image: HTMLImageElement, clientX: number, clientY: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale))
  if (scale === MIN_SCALE) return FIT
  // offsetLeft ignore la transformation : plusieurs crans de molette peuvent arriver avant le rendu.
  const frame = (image.offsetParent ?? image).getBoundingClientRect()
  const cursorX = clientX - frame.left - image.offsetLeft
  const cursorY = clientY - frame.top - image.offsetTop
  const ratio = scale / view.scale
  return { scale, x: cursorX - (cursorX - view.x) * ratio, y: cursorY - (cursorY - view.y) * ratio }
}

export function comparedPair(items: ZoomedMedia[], index: number): [number, number] | null {
  if (items[index]?.kind !== 'video') return null
  if (items[index + 1]?.kind === 'video') return [index, index + 1]
  if (items[index - 1]?.kind === 'video') return [index - 1, index]
  return null
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

const DRIFT_SECONDS = 0.25

function MediaCompare({ left, right }: { left: ZoomedMedia; right: ZoomedMedia }) {
  const leftRef = useRef<HTMLVideoElement>(null)
  const rightRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)

  const videos = useCallback(
    () => [leftRef.current, rightRef.current].filter((video): video is HTMLVideoElement => video !== null),
    [],
  )

  const play = useCallback(() => {
    const all = videos()
    if (all.every((video) => video.ended)) for (const video of all) video.currentTime = 0
    for (const video of all) if (!video.ended) void video.play().catch(() => {})
    setPlaying(true)
  }, [videos])

  const pause = useCallback(() => {
    for (const video of videos()) video.pause()
    setPlaying(false)
  }, [videos])

  const seek = useCallback((seconds: number) => {
    for (const video of videos()) video.currentTime = Math.min(seconds, video.duration || seconds)
    setTime(seconds)
  }, [videos])

  useEffect(() => {
    play()
    const toggle = (event: KeyboardEvent) => {
      if (event.key !== ' ') return
      event.preventDefault()
      event.stopPropagation()
      if (videos().some((video) => !video.paused)) pause()
      else play()
    }
    window.addEventListener('keydown', toggle, true)
    return () => window.removeEventListener('keydown', toggle, true)
  }, [pause, play, videos])

  const follow = () => {
    const all = videos()
    const leader = all.find((video) => !video.ended)
    if (!leader) {
      setPlaying(false)
      setTime(Math.max(...all.map((video) => video.currentTime)))
      return
    }
    for (const video of all) {
      if (video === leader || video.ended || leader.currentTime > video.duration) continue
      if (Math.abs(video.currentTime - leader.currentTime) > DRIFT_SECONDS) video.currentTime = leader.currentTime
    }
    setTime(Math.max(...all.map((video) => video.currentTime)))
  }

  const sides: [ZoomedMedia, RefObject<HTMLVideoElement | null>][] = [[left, leftRef], [right, rightRef]]
  return (
    <div className="media-compare">
      <div className="media-compare-videos">
        {sides.map(([media, ref], side) => (
          <figure key={side}>
            <figcaption>{media.alt || (side === 0 ? 'Gauche' : 'Droite')}</figcaption>
            <video
              ref={ref}
              src={media.src}
              muted
              playsInline
              onTimeUpdate={follow}
              onEnded={follow}
              onLoadedMetadata={(event) => {
                const loaded = event.currentTarget.duration
                if (Number.isFinite(loaded)) setDuration((current) => Math.max(current, loaded))
              }}
              onClick={() => (playing ? pause() : play())}
            />
          </figure>
        ))}
      </div>
      <div className="media-compare-controls">
        <button type="button" onClick={() => (playing ? pause() : play())}>
          {playing ? 'Pause' : 'Lire les deux'}
        </button>
        <button type="button" onClick={() => { seek(0); play() }}>Revoir</button>
        <input
          type="range"
          aria-label="Position dans les deux vidéos"
          min={0}
          max={duration || 0}
          step={0.05}
          value={Math.min(time, duration || 0)}
          onChange={(event) => seek(Number(event.currentTarget.value))}
        />
        <span>{clock(time)} / {clock(duration)}</span>
      </div>
    </div>
  )
}

export function MediaLightbox({ gallery, onClose }: { gallery: MediaGallery; onClose: () => void }) {
  const [index, setIndex] = useState(gallery.index)
  const [compare, setCompare] = useState(false)
  const [view, setView] = useState<View>(FIT)
  const overlayRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const drag = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number; moved: boolean } | null>(null)
  const media = gallery.items[index]
  const count = gallery.items.length

  const go = useCallback((step: number) => {
    if (count < 2) return
    setIndex((current) => (current + step + count) % count)
    setView(FIT)
    setCompare(false)
  }, [count])

  useEffect(() => {
    // Capture : ces touches pilotent la visionneuse avant le fil et le document plein écran dessous.
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft') go(-1)
      else if (event.key === 'ArrowRight') go(1)
      else if (event.key === '0') setView(FIT)
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [go, onClose])

  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return
    // Écouteur natif : React enregistre la molette en passif, preventDefault y serait ignoré.
    const zoomOnWheel = (event: WheelEvent) => {
      event.preventDefault()
      const image = imageRef.current
      if (!image) return
      setView((current) => zoomAt(current, current.scale * Math.exp(-event.deltaY * 0.0015), image, event.clientX, event.clientY))
    }
    overlay.addEventListener('wheel', zoomOnWheel, { passive: false })
    return () => overlay.removeEventListener('wheel', zoomOnWheel)
  }, [])

  if (!media) return null
  const zoomed = view.scale > MIN_SCALE
  const pair = comparedPair(gallery.items, index)
  const comparing = compare && pair !== null

  return createPortal(
    <div
      ref={overlayRef}
      className="media-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={comparing ? 'Vidéos côte à côte' : media.kind === 'image' ? 'Image agrandie' : 'Vidéo agrandie'}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <button type="button" className="media-lightbox-close" onClick={onClose} autoFocus>
        Fermer
      </button>
      {pair ? (
        <button type="button" className="media-lightbox-mode" aria-pressed={comparing} onClick={() => setCompare((current) => !current)}>
          {comparing ? 'Vue simple' : '⇆ Côte à côte'}
        </button>
      ) : null}
      {comparing ? (
        <MediaCompare left={gallery.items[pair[0]]!} right={gallery.items[pair[1]]!} />
      ) : media.kind === 'image' ? (
        <img
          key={index}
          ref={imageRef}
          src={media.src}
          alt={media.alt}
          draggable={false}
          className={zoomed ? 'is-zoomed' : undefined}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          onPointerDown={(event) => {
            if (!zoomed) return
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: view.x, y: view.y, moved: false }
          }}
          onPointerMove={(event) => {
            const current = drag.current
            if (!current || current.pointerId !== event.pointerId) return
            const dx = event.clientX - current.startX
            const dy = event.clientY - current.startY
            if (Math.abs(dx) + Math.abs(dy) > 3) current.moved = true
            setView((previous) => ({ ...previous, x: current.x + dx, y: current.y + dy }))
          }}
          onPointerUp={() => {
            const current = drag.current
            if (current && !current.moved) drag.current = null
          }}
          onClick={(event) => {
            if (drag.current?.moved) {
              drag.current = null
              return
            }
            const image = event.currentTarget
            setView((current) => current.scale > MIN_SCALE ? FIT : zoomAt(current, CLICK_SCALE, image, event.clientX, event.clientY))
          }}
        />
      ) : (
        <video
          key={index}
          src={media.src}
          title={media.alt || undefined}
          controls
          autoPlay
          onLoadedMetadata={(event) => {
            event.currentTarget.currentTime = media.time
          }}
        />
      )}
      {count > 1 ? (
        <>
          <button type="button" className="media-lightbox-nav is-previous" aria-label="Média précédent" onClick={() => go(-1)}>‹</button>
          <button type="button" className="media-lightbox-nav is-next" aria-label="Média suivant" onClick={() => go(1)}>›</button>
        </>
      ) : null}
      <p className="media-lightbox-caption">
        {count > 1 ? <span>{comparing ? `${pair[0] + 1}–${pair[1] + 1}` : index + 1} / {count}</span> : null}
        {zoomed ? <span>{Math.round(view.scale * 100)} %</span> : null}
        {media.alt && !comparing ? <span>{media.alt}</span> : null}
      </p>
    </div>,
    window.document.body,
  )
}

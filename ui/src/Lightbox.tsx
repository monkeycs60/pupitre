import { useEffect, useRef, useState } from 'react'
import type { PointerEvent, WheelEvent } from 'react'

interface LightboxProps {
  alt: string
  src: string
  onClose: () => void
}

export function Lightbox({ alt, src, onClose }: LightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })

  useEffect(() => {
    closeRef.current?.focus()
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
      if (event.key === '+' || event.key === '=') setScale((current) => Math.min(5, current + 0.5))
      if (event.key === '-') setScale((current) => Math.max(1, current - 0.5))
      if (event.key === '0') {
        setScale(1)
        setOffset({ x: 0, y: 0 })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    if (scale === 1) setOffset({ x: 0, y: 0 })
  }, [scale])

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault()
    setScale((current) => Math.min(5, Math.max(1, current + (event.deltaY < 0 ? 0.5 : -0.5))))
  }

  function handlePointerDown(event: PointerEvent<HTMLImageElement>) {
    if (scale === 1) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }

  function handlePointerMove(event: PointerEvent<HTMLImageElement>) {
    const drag = dragRef.current
    if (drag?.pointerId !== event.pointerId) return
    setOffset((current) => ({
      x: current.x + event.clientX - drag.x,
      y: current.y + event.clientY - drag.y,
    }))
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }

  function handlePointerEnd(event: PointerEvent<HTMLImageElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Aperçu de ${alt}`}
      onClick={onClose}
      onWheel={handleWheel}
    >
      <div className="lightbox-toolbar" onClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => setScale((current) => Math.max(1, current - 0.5))} disabled={scale === 1} aria-label="Dézoomer">−</button>
        <button type="button" className="lightbox-scale" onClick={() => setScale(1)} aria-label="Rétablir la taille de l’image">{Math.round(scale * 100)} %</button>
        <button type="button" onClick={() => setScale((current) => Math.min(5, current + 0.5))} disabled={scale === 5} aria-label="Zoomer">+</button>
      </div>
      <button ref={closeRef} type="button" className="lightbox-close" onClick={onClose}>
        Fermer
      </button>
      <div className="lightbox-viewport">
        <img
          src={src}
          alt={alt}
          draggable={false}
          className={scale > 1 ? 'is-zoomed' : ''}
          style={{ transform: `translate(${offset.x / scale}px, ${offset.y / scale}px) scale(${scale})` }}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={() => setScale((current) => current === 1 ? 2 : 1)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        />
      </div>
    </div>
  )
}

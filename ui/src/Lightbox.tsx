import { useEffect } from 'react'

interface LightboxProps {
  alt: string
  src: string
  onClose: () => void
}

export function Lightbox({ alt, src, onClose }: LightboxProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Aperçu de l’image"
      onClick={onClose}
    >
      <button type="button" className="lightbox-close" onClick={onClose}>
        Fermer
      </button>
      <img src={src} alt={alt} onClick={(event) => event.stopPropagation()} />
    </div>
  )
}

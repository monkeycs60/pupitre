import { useEffect } from 'react'

const GAP = 12
const TOAST_ZONE = 360

type Box = Pick<DOMRect, 'top' | 'right' | 'left'>

/** Distance au bas de l'écran qui dégage le composer, ou null s'il ne passe pas sous la zone qui commence à `zoneLeft`. */
export function composerClearance(composer: Box[], zoneLeft: number, viewportHeight: number): number | null {
  const [box] = composer
  if (!box || box.right <= zoneLeft - GAP) return null
  return Math.round(viewportHeight - Math.min(...composer.map((part) => part.top)) + GAP)
}

/** Les toasts du coin bas droit montent au-dessus du composer et de sa jauge quand ils passent dessous. */
export function useToastClearance() {
  useEffect(() => {
    const root = document.documentElement
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place())
    let composer: Element | null = null
    let applied: number | null = null
    function place() {
      const current = document.querySelector('.composer-area .composer')
      if (current !== composer) {
        if (composer) resize?.unobserve(composer)
        if (current) resize?.observe(current)
        composer = current
      }
      const boxes = composer ? [composer, ...composer.querySelectorAll('.context-gauge')].map((element) => element.getBoundingClientRect()) : []
      const bottom = composerClearance(boxes, window.innerWidth - TOAST_ZONE, window.innerHeight)
      if (bottom === applied) return
      applied = bottom
      if (bottom === null) root.style.removeProperty('--toast-bottom')
      else root.style.setProperty('--toast-bottom', `${bottom}px`)
    }
    place()
    const timer = window.setInterval(place, 1000)
    window.addEventListener('resize', place)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', place)
      resize?.disconnect()
      root.style.removeProperty('--toast-bottom')
    }
  }, [])
}

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

const FALLBACK_VIEWPORT = 900

export interface VirtualWindow<T extends HTMLElement> {
  ref: (element: T | null) => void
  elementRef: RefObject<T | null>
  element: T | null
  start: number
  end: number
  before: number
  after: number
  scrollToIndex: (index: number, align?: 'center' | 'nearest') => void
}

/**
 * Rendu fenêtré pour des lignes de hauteur fixe. Les lignes restent dans le
 * flux (espaceurs haut et bas) : un conteneur à défilement horizontal garde
 * ainsi la largeur de sa plus longue ligne visible. La ref est une ref
 * callback : un conteneur monté après le premier rendu (fichier chargé,
 * liste affichée plus tard) reçoit lui aussi l'écoute du défilement.
 */
export function useVirtualWindow<T extends HTMLElement>(
  count: number,
  rowHeight: number,
  overscan = 16,
): VirtualWindow<T> {
  const elementRef = useRef<T | null>(null)
  const [element, setElement] = useState<T | null>(null)
  const [range, setRange] = useState({ start: 0, end: Math.ceil(FALLBACK_VIEWPORT / rowHeight) + overscan })

  const ref = useCallback((node: T | null) => {
    elementRef.current = node
    setElement(node)
  }, [])

  const update = useCallback(() => {
    const current = elementRef.current
    const viewport = current?.clientHeight || FALLBACK_VIEWPORT
    const top = current?.scrollTop ?? 0
    const start = Math.max(0, Math.floor(top / rowHeight) - overscan)
    const end = Math.ceil((top + viewport) / rowHeight) + overscan
    setRange((previous) => previous.start === start && previous.end === end ? previous : { start, end })
  }, [rowHeight, overscan])

  useLayoutEffect(() => {
    update()
    if (!element) return
    element.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(element)
    return () => {
      element.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [element, update])

  const scrollToIndex = useCallback((index: number, align: 'center' | 'nearest' = 'nearest') => {
    const current = elementRef.current
    if (!current) return
    const top = index * rowHeight
    const viewport = current.clientHeight || FALLBACK_VIEWPORT
    if (align === 'center') {
      current.scrollTop = Math.max(0, top - viewport / 2 + rowHeight / 2)
    } else if (top < current.scrollTop) {
      current.scrollTop = top
    } else if (top + rowHeight > current.scrollTop + viewport) {
      current.scrollTop = top + rowHeight - viewport
    }
    update()
  }, [rowHeight, update])

  const start = Math.min(range.start, count)
  const end = Math.min(range.end, count)
  return {
    ref,
    elementRef,
    element,
    start,
    end,
    before: start * rowHeight,
    after: (count - end) * rowHeight,
    scrollToIndex,
  }
}

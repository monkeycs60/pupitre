import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { conversationSwitchStep } from './navigationShortcuts'

export const SWITCHER_REVEAL_MS = 250

export interface ConversationSwitch {
  index: number
  visible: boolean
}

export function useConversationSwitcher<T>(items: T[], onCommit: (item: T) => void) {
  const [state, setState] = useState<ConversationSwitch | null>(null)
  const stateRef = useRef<ConversationSwitch | null>(null)
  const latest = useRef({ items, onCommit })
  useLayoutEffect(() => {
    latest.current = { items, onCommit }
  })

  const update = useCallback((next: ConversationSwitch | null) => {
    stateRef.current = next
    setState(next)
  }, [])

  useEffect(() => {
    let revealTimer: ReturnType<typeof setTimeout> | undefined
    function commit() {
      const current = stateRef.current
      update(null)
      const item = current === null ? undefined : latest.current.items[current.index]
      if (item !== undefined) latest.current.onCommit(item)
    }
    function handleKeyDown(event: KeyboardEvent) {
      const step = conversationSwitchStep(event)
      const current = stateRef.current
      if (step !== null) {
        event.preventDefault()
        event.stopPropagation()
        const count = latest.current.items.length
        if (count === 0) return
        if (current === null) {
          update({ index: step === 1 ? 0 : count - 1, visible: step === -1 })
          clearTimeout(revealTimer)
          revealTimer = setTimeout(() => {
            if (stateRef.current !== null) update({ ...stateRef.current, visible: true })
          }, SWITCHER_REVEAL_MS)
        } else {
          update({ index: (current.index + step + count) % count, visible: true })
        }
        return
      }
      if (current === null || (event.key !== 'Escape' && event.key !== 'Enter')) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Enter') commit()
      else update(null)
    }
    function handleKeyUp(event: KeyboardEvent) {
      if (event.key === 'Control' && stateRef.current !== null) commit()
    }
    function handleBlur() {
      if (stateRef.current !== null) update(null)
    }
    // En capture et sans propagation : le composer envoie le message sur Entrée, même avec Ctrl enfoncé.
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', handleBlur)
    return () => {
      clearTimeout(revealTimer)
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', handleBlur)
    }
  }, [update])

  const cancel = useCallback(() => update(null), [update])
  return { state, cancel }
}

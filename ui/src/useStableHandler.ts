import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * Fonction d'identité constante qui appelle toujours la dernière version du
 * gestionnaire : un composant `memo` qui la reçoit ne se re-rend pas quand
 * le parent se re-rend.
 */
export function useStableHandler<Args extends unknown[], Result>(handler: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(handler)
  useLayoutEffect(() => {
    latest.current = handler
  })
  return useCallback((...args: Args) => latest.current(...args), [])
}

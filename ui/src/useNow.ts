import { useEffect, useState } from 'react'

// Horloge partagée des affichages de quota : les compte à rebours se
// rafraîchissent à la demi-minute, suffisant pour un « reset dans 2 h 14 ».
const TICK_MS = 30_000

export function useNow(tickMs: number = TICK_MS): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(timer)
  }, [tickMs])

  return now
}

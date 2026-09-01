import { useEffect, useState } from 'react'
import { fetchHealth } from './api'
import type { InstanceHealth } from './types'

function isInstanceHealth(value: InstanceHealth): boolean {
  return value.ok === true
    && (value.instance === 'stable' || value.instance === 'dev')
    && Number.isInteger(value.port)
    && typeof value.startedAt === 'string'
    && typeof value.build?.sha === 'string'
}

export function useInstance(reconnectSignal: boolean): InstanceHealth | null {
  const [health, setHealth] = useState<InstanceHealth | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined
    async function refresh() {
      try {
        const next = await fetchHealth(controller.signal)
        if (!controller.signal.aborted && isInstanceHealth(next)) {
          setHealth(next)
          if (next.instance === 'dev' && timer === undefined) {
            timer = setInterval(() => void refresh(), 15_000)
          }
        }
      } catch {}
    }
    void refresh()
    return () => {
      controller.abort()
      if (timer !== undefined) clearInterval(timer)
    }
  }, [reconnectSignal])

  return health
}

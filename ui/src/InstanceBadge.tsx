import { useState } from 'react'
import type { InstanceHealth } from './types'

interface InstanceBadgeProps {
  health: InstanceHealth | null
  onRestart: () => Promise<void>
}

export function InstanceBadge({ health, onRestart }: InstanceBadgeProps) {
  const [restarting, setRestarting] = useState(false)
  if (!health) return null
  const sha = `${health.build.sha}${health.build.dirty ? '*' : ''}`
  const stale = health.instance === 'dev' && health.staleSources > 0
  const label = restarting
    ? 'redémarrage…'
    : `${health.instance} · ${sha}${stale ? ` · périmé (${health.staleSources})` : ''}`
  const startedAt = new Date(health.startedAt).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  })
  const title = `Instance ${health.instance} · sidecar ${sha} · démarré à ${startedAt}`
    + (health.instance === 'dev' ? ' · Ctrl+Shift+R pour redémarrer le sidecar' : '')

  if (health.instance === 'stable') {
    return <span className="titlebar-instance" title={title}>{label}</span>
  }
  return (
    <button
      type="button"
      className={`titlebar-instance is-dev${stale ? ' is-stale' : ''}`}
      title={title}
      disabled={restarting}
      onClick={() => {
        setRestarting(true)
        void onRestart().catch(() => setRestarting(false))
      }}
    >
      {label}
    </button>
  )
}

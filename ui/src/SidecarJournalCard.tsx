import { useEffect, useState } from 'react'
import { getSidecarJournal } from './api'
import type { SidecarJournal, SidecarLifecycleEntry } from './types'

const KIND_LABELS: Record<SidecarLifecycleEntry['kind'], string> = {
  start: 'Démarrage',
  stop: 'Arrêt',
  crash: 'Plantage',
  rejection: 'Promesse rejetée, sidecar maintenu',
  unexplained: 'Arrêt sans trace',
}

function entryDetail(entry: SidecarLifecycleEntry): string {
  if (entry.kind === 'unexplained') return 'SIGKILL, plantage natif ou machine éteinte'
  if (entry.kind === 'stop' && /^SIG/.test(entry.detail)) return `signal ${entry.detail}`
  return entry.detail.replace(/ \(POST \/api\/shutdown\)$/, '')
}

export function SidecarJournalCard({ load = getSidecarJournal }: { load?: () => Promise<SidecarJournal> }) {
  const [journal, setJournal] = useState<SidecarJournal | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const next = await load()
      if (!Array.isArray(next?.instances)) throw new Error('Journal illisible.')
      setJournal(next)
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Journal illisible.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <div className="settings-card" id="settings-sidecar-journal">
      <div className="sidecar-journal-header">
        <div>
          <h2>Redémarrages du sidecar</h2>
          <p>Derniers démarrages et arrêts de chaque instance, avec leur cause.</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Lecture…' : 'Actualiser'}
        </button>
      </div>
      {error !== null ? <p className="settings-help" role="alert">{error}</p> : null}
      {journal ? (
        <div className="sidecar-journal-instances">
          {journal.instances.map((instance) => (
            <section key={instance.name} aria-label={`Instance ${instance.name}`}>
              <h3>
                {instance.name === 'stable' ? 'Stable' : 'Dev'}
                {instance.current ? <span className="sidecar-journal-current">cette instance</span> : null}
              </h3>
              {instance.entries.length === 0 ? (
                <p className="settings-help">Aucun redémarrage journalisé pour l’instant.</p>
              ) : (
                <ol className="sidecar-journal-list">
                  {instance.entries.map((entry, index) => (
                    <li key={`${entry.at}-${entry.kind}-${index}`} className={`is-${entry.kind}`}>
                      <time dateTime={entry.at}>
                        {new Date(entry.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </time>
                      <strong>{KIND_LABELS[entry.kind]}</strong>
                      <span>{entryDetail(entry)}</span>
                    </li>
                  ))}
                </ol>
              )}
              <p className="settings-help"><code>{instance.path}</code></p>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  )
}

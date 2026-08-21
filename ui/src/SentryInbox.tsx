import { useEffect, useMemo, useState } from 'react'
import { getSentryInbox, getSentryIssue, refreshProjectDashboard } from './api'
import type { SentryInboxPayload, SentryIssue } from './types'

function text(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === 'string' ? payload[key] as string : ''
}

function number(payload: Record<string, unknown>, key: string): number {
  return typeof payload[key] === 'number' ? payload[key] as number : 0
}

function dateLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}

export function SentryInbox({ projectId, onConfigure }: { projectId: string; onConfigure?: () => void }) {
  const [data, setData] = useState<SentryInboxPayload | null>(null)
  const [selected, setSelected] = useState<SentryIssue | null>(null)
  const [mineOnly, setMineOnly] = useState(true)
  const [loading, setLoading] = useState(false)

  async function load(signal?: AbortSignal) {
    setData(await getSentryInbox(projectId, signal))
  }

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [projectId])

  const issues = useMemo(
    () => (data?.issues ?? []).filter((issue) => !mineOnly || issue.relevance.matched),
    [data, mineOnly],
  )

  async function refresh() {
    setLoading(true)
    try {
      await refreshProjectDashboard(projectId)
      window.setTimeout(() => void load().catch(() => {}), 600)
    } finally {
      setLoading(false)
    }
  }

  async function open(issue: SentryIssue) {
    setSelected(issue)
    try { setSelected(await getSentryIssue(issue.id)) } catch {}
  }

  if (data?.integration === null) {
    return (
      <section className="dashboard-section sentry-inbox">
        <div className="dashboard-empty">
          <strong>Sentry n’est pas configuré pour ce projet</strong>
          <p>Ajoute l’organisation, les projets et le token dans les paramètres du projet.</p>
          {onConfigure ? <button className="primary-button" type="button" onClick={onConfigure}>Configurer Sentry</button> : null}
        </div>
      </section>
    )
  }

  return (
    <section className="dashboard-section sentry-inbox" aria-labelledby="sentry-inbox-title">
      <div className="dashboard-section-head">
        <div>
          <h2 id="sentry-inbox-title" className="dashboard-section-title">Issues Sentry</h2>
          <p className="sentry-subtitle">Production · dernier scan {dateLabel(data?.integration?.lastOkAt ?? '')}</p>
        </div>
        <div className="sentry-actions">
          <label><input type="checkbox" checked={mineOnly} onChange={(event) => setMineOnly(event.target.checked)} /> Mes domaines</label>
          <button className="secondary-button" type="button" disabled={loading} onClick={() => void refresh()}>{loading ? 'Scan…' : 'Scanner maintenant'}</button>
        </div>
      </div>
      {issues.length === 0 ? (
        <div className="dashboard-empty"><strong>Aucune issue dans ce filtre</strong><p>Les erreurs hors de tes domaines restent accessibles en décochant « Mes domaines ».</p></div>
      ) : (
        <div className="sentry-list">
          {issues.map((issue) => (
            <button key={issue.id} type="button" className="sentry-row" onClick={() => void open(issue)}>
              <span className={`sentry-level is-${text(issue.payload, 'level')}`} />
              <span className="sentry-main"><strong>{text(issue.payload, 'title') || 'Erreur sans titre'}</strong><small>{text(issue.payload, 'transaction') || text(issue.payload, 'culprit') || text(issue.payload, 'project')}</small></span>
              <span className="sentry-domains">{issue.relevance.reasons.map((reason) => reason.domain).filter((value, index, all) => all.indexOf(value) === index).join(', ') || 'Hors domaines'}</span>
              <span className={`sentry-lifecycle is-${issue.lifecycle}`}>{issue.lifecycle === 'resolved_remote' ? 'résolue' : issue.lifecycle}</span>
              <span className="sentry-count">{number(issue.payload, 'count')} évts</span>
              <span>{dateLabel(issue.last_seen_at)}</span>
            </button>
          ))}
        </div>
      )}
      {selected ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSelected(null)}>
          <aside className="modal sentry-detail" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header"><div><p className="eyebrow">{text(selected.payload, 'shortId')}</p><h2>{text(selected.payload, 'title')}</h2></div><button type="button" className="modal-close" onClick={() => setSelected(null)}>×</button></header>
            <div className="sentry-detail-body">
              <p><strong>Projet :</strong> {text(selected.payload, 'project')} · production</p>
              <p><strong>Emplacement :</strong> {text(selected.payload, 'transaction') || text(selected.payload, 'culprit') || '—'}</p>
              <p><strong>Impact :</strong> {number(selected.payload, 'count')} événements · {number(selected.payload, 'userCount')} utilisateurs</p>
              <p><strong>Domaines :</strong> {selected.relevance.reasons.map((reason) => `${reason.domain} (${reason.signal})`).join(', ') || 'aucun'}</p>
              {text(selected.payload, 'permalink') ? <a href={text(selected.payload, 'permalink')} target="_blank" rel="noreferrer">Ouvrir dans Sentry ↗</a> : null}
            </div>
            <footer className="modal-actions"><button type="button" className="secondary-button" onClick={() => setSelected(null)}>Fermer</button><button type="button" className="primary-button" disabled>Scout bientôt disponible</button></footer>
          </aside>
        </div>
      ) : null}
    </section>
  )
}

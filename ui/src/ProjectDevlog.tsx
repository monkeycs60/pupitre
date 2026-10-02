import { useEffect, useState } from 'react'
import { launchRequest, openDocumentInSystem } from './api'
import { relativeCodeDate } from './codeFormat'

type Overview = {
  documents: Array<{ id: string; title: string; createdAt: string }>
  tags: string[]
}
type Period = '7' | '30' | 'dates' | 'tags'
const day = (offset: number) =>
  new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10)

export function ProjectDevlog({ projectId }: { projectId: string }) {
  const [overview, setOverview] = useState<Overview>({ documents: [], tags: [] })
  const [kind, setKind] = useState<'devlog' | 'release'>('devlog')
  const [period, setPeriod] = useState<Period>('7')
  const [from, setFrom] = useState(day(7))
  const [to, setTo] = useState(day(0))
  const [fromTag, setFromTag] = useState('')
  const [toTag, setToTag] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function load() {
    try {
      const next = await launchRequest<Overview>(`/api/projects/${projectId}/devlog`)
      setOverview(next)
      setToTag((current) => current || next.tags[0] || '')
      setFromTag((current) => current || next.tags[1] || '')
    } catch (error) {
      setMessage(String(error))
    }
  }
  useEffect(() => {
    void load()
  }, [projectId])
  async function generate() {
    setBusy(true)
    setMessage('')
    try {
      await launchRequest(`/api/projects/${projectId}/devlog`, 'POST', {
        kind,
        ...(period === 'tags'
          ? { fromTag, toTag }
          : period === 'dates'
            ? { from, to }
            : { from: day(Number(period)), to: day(0) }),
      })
      await load()
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="devlog-panel" aria-label="Devlog et notes de version">
      <h2>Devlog et notes de version</h2>
      <div className="devlog-controls">
        <div className="devlog-kind" role="radiogroup" aria-label="Document">
          {(
            [
              ['devlog', 'Devlog'],
              ['release', 'Notes de version'],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              role="radio"
              aria-checked={kind === value}
              key={value}
              className={kind === value ? 'is-active' : ''}
              onClick={() => setKind(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          aria-label="Période"
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
        >
          <option value="7">7 derniers jours</option>
          <option value="30">30 derniers jours</option>
          <option value="dates">Dates précises</option>
          {overview.tags.length >= 2 && <option value="tags">Entre deux tags</option>}
        </select>
        {period === 'dates' && (
          <>
            <input type="date" aria-label="Du" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" aria-label="Au" value={to} onChange={(e) => setTo(e.target.value)} />
          </>
        )}
        {period === 'tags' && (
          <>
            <select aria-label="Tag de départ" value={fromTag} onChange={(e) => setFromTag(e.target.value)}>
              {overview.tags.map((tag) => <option key={tag}>{tag}</option>)}
            </select>
            <span aria-hidden="true">→</span>
            <select aria-label="Tag de fin" value={toTag} onChange={(e) => setToTag(e.target.value)}>
              {overview.tags.map((tag) => <option key={tag}>{tag}</option>)}
            </select>
          </>
        )}
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={() => void generate()}
        >
          {busy ? 'Génération…' : 'Générer'}
        </button>
      </div>
      {message && <p role="alert" className="devlog-message">{message}</p>}
      {overview.documents.length > 0 ? (
        <ul className="devlog-documents">
          {overview.documents.map((doc) => (
            <li key={doc.id}>
              <button
                type="button"
                onClick={() => void openDocumentInSystem(doc.id).catch((error) => setMessage(String(error)))}
                title="Ouvrir le document"
              >
                {doc.title.split(' · ').filter((_, index) => index !== 1).join(' · ')}
              </button>
              <span>{relativeCodeDate(doc.createdAt)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="devlog-empty">Aucun document publié pour ce projet.</p>
      )}
    </section>
  )
}

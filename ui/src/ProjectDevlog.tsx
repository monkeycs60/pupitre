import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { createHtmlDocumentViewToken, launchRequest } from './api'
import { relativeCodeDate } from './codeFormat'
import Markdown from './Markdown'
import { documentDownloadUrl, htmlDocumentContentUrl } from './transport'

type DevlogDocument = {
  id: string
  title: string
  kind: string
  originalName: string
  createdAt: string
}
type Overview = { documents: DevlogDocument[]; tags: string[] }
const shortTitle = (title: string) =>
  title.split(' · ').filter((_, index) => index !== 1).join(' · ')

function DevlogPreview({
  doc,
  onClose,
}: {
  doc: DevlogDocument
  onClose: () => void
}) {
  const [token, setToken] = useState<string | null>(null)
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let ignore = false
    void createHtmlDocumentViewToken(doc.id)
      .then(async (grant) => {
        if (ignore) return
        setToken(grant.token)
        if (doc.kind !== 'markdown') return
        const response = await fetch(htmlDocumentContentUrl(doc.id, grant.token))
        if (!response.ok) throw new Error('Chargement impossible')
        const text = await response.text()
        if (!ignore) setMarkdown(text)
      })
      .catch((reason: unknown) => {
        if (!ignore) setError(reason instanceof Error ? reason.message : 'Aperçu indisponible')
      })
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', close)
    return () => {
      ignore = true
      window.removeEventListener('keydown', close)
    }
  }, [doc.id, doc.kind, onClose])
  return createPortal(
    <>
      <button
        type="button"
        className="html-document-backdrop"
        aria-label="Fermer l’aperçu du document"
        onClick={onClose}
      />
      <section className="asset-document-preview" role="dialog" aria-modal="true" aria-label={`Aperçu de ${doc.title}`}>
        <header>
          <div>
            <span>{doc.kind.toUpperCase()}</span>
            <strong>{shortTitle(doc.title)}</strong>
          </div>
          <div className="html-document-actions">
            {token ? (
              <a href={documentDownloadUrl(doc.id, token)} download={doc.originalName}>
                Télécharger
              </a>
            ) : null}
            <button type="button" onClick={onClose} autoFocus>Fermer</button>
          </div>
        </header>
        <div className={`html-document-preview${doc.kind === 'markdown' ? ' devlog-preview-markdown' : ''}`}>
          {error ? <p role="alert">{error}</p> : null}
          {doc.kind === 'markdown' ? (
            markdown !== null ? <div className="devlog-markdown"><Markdown>{markdown}</Markdown></div> : error ? null : <p>Préparation de l’aperçu…</p>
          ) : token ? (
            <iframe
              src={htmlDocumentContentUrl(doc.id, token)}
              title={`Contenu de ${doc.title}`}
              sandbox="allow-scripts allow-modals"
              referrerPolicy="no-referrer"
            />
          ) : error ? null : <p>Préparation de l’aperçu…</p>}
        </div>
      </section>
    </>,
    window.document.body,
  )
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
  const [previewed, setPreviewed] = useState<DevlogDocument | null>(null)
  const closePreview = useCallback(() => setPreviewed(null), [])
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
      const created = await launchRequest<DevlogDocument>(`/api/projects/${projectId}/devlog`, 'POST', {
        kind,
        ...(period === 'tags'
          ? { fromTag, toTag }
          : period === 'dates'
            ? { from, to }
            : { from: day(Number(period)), to: day(0) }),
      })
      await load()
      setPreviewed(created)
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
              <button type="button" onClick={() => setPreviewed(doc)} title="Afficher le document">
                {shortTitle(doc.title)}
              </button>
              <span>{relativeCodeDate(doc.createdAt)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="devlog-empty">Aucun document publié pour ce projet.</p>
      )}
      {previewed ? <DevlogPreview doc={previewed} onClose={closePreview} /> : null}
    </section>
  )
}

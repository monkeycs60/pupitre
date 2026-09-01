import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { save } from '@tauri-apps/plugin-dialog'
import {
  createHtmlDocumentViewToken,
  deleteHtmlDocument,
  exportDocument,
  listDocuments,
  uploadMedia,
} from './api'
import { documentContentUrl, documentExternalUrl, documentThumbnailUrl, hasTauriRuntime } from './transport'
import type { Attachment, DocumentArtifact, Project } from './types'

interface DocumentsViewProps {
  currentProject: Project | null
  onConversationSelect: (projectId: string, conversationId: string) => void | Promise<void>
  onUseInConversation: (projectId: string, attachment: Attachment, document: DocumentArtifact) => void
}

const DEFAULT_DOCUMENTS_LIST_WIDTH = 320
const MIN_DOCUMENTS_LIST_WIDTH = 260
const MAX_DOCUMENTS_LIST_WIDTH = 520
const DOCUMENTS_LIST_WIDTH_STORAGE_KEY = 'pupitre.documents-list-width'

function clampDocumentsListWidth(width: number): number {
  return Math.min(MAX_DOCUMENTS_LIST_WIDTH, Math.max(MIN_DOCUMENTS_LIST_WIDTH, width))
}

function storedDocumentsListWidth(): number {
  const stored = window.localStorage.getItem(DOCUMENTS_LIST_WIDTH_STORAGE_KEY)
  const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10)
  return Number.isFinite(parsed)
    ? clampDocumentsListWidth(parsed)
    : DEFAULT_DOCUMENTS_LIST_WIDTH
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`
  return `${(bytes / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Action impossible.'
}

function SearchSnippet({ value }: { value: string }) {
  const parts = value.split(/(<mark>.*?<\/mark>)/gi)
  return (
    <span className="documents-search-snippet">
      {parts.map((part, index) => part.toLowerCase().startsWith('<mark>')
        ? <mark key={index}>{part.slice(6, -7)}</mark>
        : <span key={index}>{part}</span>)}
    </span>
  )
}

function DocumentPreview({ document }: { document: DocumentArtifact }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    setUrl(null)
    setError(null)
    void createHtmlDocumentViewToken(document.id)
      .then((grant) => {
        if (!ignore) setUrl(documentContentUrl(document.id, grant.token))
      })
      .catch((reason: unknown) => {
        if (!ignore) setError(errorMessage(reason))
      })
    return () => { ignore = true }
  }, [document.id])

  if (error) return <p className="documents-preview-message is-error">{error}</p>
  if (!url) return <p className="documents-preview-message">Préparation de l’aperçu…</p>
  return (
    <iframe
      src={url}
      title={`Aperçu de ${document.title}`}
      sandbox={document.kind === 'html' ? 'allow-scripts allow-modals' : undefined}
      referrerPolicy="no-referrer"
    />
  )
}

export function DocumentsView({
  currentProject,
  onConversationSelect,
  onUseInConversation,
}: DocumentsViewProps) {
  const [scope, setScope] = useState<'project' | 'all'>('all')
  const [kind, setKind] = useState<'all' | 'html' | 'pdf'>('all')
  const [query, setQuery] = useState('')
  const [documents, setDocuments] = useState<DocumentArtifact[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [documentsListWidth, setDocumentsListWidth] = useState(storedDocumentsListWidth)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function updateDocumentsListWidth(width: number) {
    const nextWidth = clampDocumentsListWidth(width)
    setDocumentsListWidth(nextWidth)
    window.localStorage.setItem(DOCUMENTS_LIST_WIDTH_STORAGE_KEY, String(nextWidth))
  }

  function handleDocumentsListResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()

    const startX = event.clientX
    const startWidth = documentsListWidth
    let currentWidth = startWidth
    document.body.classList.add('is-resizing-documents-list')

    function handlePointerMove(moveEvent: PointerEvent) {
      currentWidth = clampDocumentsListWidth(startWidth + moveEvent.clientX - startX)
      setDocumentsListWidth(currentWidth)
    }

    function handlePointerUp() {
      document.body.classList.remove('is-resizing-documents-list')
      window.localStorage.setItem(DOCUMENTS_LIST_WIDTH_STORAGE_KEY, String(currentWidth))
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }

  function handleDocumentsListResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 12
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      updateDocumentsListWidth(documentsListWidth - step)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      updateDocumentsListWidth(documentsListWidth + step)
    } else if (event.key === 'Home') {
      event.preventDefault()
      updateDocumentsListWidth(MIN_DOCUMENTS_LIST_WIDTH)
    } else if (event.key === 'End') {
      event.preventDefault()
      updateDocumentsListWidth(MAX_DOCUMENTS_LIST_WIDTH)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void listDocuments({
        projectId: scope === 'project' ? currentProject?.id : undefined,
        query: query.trim() || undefined,
        kind: kind === 'all' ? undefined : kind,
        state: 'active',
      }, controller.signal)
        .then(setDocuments)
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(errorMessage(reason))
        })
    }, 120)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [currentProject?.id, kind, query, refreshVersion, scope])

  const selected = useMemo(
    () => documents.find((document) => document.id === selectedId) ?? documents[0] ?? null,
    [documents, selectedId],
  )

  async function openExternal(document: DocumentArtifact) {
    setBusy('open')
    setError(null)
    try {
      const grant = await createHtmlDocumentViewToken(document.id)
      const url = documentExternalUrl(document.id, grant.token)
      if (hasTauriRuntime()) await openUrl(url)
      else window.open(url, '_blank', 'noopener,noreferrer')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(null)
    }
  }

  async function remove(document: DocumentArtifact) {
    if (!window.confirm(`Supprimer « ${document.title} » ? Cette action est irréversible.`)) return
    setBusy('delete')
    setError(null)
    try {
      await deleteHtmlDocument(document.id)
      setSelectedId(null)
      setExpanded(false)
      setRefreshVersion((current) => current + 1)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(null)
    }
  }

  async function handleUseInConversation(document: DocumentArtifact) {
    if (!document.projectId) return
    setBusy('use')
    setError(null)
    try {
      const grant = await createHtmlDocumentViewToken(document.id)
      const response = await fetch(documentContentUrl(document.id, grant.token))
      if (!response.ok) throw new Error(`Lecture impossible (${response.status})`)
      const blob = await response.blob()
      const attachment = await uploadMedia(
        blob.type ? blob : blob.slice(0, blob.size, document.mimeType),
        document.originalName,
      )
      onUseInConversation(document.projectId, attachment, document)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(null)
    }
  }

  async function handleExport(document: DocumentArtifact) {
    setBusy('export')
    setError(null)
    try {
      if (hasTauriRuntime()) {
        const destination = await save({
          defaultPath: document.originalName,
          filters: [{
            name: document.kind === 'pdf' ? 'Document PDF' : 'Document HTML',
            extensions: [document.kind === 'pdf' ? 'pdf' : 'html'],
          }],
        })
        if (typeof destination === 'string') await exportDocument(document.id, destination)
      } else {
        const grant = await createHtmlDocumentViewToken(document.id)
        const response = await fetch(documentContentUrl(document.id, grant.token))
        if (!response.ok) throw new Error(`Export impossible (${response.status})`)
        const url = URL.createObjectURL(await response.blob())
        const anchor = window.document.createElement('a')
        anchor.href = url
        anchor.download = document.originalName
        anchor.click()
        URL.revokeObjectURL(url)
      }
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className={`documents-view${expanded ? ' is-expanded' : ''}`}
      style={{ '--documents-list-width': `${documentsListWidth}px` } as CSSProperties}
    >
      <header className="documents-toolbar">
        <div>
          <h1>Documents</h1>
        </div>
        <div className="documents-filters" aria-label="Filtres des documents">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Rechercher un titre, projet, fil…"
            aria-label="Rechercher dans les documents"
          />
          <select value={scope} onChange={(event) => setScope(event.target.value as 'project' | 'all')} disabled={!currentProject}>
            {currentProject ? <option value="project">{currentProject.name}</option> : null}
            <option value="all">Tous les projets</option>
          </select>
          <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="all">HTML + PDF</option>
            <option value="html">HTML</option>
            <option value="pdf">PDF</option>
          </select>
        </div>
      </header>

      {error ? <p className="documents-error" role="alert">{error}</p> : null}
      <div className="documents-split">
        <aside className="documents-list" aria-label="Liste des documents">
          <div className="documents-count">{documents.length} document{documents.length === 1 ? '' : 's'}</div>
          {documents.map((document) => (
            <button
              type="button"
              className={`documents-row${selected?.id === document.id ? ' is-selected' : ''}`}
              key={document.id}
              onClick={() => setSelectedId(document.id)}
            >
              <img
                className="documents-thumbnail"
                src={documentThumbnailUrl(document.id, document.sha256)}
                alt=""
                loading="lazy"
              />
              <span className="documents-row-copy">
                <strong>{document.title}</strong>
                <span>{document.projectName ?? 'Projet'} · {formatDate(document.createdAt)}</span>
                {document.searchSnippet ? <SearchSnippet value={document.searchSnippet} /> : null}
              </span>
              <span className="documents-state">{document.matchCount > 0 ? `${document.matchCount} occ.` : document.kind.toUpperCase()}</span>
            </button>
          ))}
          {documents.length === 0 ? <p className="documents-empty">Aucun document ne correspond aux filtres.</p> : null}
        </aside>

        <div
          className="documents-list-resize-handle"
          role="separator"
          aria-label="Redimensionner la liste des documents"
          aria-orientation="vertical"
          aria-valuemin={MIN_DOCUMENTS_LIST_WIDTH}
          aria-valuemax={MAX_DOCUMENTS_LIST_WIDTH}
          aria-valuenow={documentsListWidth}
          tabIndex={0}
          title="Glisser pour redimensionner · double-cliquer pour réinitialiser"
          onPointerDown={handleDocumentsListResizeStart}
          onKeyDown={handleDocumentsListResizeKeyDown}
          onDoubleClick={() => updateDocumentsListWidth(DEFAULT_DOCUMENTS_LIST_WIDTH)}
        >
          <span aria-hidden="true" />
        </div>

        <section className="documents-detail" aria-label="Aperçu du document">
          {selected ? (
            <>
              <header className="documents-detail-header">
                <div>
                  <span className={`documents-kind is-${selected.kind}`}>{selected.kind.toUpperCase()}</span>
                  <h2>{selected.title}</h2>
                  <p>{selected.summary || `${selected.conversationTitle ?? 'Conversation'} · ${formatBytes(selected.sizeBytes)}`}</p>
                </div>
                <div className="documents-actions">
                  <button type="button" onClick={() => void onConversationSelect(selected.projectId!, selected.conversationId)} disabled={!selected.projectId || busy !== null}>Fil source</button>
                  <button type="button" className="is-primary" onClick={() => void handleUseInConversation(selected)} disabled={!selected.projectId || busy !== null}>{busy === 'use' ? 'Préparation…' : 'Utiliser dans une conversation'}</button>
                  <button type="button" onClick={() => void handleExport(selected)} disabled={busy !== null}>{busy === 'export' ? 'Export…' : 'Exporter'}</button>
                  <button type="button" onClick={() => void openExternal(selected)} disabled={busy !== null}>Ouvrir ↗</button>
                  <button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? 'Réduire' : 'Plein écran'}</button>
                  <button type="button" className="is-danger" onClick={() => void remove(selected)} disabled={busy !== null}>Supprimer</button>
                </div>
              </header>
              <div className="documents-preview"><DocumentPreview key={selected.id} document={selected} /></div>
            </>
          ) : <p className="documents-preview-message">Sélectionnez un document.</p>}
        </section>
      </div>
    </div>
  )
}

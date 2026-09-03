import { useEffect, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  ApiError,
  createHtmlDocumentViewToken,
  deleteHtmlDocument,
  getHtmlDocument,
  openDocumentInSystem,
} from './api'
import type { HtmlDocumentBlock } from './groupEvents'
import type { HtmlDocument, HtmlDocumentState } from './types'
import { htmlDocumentContentUrl, htmlDocumentExternalUrl, hasTauriRuntime } from './transport'
import { useNow } from './useNow'

function formatBytes(value: number): string {
  if (value < 1024) return `${value} o`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} Ko`
  return `${(value / (1024 * 1024)).toFixed(1).replace('.', ',')} Mio`
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function remainingLabel(expiresAt: string, now: number): string {
  const remainingMs = Date.parse(expiresAt) - now
  if (remainingMs <= 0) return 'expiré'
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000))
  if (minutes < 60) return `expire dans ${minutes} min`
  const hours = Math.ceil(minutes / 60)
  return `expire dans ${hours} h`
}

function eventSnapshot(block: HtmlDocumentBlock): HtmlDocument {
  return {
    id: block.documentId,
    conversationId: '',
    conversationTitle: null,
    projectId: null,
    projectName: null,
    title: block.title,
    summary: block.summary ?? null,
    kind: block.documentKind ?? 'html',
    mimeType: block.mimeType ?? 'text/html',
    originalName: block.originalName ?? 'index.html',
    sizeBytes: block.sizeBytes,
    sha256: '',
    createdAt: block.createdAt,
    expiresAt: block.expiresAt,
    retainedAt: null,
    expiredAt: null,
    deletedAt: null,
    state: block.expiresAt === null ? 'retained' : 'available',
    searchSnippet: null,
    matchCount: 0,
  }
}

function wasAutoOpened(documentId: string): boolean {
  try {
    return window.sessionStorage.getItem(`pupitre:html-document-opened:${documentId}`) === '1'
  } catch {
    return false
  }
}

function markAutoOpened(documentId: string): void {
  try {
    window.sessionStorage.setItem(`pupitre:html-document-opened:${documentId}`, '1')
  } catch {
    // Un stockage désactivé ne doit pas empêcher l'aperçu.
  }
}

function errorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string' && reason.trim()) return reason
  return fallback
}

export function HtmlDocumentCard({
  block,
  defaultOpen = false,
}: {
  block: HtmlDocumentBlock
  defaultOpen?: boolean
}) {
  const [shouldAutoOpen] = useState(() => defaultOpen && !wasAutoOpened(block.documentId))
  const [document, setDocument] = useState<HtmlDocument>(() => eventSnapshot(block))
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isOpen, setIsOpen] = useState(shouldAutoOpen)
  const [isExpanded, setIsExpanded] = useState(false)
  const [busyAction, setBusyAction] = useState<'preview' | 'open' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const now = useNow()

  useEffect(() => {
    const controller = new AbortController()
    let ignore = false
    if (shouldAutoOpen) markAutoOpened(block.documentId)

    void getHtmlDocument(block.documentId, controller.signal)
      .then(async (current) => {
        if (ignore) return
        setDocument(current)
        if (!shouldAutoOpen || (current.state !== 'available' && current.state !== 'retained')) return
        setBusyAction('preview')
        const grant = await createHtmlDocumentViewToken(block.documentId)
        if (ignore) return
        setPreviewUrl(htmlDocumentContentUrl(block.documentId, grant.token))
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || ignore) return
        setError(errorMessage(reason, 'Document HTML illisible'))
        if (reason instanceof ApiError && reason.status === 404) {
          setDocument((current) => ({
            ...current,
            state: 'deleted',
            deletedAt: new Date().toISOString(),
          }))
        }
        setIsOpen(false)
      })
      .finally(() => {
        if (!ignore) setBusyAction(null)
      })

    return () => {
      ignore = true
      controller.abort()
    }
  }, [block.documentId, shouldAutoOpen])

  const timedOut = document.state === 'available'
    && document.expiresAt !== null
    && Date.parse(document.expiresAt) <= now
  const effectiveState: HtmlDocumentState = timedOut ? 'expired' : document.state
  const canView = effectiveState === 'available' || effectiveState === 'retained'
  const documentKind = document.kind ?? 'html'

  async function createViewUrl(): Promise<string> {
    const grant = await createHtmlDocumentViewToken(block.documentId)
    return htmlDocumentContentUrl(block.documentId, grant.token)
  }

  async function togglePreview() {
    if (!canView) return
    if (isOpen) {
      setIsOpen(false)
      setIsExpanded(false)
      return
    }
    setBusyAction('preview')
    setError(null)
    try {
      setPreviewUrl(await createViewUrl())
      setIsOpen(true)
    } catch (reason) {
      setError(errorMessage(reason, 'Aperçu indisponible'))
    } finally {
      setBusyAction(null)
    }
  }

  async function openExternally() {
    if (!canView) return
    setBusyAction('open')
    setError(null)
    try {
      if (documentKind === 'docx' || documentKind === 'xlsx') {
        await openDocumentInSystem(block.documentId)
      } else {
        const grant = await createHtmlDocumentViewToken(block.documentId)
        const url = htmlDocumentExternalUrl(block.documentId, grant.token)
        if (hasTauriRuntime()) await openUrl(url)
        else window.open(url, '_blank', 'noopener,noreferrer')
      }
    } catch (reason) {
      setError(errorMessage(reason, 'Ouverture impossible'))
    } finally {
      setBusyAction(null)
    }
  }

  async function expandPreview() {
    if (!canView) return
    if (isExpanded) {
      setIsExpanded(false)
      return
    }
    setBusyAction('preview')
    setError(null)
    try {
      if (!previewUrl) setPreviewUrl(await createViewUrl())
      setIsOpen(true)
      setIsExpanded(true)
    } catch (reason) {
      setError(errorMessage(reason, 'Aperçu indisponible'))
    } finally {
      setBusyAction(null)
    }
  }

  async function remove() {
    if (!window.confirm(`Supprimer « ${document.title} » ? Le contenu ne sera pas récupérable.`)) return
    setBusyAction('delete')
    setError(null)
    try {
      setDocument(await deleteHtmlDocument(block.documentId))
      setIsOpen(false)
      setIsExpanded(false)
      setPreviewUrl(null)
    } catch (reason) {
      setError(errorMessage(reason, 'Suppression impossible'))
    } finally {
      setBusyAction(null)
    }
  }

  const status = effectiveState === 'retained'
    ? 'Permanent'
    : effectiveState === 'expired'
      ? 'Expiré'
      : effectiveState === 'deleted'
        ? 'Supprimé'
        : document.expiresAt === null
          ? 'Disponible'
          : remainingLabel(document.expiresAt, now)

  return (
    <>
      {isExpanded ? (
        <button
          type="button"
          className="html-document-backdrop"
          aria-label="Fermer la vue plein écran"
          onClick={() => setIsExpanded(false)}
        />
      ) : null}
      <section
        className={`html-document-card is-${effectiveState}${isExpanded ? ' is-expanded' : ''}`}
        aria-label={`Document ${documentKind.toUpperCase()} ${document.title}`}
        role={isExpanded ? 'dialog' : undefined}
        aria-modal={isExpanded ? true : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && isExpanded) setIsExpanded(false)
        }}
      >
      <header className="html-document-header">
        <button
          type="button"
          className="html-document-toggle"
          onClick={() => void togglePreview()}
          disabled={!canView || busyAction === 'preview'}
          aria-expanded={isOpen && canView}
        >
          <span className="html-document-caret" aria-hidden="true">{isOpen && canView ? '⌄' : '›'}</span>
          <span className="html-document-heading">
            <span className="html-document-kind">Document {documentKind.toUpperCase()}</span>
            <strong>{document.title}</strong>
            <span className="html-document-meta">
              {formatBytes(document.sizeBytes)} · {formatDate(document.createdAt)} · {status}
            </span>
          </span>
        </button>
        <div className="html-document-actions">
          {canView ? (
            <>
              <button type="button" onClick={() => void openExternally()} disabled={busyAction !== null}>
                {busyAction === 'open' ? 'Ouverture…' : documentKind === 'docx' || documentKind === 'xlsx' ? 'Modifier dans LibreOffice' : 'Ouvrir ↗'}
              </button>
              <button
                type="button"
                onClick={() => void expandPreview()}
                disabled={busyAction !== null}
                autoFocus={isExpanded}
              >
                {isExpanded ? 'Réduire' : 'Plein écran'}
              </button>
              <button
                type="button"
                className="is-danger"
                onClick={() => void remove()}
                disabled={busyAction !== null}
              >
                {busyAction === 'delete' ? 'Suppression…' : 'Supprimer'}
              </button>
            </>
          ) : null}
        </div>
      </header>

      {document.summary ? <p className="html-document-summary">{document.summary}</p> : null}
      {error ? <p className="html-document-error" role="alert">{error}</p> : null}
      {!canView ? (
        <p className="html-document-unavailable">
          {effectiveState === 'expired'
            ? 'Le contenu a été supprimé automatiquement après 24 heures.'
            : 'Le contenu de ce document a été supprimé.'}
        </p>
      ) : isOpen ? (
        <div className="html-document-preview">
          {previewUrl ? (
            <iframe
              src={previewUrl}
              title={`Aperçu de ${document.title}`}
              sandbox={documentKind === 'html' ? 'allow-scripts allow-modals' : undefined}
              referrerPolicy="no-referrer"
            />
          ) : <p>Préparation de l’aperçu…</p>}
        </div>
      ) : null}
      </section>
    </>
  )
}

import { useEffect, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { createHtmlDocumentViewToken, exportDocument } from './api'
import { documentContentUrl, hasTauriRuntime, httpUrl, mediaUrl } from './transport'
import type { DocumentArtifact, Project } from './types'
import './styles/shared-files.css'

interface SharedFileOrigin {
  conversationId: string
  conversationTitle: string
  eventId: number
  sender: 'user' | 'assistant'
  createdAt: string
}
interface SharedFile {
  id: string
  name: string
  kind: 'image' | 'document' | 'file'
  mimeType: string
  sizeBytes: number | null
  mediaName: string | null
  document: DocumentArtifact | null
  origins: SharedFileOrigin[]
}
interface SharedFilesViewProps {
  currentProject: Project | null
  conversationId: string | null
  refreshKey?: number
  onConversationSelect: (projectId: string, conversationId: string, eventId?: number) => void | Promise<void>
}

function bytes(value: number | null) {
  return value === null ? 'Indisponible' : value < 1024 ? `${value} o` : value < 1048576 ? `${Math.round(value / 1024)} Ko` : `${(value / 1048576).toFixed(1)} Mo`
}

function FilePreview({ file }: { file: SharedFile }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let ignore = false
    if (file.document) {
      void createHtmlDocumentViewToken(file.document.id).then((grant) => {
        if (!ignore) setUrl(documentContentUrl(file.document!.id, grant.token))
      }).catch((reason: unknown) => { if (!ignore) setError(reason instanceof Error ? reason.message : 'Aperçu indisponible') })
    }
    return () => { ignore = true }
  }, [file.document])
  if (file.kind === 'image' && file.mediaName) return <img className="shared-files-preview-image" src={mediaUrl(file.mediaName)} alt={file.name} />
  if (error) return <p role="alert">{error}</p>
  const previewUrl = file.mediaName ? mediaUrl(file.mediaName) : url
  if (!previewUrl) return <p>Préparation de l’aperçu…</p>
  return <iframe className="shared-files-preview-frame" src={previewUrl} title={`Aperçu de ${file.name}`} sandbox="" referrerPolicy="no-referrer" />
}

export function SharedFilesView(props: SharedFilesViewProps) {
  return <SharedFilesPanel key={`${props.currentProject?.id ?? ''}:${props.conversationId ?? ''}`} {...props} />
}

function SharedFilesPanel({ currentProject, conversationId, refreshKey = 0, onConversationSelect }: SharedFilesViewProps) {
  const [scope, setScope] = useState<'conversation' | 'project'>(conversationId ? 'conversation' : 'project')
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<SharedFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const projectId = currentProject?.id
  useEffect(() => {
    if (!projectId) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ projectId })
    if (scope === 'conversation' && conversationId) params.set('conversationId', conversationId)
    void fetch(httpUrl(`/api/shared-files?${params}`), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Chargement impossible (${response.status})`)
        return response.json() as Promise<SharedFile[]>
      })
      .then((result) => { if (!controller.signal.aborted) setFiles(result) })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Chargement impossible') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [projectId, conversationId, scope, refreshKey, revision])

  async function download(file: SharedFile) {
    setError(null)
    try {
      if (file.document && hasTauriRuntime()) {
        const destination = await save({ defaultPath: file.document.originalName })
        if (destination) await exportDocument(file.document.id, destination)
        return
      }
      const url = file.mediaName ? mediaUrl(file.mediaName) : file.document
        ? documentContentUrl(file.document.id, (await createHtmlDocumentViewToken(file.document.id)).token) : null
      if (!url) return
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Export impossible (${response.status})`)
      const blobUrl = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = blobUrl
      anchor.download = file.document?.originalName ?? file.name
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Export impossible') }
  }

  if (!currentProject) return <div className="shared-files-empty">Sélectionnez un projet pour retrouver ses fichiers partagés.</div>
  const needle = query.trim().toLocaleLowerCase('fr')
  const visible = files.filter((file) => `${file.name} ${file.mimeType} ${file.origins.map((origin) => origin.conversationTitle).join(' ')}`.toLocaleLowerCase('fr').includes(needle))
  return <section className="shared-files" aria-label="Fichiers partagés">
    <div className="shared-files-controls">
      <select aria-label="Portée des fichiers" value={scope} onChange={(event) => { setScope(event.target.value as typeof scope); setSelectedId(null) }}>
        <option value="conversation" disabled={!conversationId}>Conversation</option>
        <option value="project">Projet</option>
      </select>
      <button type="button" onClick={() => setRevision((value) => value + 1)} aria-label="Actualiser les fichiers">Actualiser</button>
      <input type="search" aria-label="Rechercher un fichier" placeholder="Rechercher un fichier…" value={query} onChange={(event) => setQuery(event.target.value)} />
    </div>
    {error && <p className="shared-files-empty" role="alert">{error}</p>}
    {loading ? <p className="shared-files-empty" role="status">Chargement des fichiers…</p> : <>
      <p className="shared-files-count">{visible.length} fichier{visible.length === 1 ? '' : 's'} partagé{visible.length === 1 ? '' : 's'}</p>
      {!visible.length && <p className="shared-files-empty">{query ? 'Aucun fichier ne correspond à la recherche.' : 'Les documents, images et pièces jointes partagés apparaîtront ici.'}</p>}
      <ul className="shared-files-list">{visible.map((file) => {
        const previewable = file.kind === 'image' || file.document?.kind === 'html' || file.document?.kind === 'pdf' || file.mimeType === 'application/pdf'
        const unavailable = file.sizeBytes === null || file.document?.state === 'expired' || file.document?.state === 'deleted'
        return <li key={file.id} className="shared-files-item">
          <div className="shared-files-row">
            {file.kind === 'image' && file.mediaName ? <img className="shared-files-thumb" src={mediaUrl(file.mediaName)} alt="" loading="lazy" /> : <span className="shared-files-kind" aria-hidden="true">{file.document?.kind.toUpperCase() ?? file.name.split('.').pop()?.toUpperCase().slice(0, 5) ?? 'FICHIER'}</span>}
            <div className="shared-files-info"><strong title={file.name}>{file.name}</strong><span>{bytes(file.sizeBytes)} · {file.origins[0]?.sender === 'user' ? 'Vous' : 'Agent'}{unavailable ? ' · Indisponible' : ''}</span></div>
          </div>
          <div className="shared-files-actions">
            {previewable && <button type="button" disabled={unavailable} aria-expanded={selectedId === file.id} onClick={() => setSelectedId(selectedId === file.id ? null : file.id)}>{selectedId === file.id ? 'Fermer l’aperçu' : 'Aperçu'}</button>}
            <button type="button" disabled={unavailable} onClick={() => void download(file)}>Exporter</button>
          </div>
          {selectedId === file.id && <FilePreview key={file.id} file={file} />}
          <details className="shared-files-origins"><summary>{file.origins.length} partage{file.origins.length === 1 ? '' : 's'} · Voir les messages</summary>
            {file.origins.map((origin) => <button key={origin.eventId} type="button" onClick={() => void onConversationSelect(currentProject.id, origin.conversationId, origin.eventId)}>{origin.conversationTitle || 'Conversation'} · {origin.sender === 'user' ? 'Vous' : 'Agent'} · {new Date(origin.createdAt).toLocaleDateString('fr-FR')}</button>)}
          </details>
        </li>
      })}</ul>
    </>}
  </section>
}

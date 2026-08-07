import { useEffect, useState } from 'react'
import Markdown from './Markdown'
import { createMemory, deleteMemory, getMemory, listMemory, renameMemory, updateMemory } from './api'
import type { MemoryDocument, MemoryFile } from './types'
import { HelpLink } from './HelpLink'

const MAX_MEMORY_BYTES = 1024 * 1024

function compactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} Ko`
}

export function MemoryView({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const [files, setFiles] = useState<MemoryFile[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [document, setDocument] = useState<MemoryDocument | null>(null)
  const [content, setContent] = useState('')
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = document !== null && content !== document.content
  const contentBytes = new TextEncoder().encode(content).byteLength
  const visibleFiles = files.filter((file) => file.path.toLowerCase().includes(query.trim().toLowerCase()))

  useEffect(() => {
    onDirtyChange(dirty)
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
      onDirtyChange(false)
    }
  }, [dirty, onDirtyChange])

  async function reload(preferredPath?: string | null) {
    const loaded = await listMemory()
    setFiles(loaded)
    setSelectedPath((current) => {
      const preferred = preferredPath === undefined ? current : preferredPath
      return preferred && loaded.some((file) => file.path === preferred)
        ? preferred
        : loaded[0]?.path ?? null
    })
  }

  useEffect(() => {
    void reload().catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : 'Mémoire indisponible'))
  }, [])

  useEffect(() => {
    if (!selectedPath) {
      setDocument(null)
      setContent('')
      return
    }
    const controller = new AbortController()
    setError(null)
    void getMemory(selectedPath, controller.signal)
      .then((loaded) => {
        setDocument(loaded)
        setContent(loaded.content)
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : 'Fichier indisponible')
      })
    return () => controller.abort()
  }, [selectedPath])

  async function save() {
    if (!document || busy || content === document.content || contentBytes > MAX_MEMORY_BYTES) return
    setBusy(true)
    setError(null)
    try {
      const updated = await updateMemory(document.path, content)
      setDocument(updated)
      setContent(updated.content)
      await reload(updated.path)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Écriture impossible')
    } finally {
      setBusy(false)
    }
  }

  function confirmDiscard(): boolean {
    return !dirty || window.confirm('Abandonner les modifications mémoire non enregistrées ?')
  }

  async function create() {
    if (busy || !confirmDiscard()) return
    const path = window.prompt('Nom relatif du nouveau fichier Markdown (avec .md) :', 'nouvelle-memoire.md')?.trim()
    if (!path) return
    setBusy(true)
    setError(null)
    try {
      const created = await createMemory(path)
      setDocument(created)
      setContent(created.content)
      setPreview(false)
      await reload(created.path)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Création impossible')
    } finally {
      setBusy(false)
    }
  }

  async function rename() {
    if (!document || busy || !confirmDiscard()) return
    const newPath = window.prompt('Nouveau chemin relatif du fichier Markdown :', document.path)?.trim()
    if (!newPath || newPath === document.path) return
    setBusy(true)
    setError(null)
    try {
      const renamed = await renameMemory(document.path, newPath)
      setDocument(renamed)
      setContent(renamed.content)
      await reload(renamed.path)
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : 'Renommage impossible')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!document || busy) return
    if (!window.confirm(`Supprimer définitivement « ${document.path} » de la mémoire Claude ?${dirty ? ' Les modifications non enregistrées seront abandonnées.' : ''}`)) return
    setBusy(true)
    setError(null)
    try {
      await deleteMemory(document.path)
      setDocument(null)
      await reload(null)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Suppression impossible')
    } finally {
      setBusy(false)
    }
  }

  function select(path: string) {
    if (dirty && !window.confirm('Abandonner les modifications non enregistrées ?')) return
    setSelectedPath(path)
  }

  return (
    <section className="memory-view" aria-labelledby="memory-title">
      <header className="memory-header">
        <div><h1 id="memory-title">Mémoire Claude</h1><p>Fichiers locaux de ~/.claude/memory, édités sans modèle intermédiaire. Recherche par nom ou chemin.</p><HelpLink slug="memoire" /></div>
        <div className="memory-header-actions">
          <button type="button" className="header-action" onClick={() => void create()} disabled={busy}>Nouveau fichier</button>
          {document ? <><button type="button" className="text-button" onClick={() => setPreview((value) => !value)}>{preview ? 'Éditer' : 'Aperçu'}</button><button type="button" className="text-button" onClick={() => void rename()} disabled={busy}>Renommer</button><button type="button" className="text-button danger-text" onClick={() => void remove()} disabled={busy}>Supprimer</button><button type="button" className="header-action" onClick={() => void save()} disabled={busy || content === document.content || contentBytes > MAX_MEMORY_BYTES}>{busy ? 'Écriture…' : 'Enregistrer'}</button></> : null}
        </div>
      </header>
      {error ? <p className="memory-error" role="alert">{error}</p> : null}
      <div className="memory-body">
        <nav className="memory-list" aria-label="Fichiers mémoire">
          <label className="memory-search"><span className="sr-only">Rechercher un fichier mémoire</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher un fichier…" /></label>
          {visibleFiles.length === 0 ? <div className="memory-empty"><strong>{files.length === 0 ? 'Aucun fichier mémoire' : 'Aucun fichier trouvé'}</strong><p>{files.length === 0 ? 'Claude créera ses fichiers dans ~/.claude/memory lorsqu\'une mémoire persistante sera disponible.' : 'Modifiez la recherche pour afficher un autre fichier.'}</p></div> : visibleFiles.map((file) => (
            <button type="button" key={file.path} className={selectedPath === file.path ? 'is-selected' : ''} onClick={() => select(file.path)}><span>{file.path}</span><small>{compactSize(file.size)} · {new Date(file.modifiedAt).toLocaleDateString('fr-FR')}</small></button>
          ))}
        </nav>
        <section className="memory-editor">
          {!document ? <div className="memory-empty"><strong>Sélectionnez un fichier</strong><p>Son contenu Markdown apparaîtra ici.</p></div> : preview ? <div className="memory-markdown"><Markdown>{content}</Markdown></div> : <textarea value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} aria-label={`Contenu de ${document.path}`} />}
          {document && !preview ? <div className={`memory-counter${contentBytes > MAX_MEMORY_BYTES ? ' is-over-limit' : ''}`} role={contentBytes > MAX_MEMORY_BYTES ? 'alert' : undefined}>{compactSize(contentBytes)} / 1 MiB{contentBytes > MAX_MEMORY_BYTES ? ' · limite dépassée' : ''}</div> : null}
        </section>
      </div>
    </section>
  )
}

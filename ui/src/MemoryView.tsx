import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { deleteMemory, getMemory, listMemory, updateMemory } from './api'
import type { MemoryDocument, MemoryFile } from './types'

function compactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} Ko`
}

export function MemoryView() {
  const [files, setFiles] = useState<MemoryFile[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [document, setDocument] = useState<MemoryDocument | null>(null)
  const [content, setContent] = useState('')
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    if (!document || busy || content === document.content) return
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

  async function remove() {
    if (!document || busy) return
    if (!window.confirm(`Supprimer définitivement « ${document.path} » de la mémoire Claude ?`)) return
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

  return (
    <section className="memory-view" aria-labelledby="memory-title">
      <header className="memory-header">
        <div><h1 id="memory-title">Mémoire Claude</h1><p>Fichiers locaux de ~/.claude/memory, édités sans modèle intermédiaire.</p></div>
        {document ? <div><button type="button" className="text-button" onClick={() => setPreview((value) => !value)}>{preview ? 'Éditer' : 'Aperçu'}</button><button type="button" className="text-button danger-text" onClick={() => void remove()} disabled={busy}>Supprimer</button><button type="button" className="header-action" onClick={() => void save()} disabled={busy || content === document.content}>{busy ? 'Écriture…' : 'Enregistrer'}</button></div> : null}
      </header>
      {error ? <p className="memory-error" role="alert">{error}</p> : null}
      <div className="memory-body">
        <nav className="memory-list" aria-label="Fichiers mémoire">
          {files.length === 0 ? <div className="memory-empty"><strong>Aucun fichier mémoire</strong><p>Claude créera ses fichiers dans ~/.claude/memory lorsqu'une mémoire persistante sera disponible.</p></div> : files.map((file) => (
            <button type="button" key={file.path} className={selectedPath === file.path ? 'is-selected' : ''} onClick={() => setSelectedPath(file.path)}><span>{file.path}</span><small>{compactSize(file.size)} · {new Date(file.modifiedAt).toLocaleDateString('fr-FR')}</small></button>
          ))}
        </nav>
        <section className="memory-editor">
          {!document ? <div className="memory-empty"><strong>Sélectionnez un fichier</strong><p>Son contenu Markdown apparaîtra ici.</p></div> : preview ? <div className="memory-markdown"><ReactMarkdown>{content}</ReactMarkdown></div> : <textarea value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} aria-label={`Contenu de ${document.path}`} />}
        </section>
      </div>
    </section>
  )
}

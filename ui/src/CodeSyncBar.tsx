import { useCallback, useEffect, useState } from 'react'
import { getCodeSync, mergeCodeBase, resolveCodeConflicts } from './api'
import { codeErrorMessage } from './codeFormat'
import type { CodeSource, CodeSyncStatus } from './types'

interface CodeSyncBarProps {
  projectId: string
  sources: CodeSource[]
  prefixes: ReadonlyMap<string, string>
  onMerged: () => void
  onOpenConversation: (conversationId: string) => void
}

interface SyncEntry {
  status: CodeSyncStatus | null
  error: string | null
  busy: 'fetch' | 'merge' | 'resolve' | null
}

const EMPTY_ENTRY: SyncEntry = { status: null, error: null, busy: null }

function shortBase(base: string): string {
  return base.replace(/^origin\//, '')
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count > 1 ? 's' : ''}`
}

export function CodeSyncBar({ projectId, sources, prefixes, onMerged, onOpenConversation }: CodeSyncBarProps) {
  const [entries, setEntries] = useState<Record<string, SyncEntry>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const sourceKey = sources.map((source) => source.path).join('\n')

  const update = useCallback((path: string, patch: Partial<SyncEntry>) => {
    setEntries((current) => ({ ...current, [path]: { ...(current[path] ?? EMPTY_ENTRY), ...patch } }))
  }, [])

  const refresh = useCallback((path: string, fetch: boolean, signal?: AbortSignal) => {
    update(path, { busy: 'fetch', error: null })
    getCodeSync(projectId, path, fetch, signal)
      .then((status) => update(path, { status, busy: null }))
      .catch((reason: unknown) => {
        if (!signal?.aborted) update(path, { error: codeErrorMessage(reason), busy: null })
      })
  }, [projectId, update])

  useEffect(() => {
    const controller = new AbortController()
    for (const path of sourceKey.split('\n').filter(Boolean)) refresh(path, true, controller.signal)
    return () => controller.abort()
  }, [sourceKey, refresh])

  function merge(path: string) {
    update(path, { busy: 'merge', error: null })
    mergeCodeBase(projectId, path)
      .then((status) => {
        update(path, { status, busy: null })
        onMerged()
      })
      .catch((reason: unknown) => update(path, { error: codeErrorMessage(reason), busy: null }))
  }

  function resolve(path: string) {
    update(path, { busy: 'resolve', error: null })
    resolveCodeConflicts(projectId, path)
      .then((conversation) => {
        update(path, { busy: null })
        onOpenConversation(conversation.id)
      })
      .catch((reason: unknown) => update(path, { error: codeErrorMessage(reason), busy: null }))
  }

  const rows = sources.map((source, index) => ({ source, index, entry: entries[source.path] }))
  if (rows.every(({ entry }) => entry?.status && !entry.status.base && !entry.error)) return null

  return <div className="code-sync" aria-label="Écart avec la branche de base">
    {rows.map(({ source, index, entry }) => {
      const status = entry?.status ?? null
      if (status && !status.base && !entry?.error) return null
      const prefix = prefixes.get(source.path) ?? ''
      const busy = entry?.busy ?? null
      const conflicts = status?.conflicts ?? []
      const behind = status?.behind ?? 0
      const upToDate = status !== null && behind === 0
      const tone = entry?.error || status?.fetchError ? 'is-error' : conflicts.length > 0 ? 'is-conflict' : behind > 0 ? 'is-behind' : 'is-clean'
      return <div className={`code-sync-row ${status ? tone : ''}`} key={source.path}>
        <div className="code-sync-line">
          {prefix ? <span className={`code-repo-badge is-repo-${index % 6}`}>{prefix}</span> : null}
          <span className="code-sync-dot" aria-hidden="true" />
          <span className="code-sync-text">
            {!status ? 'Comparaison avec la base…' : null}
            {status && upToDate ? <>À jour avec <b>{shortBase(status.base!)}</b></> : null}
            {status && !upToDate ? <><b>{plural(behind, 'commit')}</b> de retard sur <b>{shortBase(status.base!)}</b></> : null}
            {status && status.ahead > 0 ? <span className="code-sync-ahead">, {status.ahead} d’avance</span> : null}
          </span>
          {status && conflicts.length > 0 ? <button
            type="button"
            className="code-sync-conflicts"
            aria-expanded={expanded === source.path}
            onClick={() => setExpanded((value) => (value === source.path ? null : source.path))}
          >
            {plural(conflicts.length, 'conflit')}
          </button> : null}
          <button
            type="button"
            className="code-icon-button code-sync-refresh"
            title={status?.fetchedAt ? `Récupérer la base (dernier fetch ${new Date(status.fetchedAt).toLocaleTimeString('fr-FR')})` : 'Récupérer la dernière version de la base'}
            aria-label="Récupérer la base"
            disabled={busy !== null}
            onClick={() => refresh(source.path, true)}
          >
            <svg className={busy === 'fetch' ? 'is-spinning' : ''} width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        {status && behind > 0 && status.mergeable ? <div className="code-sync-actions">
          {conflicts.length === 0 ? <button
            type="button"
            className="code-filter-toggle is-active"
            disabled={busy !== null || status.dirty}
            title={status.dirty ? 'Committe ou mets de côté les modifications du worktree avant de fusionner' : `git merge ${status.base}`}
            onClick={() => merge(source.path)}
          >
            {busy === 'merge' ? 'Fusion…' : `Fusionner ${shortBase(status.base!)}`}
          </button> : <button
            type="button"
            className="code-filter-toggle is-active"
            disabled={busy !== null}
            title="Crée une conversation rattachée au ticket et à la branche, chargée de fusionner et de résoudre les conflits"
            onClick={() => resolve(source.path)}
          >
            {busy === 'resolve' ? 'Création…' : 'Résoudre dans une conversation'}
          </button>}
          {status.dirty && conflicts.length === 0 ? <span className="code-sync-hint">Modifications non commitées</span> : null}
        </div> : null}
        {status && behind > 0 && !status.mergeable ? <p className="code-sync-hint">Branche sans worktree : ouvre-la dans une conversation pour la mettre à jour.</p> : null}
        {status && expanded === source.path && conflicts.length > 0 ? <ul className="code-sync-files">
          {conflicts.map((path) => <li key={path} title={path}>{path}</li>)}
        </ul> : null}
        {entry?.error ? <p className="code-sync-error">{entry.error}</p> : null}
        {!entry?.error && status?.fetchError ? <p className="code-sync-error">Fetch impossible, écart calculé sur la dernière version connue : {status.fetchError}</p> : null}
      </div>
    })}
  </div>
}

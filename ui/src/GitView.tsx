import { useCallback, useEffect, useMemo, useState } from 'react'
import { commitProjectGit, getConversationDiff, getProjectGit, getProjectGitDiff } from './api'
import { DiffViewer } from './DiffViewer'
import { SurfaceSwitch } from './SurfaceSwitch'
import type { Conversation, GitCommit, GitDiff, GitSnapshot, Project } from './types'

type Tab = 'changes' | 'history'

interface GitViewProps {
  project: Project
  conversation: Conversation | null
  onConversationBack: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'La vue Code est indisponible.'
}

function branchCommits(snapshot: GitSnapshot | null): GitCommit[] {
  if (!snapshot) return []
  const ids = snapshot.branchCommitShas ?? snapshot.commits.map((commit) => commit.sha)
  return ids.map((sha) => snapshot.commits.find((commit) => commit.sha === sha))
    .filter((commit): commit is GitCommit => commit !== undefined)
}

function changedFiles(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map((match) => match[1]!)
}

export function GitView({ project, conversation, onConversationBack }: GitViewProps) {
  const [tab, setTab] = useState<Tab>('changes')
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null)
  const [live, setLive] = useState<GitDiff | null>(null)
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [commitDiff, setCommitDiff] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!conversation) return
    const [nextSnapshot, nextLive] = await Promise.all([
      getProjectGit(project.id, conversation.id, signal),
      getConversationDiff(conversation.id, signal),
    ])
    if (signal?.aborted) return
    setSnapshot(nextSnapshot)
    setLive(nextLive)
  }, [project.id, conversation?.id])

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    void refresh(controller.signal).catch((reason) => {
      if (!controller.signal.aborted) setError(errorMessage(reason))
    })
    return () => controller.abort()
  }, [refresh])

  const commits = useMemo(() => branchCommits(snapshot), [snapshot])
  const selected = commits.find((commit) => commit.sha === selectedSha) ?? commits[0] ?? null

  useEffect(() => {
    if (!conversation || !selected) {
      setCommitDiff('')
      return
    }
    const controller = new AbortController()
    void getProjectGitDiff(
      project.id,
      selected.parents[0] ?? `${selected.sha}^`,
      selected.sha,
      conversation.id,
      controller.signal,
    ).then((result) => setCommitDiff(result.diff)).catch((reason) => {
      if (!controller.signal.aborted) setError(errorMessage(reason))
    })
    return () => controller.abort()
  }, [project.id, conversation?.id, selected?.sha])

  async function commit() {
    if (!conversation || !live || commitMessage.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      await commitProjectGit(project.id, {
        conversationId: conversation.id,
        paths: changedFiles(live.diff),
        message: commitMessage,
      })
      setCommitMessage('')
      await refresh()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const files = changedFiles(live?.diff ?? '')
  return (
    <div className="code-workspace">
      <header className="code-header">
        <div className="code-header-title">
          <strong>{conversation?.title ?? project.name}</strong>
          <span>{snapshot?.currentBranch ?? 'HEAD détachée'}</span>
        </div>
        <SurfaceSwitch active="code" onConversation={onConversationBack} onCode={() => {}} />
      </header>
      {error ? <p className="code-error" role="alert">{error}</p> : null}
      {!conversation ? <p className="changes-empty">Sélectionnez une conversation pour voir ses changements.</p> : (
        <>
          <nav className="code-tabs" aria-label="Sections de la vue Code">
            <button type="button" className={tab === 'changes' ? 'is-active' : ''} onClick={() => setTab('changes')}>
              Changements <span>{files.length} fichier{files.length > 1 ? 's' : ''}</span>
            </button>
            <button type="button" className={tab === 'history' ? 'is-active' : ''} onClick={() => setTab('history')}>
              Historique <span>{commits.length} commit{commits.length > 1 ? 's' : ''}</span>
            </button>
          </nav>
          {tab === 'changes' ? (
            <section className="changes-tab">
              <aside className="changes-sidebar">
                <nav className="changes-file-list" aria-label="Fichiers modifiés">
                  {files.map((file) => <span key={file} className="changes-file-path">{file}</span>)}
                </nav>
                <div className="changes-commit">
                  <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Message du commit" aria-label="Message du commit" />
                  <button type="button" onClick={() => void commit()} disabled={busy || files.length === 0 || commitMessage.trim() === ''}>Committer</button>
                </div>
              </aside>
              <div className="changes-main">
                {live?.diff ? <DiffViewer diff={live.diff} label="Diff de la conversation" /> : <p className="changes-empty">Aucun changement.</p>}
              </div>
            </section>
          ) : (
            <section className="history-tab">
              <div className="code-commit-list">
                {commits.map((item) => (
                  <button type="button" key={item.sha} className={selected?.sha === item.sha ? 'is-selected' : ''} onClick={() => setSelectedSha(item.sha)}>
                    <code>{item.sha.slice(0, 8)}</code><strong>{item.subject}</strong>
                  </button>
                ))}
              </div>
              <div className="history-detail">
                {selected ? <DiffViewer diff={commitDiff} label={`Diff du commit ${selected.sha}`} /> : <p className="changes-empty">Aucun commit à afficher.</p>}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

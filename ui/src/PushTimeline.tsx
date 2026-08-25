import { useCallback, useEffect, useState } from 'react'
import { getProjectGitDiff, listConversationPushes } from './api'
import type { GitPushCommit } from './types'
import { DiffViewer } from './DiffViewer'
import { ExternalLink } from './externalLink'

function shortSha(sha: string): string { return sha.slice(0, 8) }

export function PushTimeline({ projectId, conversationId }: { projectId: string, conversationId: string }) {
  const [pushes, setPushes] = useState<GitPushCommit[]>([])
  const [opened, setOpened] = useState<{ commit: GitPushCommit, diff: string } | null>(null)
  const [loadingSha, setLoadingSha] = useState<string | null>(null)

  const refresh = useCallback((signal?: AbortSignal) => {
    void listConversationPushes(conversationId, signal).then(setPushes).catch(() => {})
  }, [conversationId])

  useEffect(() => {
    const controller = new AbortController()
    refresh(controller.signal)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh(controller.signal)
    }, 5_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [refresh])

  useEffect(() => {
    if (!opened) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpened(null) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [opened])

  async function openDiff(commit: GitPushCommit) {
    if (!commit.parent) return
    setLoadingSha(commit.sha)
    try {
      const result = await getProjectGitDiff(projectId, commit.parent, commit.sha, conversationId)
      setOpened({ commit, diff: result.diff })
    } finally { setLoadingSha(null) }
  }

  if (pushes.length === 0) return null
  return <>
    <div className="push-timeline" aria-label="Pushes de la conversation">
      {pushes.map((commit) => <article className="push-card" key={commit.sha}>
        <button type="button" className="push-card-main" onClick={() => void openDiff(commit)} disabled={!commit.parent || loadingSha === commit.sha}>
          <span className="push-card-icon" aria-hidden="true">↗</span>
          <span><strong>{commit.subject}</strong><small>Push · {shortSha(commit.sha)}</small></span>
          <span className="push-card-open">{loadingSha === commit.sha ? 'Chargement…' : 'Voir le diff'}</span>
        </button>
        <footer>
          {commit.remoteUrl ? <ExternalLink href={commit.remoteUrl}>Ouvrir sur le remote</ExternalLink> : null}
          <ExternalLink href={`vscode://file/${commit.repositoryPath}`}>Ouvrir dans VS Code</ExternalLink>
        </footer>
      </article>)}
    </div>
    {opened ? <div className="push-diff-overlay" role="dialog" aria-modal="true" aria-label={`Diff ${opened.commit.subject}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setOpened(null) }}>
      <section>
        <header><div><strong>{opened.commit.subject}</strong><span>{shortSha(opened.commit.sha)}</span></div><button type="button" onClick={() => setOpened(null)}>Fermer</button></header>
        <div className="push-diff-content"><DiffViewer diff={opened.diff} label={`Diff du push ${opened.commit.subject}`} /></div>
      </section>
    </div> : null}
  </>
}

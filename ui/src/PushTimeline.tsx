import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { acknowledgeConversationPush, getProjectGitDiff, listConversationPushes, openConversationInEditor } from './api'
import type { GitPushCommit } from './types'
import { DiffFileList } from './ConversationChangesView'
import { splitUnifiedDiff } from './unifiedDiff'
import { ExternalLink } from './externalLink'

function shortSha(sha: string): string { return sha.slice(0, 8) }

export function PushTimeline({ projectId, conversationId }: { projectId: string, conversationId: string }) {
  const [pushes, setPushes] = useState<GitPushCommit[]>([])
  const [opened, setOpened] = useState<{ commit: GitPushCommit, diff: string } | null>(null)
  const [loadingSha, setLoadingSha] = useState<string | null>(null)
  const [acknowledgingSha, setAcknowledgingSha] = useState<string | null>(null)

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

  async function toggleDiff(commit: GitPushCommit) {
    if (!commit.parent) return
    if (opened?.commit.sha === commit.sha) {
      setOpened(null)
      return
    }
    setLoadingSha(commit.sha)
    try {
      const result = await getProjectGitDiff(projectId, commit.parent, commit.sha, conversationId)
      setOpened({ commit, diff: result.diff })
    } finally { setLoadingSha(null) }
  }

  async function acknowledge(commit: GitPushCommit) {
    setAcknowledgingSha(commit.sha)
    try {
      await acknowledgeConversationPush(conversationId, commit.sha)
      setPushes((current) => current.filter((item) => item.sha !== commit.sha))
      if (opened?.commit.sha === commit.sha) setOpened(null)
    } finally { setAcknowledgingSha(null) }
  }

  const openedFiles = useMemo(() => (opened ? splitUnifiedDiff(opened.diff, opened.commit.repositoryPath) : []), [opened])

  if (pushes.length === 0) return null
  return <>
    <div className="push-timeline" aria-label="Pushes de la conversation">
      {pushes.map((commit) => <Fragment key={commit.sha}><article className="push-card">
        <button type="button" className="push-card-main" onClick={() => void toggleDiff(commit)} disabled={!commit.parent || loadingSha === commit.sha} aria-expanded={opened?.commit.sha === commit.sha}>
          <span className="push-card-icon" aria-hidden="true">↗</span>
          <span><strong>{commit.subject}</strong><small>Push · {shortSha(commit.sha)}</small></span>
          <span className="push-card-open">{loadingSha === commit.sha ? 'Chargement…' : opened?.commit.sha === commit.sha ? 'Masquer le diff' : 'Voir le diff'}</span>
        </button>
        <button type="button" className="push-card-ack" aria-label={`Acquitter le push ${commit.subject}`} title="Masquer ce push" disabled={acknowledgingSha === commit.sha} onClick={() => void acknowledge(commit)}>✓</button>
        <footer>
          {commit.remoteUrl ? <ExternalLink href={commit.remoteUrl}>Ouvrir sur le remote</ExternalLink> : null}
          <button type="button" className="push-card-link" onClick={() => void openConversationInEditor(conversationId).catch(() => {})}>Ouvrir dans VS Code</button>
        </footer>
      </article>
      {opened?.commit.sha === commit.sha ? <DiffFileList
        files={openedFiles}
        group={{ repositoryLabel: commit.repositoryPath.split('/').pop() ?? '', worktreePath: commit.repositoryPath }}
        idPrefix={`push-${commit.sha}`}
      /> : null}
      </Fragment>)}
    </div>
  </>
}

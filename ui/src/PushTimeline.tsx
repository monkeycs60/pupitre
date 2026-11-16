import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { acknowledgeConversationPush, getProjectGitDiff, listConversationPushes, openConversationInEditor } from './api'
import type { GitPushCommit } from './types'
import { DiffFileList } from './ConversationChangesView'
import { splitUnifiedDiff } from './unifiedDiff'
import { ExternalLink } from './externalLink'

const AUTO_EXPAND_LIMIT = 3

function shortSha(sha: string): string { return sha.slice(0, 8) }

export function PushTimeline({ projectId, conversationId }: { projectId: string, conversationId: string }) {
  const [pushes, setPushes] = useState<GitPushCommit[]>([])
  const [expandedChoice, setExpandedChoice] = useState<boolean | null>(null)
  const [opened, setOpened] = useState<{ commit: GitPushCommit, diff: string } | null>(null)
  const [loadingSha, setLoadingSha] = useState<string | null>(null)
  const [acknowledging, setAcknowledging] = useState<Set<string>>(() => new Set())

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

  async function acknowledge(commits: GitPushCommit[]) {
    const shas = commits.map((commit) => commit.sha)
    setAcknowledging((current) => new Set([...current, ...shas]))
    try {
      const results = await Promise.allSettled(shas.map((sha) => acknowledgeConversationPush(conversationId, sha)))
      const done = new Set(shas.filter((_, index) => results[index]!.status === 'fulfilled'))
      setPushes((current) => current.filter((item) => !done.has(item.sha)))
      if (opened && done.has(opened.commit.sha)) setOpened(null)
    } finally {
      setAcknowledging((current) => new Set([...current].filter((sha) => !shas.includes(sha))))
    }
  }

  const openedFiles = useMemo(() => (opened ? splitUnifiedDiff(opened.diff, opened.commit.repositoryPath) : []), [opened])

  if (pushes.length === 0) return null
  const expanded = expandedChoice ?? pushes.length <= AUTO_EXPAND_LIMIT
  const latest = pushes[pushes.length - 1]!
  return <section className="push-timeline" aria-label="Pushes de la conversation">
    <header className="push-timeline-head">
      <button type="button" className="push-timeline-toggle" aria-expanded={expanded} onClick={() => setExpandedChoice(!expanded)}>
        <span className="push-card-icon" aria-hidden="true">↗</span>
        <strong>{pushes.length} {pushes.length > 1 ? 'pushes' : 'push'}</strong>
        {expanded ? null : <span className="push-timeline-latest">dernier : {latest.subject}</span>}
        <span className="push-timeline-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      <button type="button" className="push-card-link" onClick={() => void openConversationInEditor(conversationId).catch(() => {})}>VS Code</button>
      {pushes.length > 1 ? <button type="button" className="push-card-link" disabled={acknowledging.size > 0} onClick={() => void acknowledge(pushes)}>Tout acquitter</button> : null}
    </header>
    {expanded ? <div className={opened ? 'push-timeline-list has-diff' : 'push-timeline-list'}>
      {pushes.map((commit) => <Fragment key={commit.sha}><div className="push-row">
        <button type="button" className="push-row-main" onClick={() => void toggleDiff(commit)} disabled={!commit.parent || loadingSha === commit.sha} aria-expanded={opened?.commit.sha === commit.sha} title={commit.subject}>
          <strong>{commit.subject}</strong>
          <code>{shortSha(commit.sha)}</code>
          <span className="push-card-open">{loadingSha === commit.sha ? 'Chargement…' : opened?.commit.sha === commit.sha ? 'Masquer le diff' : 'Diff'}</span>
        </button>
        {commit.remoteUrl ? <ExternalLink href={commit.remoteUrl} className="push-card-link">Remote</ExternalLink> : null}
        <button type="button" className="push-card-ack" aria-label={`Acquitter le push ${commit.subject}`} title="Masquer ce push" disabled={acknowledging.has(commit.sha)} onClick={() => void acknowledge([commit])}>✓</button>
      </div>
      {opened?.commit.sha === commit.sha ? <DiffFileList
        files={openedFiles}
        group={{ repositoryLabel: commit.repositoryPath.split('/').pop() ?? '', worktreePath: commit.repositoryPath }}
        idPrefix={`push-${commit.sha}`}
      /> : null}
      </Fragment>)}
    </div> : null}
  </section>
}

import { useEffect, useMemo, useState } from 'react'
import { getProjectGit, getProjectGitDiff } from './api'
import { DiffViewer } from './DiffViewer'
import { gitRefOptions, layoutGitGraph } from './gitGraph'
import type { GitSnapshot, Project } from './types'

interface GitViewProps {
  project: Project
  onConversationSelect: (conversationId: string) => void
  onGuardianSelect: (reviewId: string) => void
}

function shortSha(sha: string): string {
  return sha.slice(0, 8)
}

function commitDate(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'La vue Git est indisponible.'
}

export function GitView({ project, onConversationSelect, onGuardianSelect }: GitViewProps) {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null)
  const [baseRef, setBaseRef] = useState('')
  const [headRef, setHeadRef] = useState('')
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isComparing, setIsComparing] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setIsLoading(true)
    setDiff(null)
    void getProjectGit(project.id, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return
        setSnapshot(loaded)
        setHeadRef(loaded.head ?? '')
        setBaseRef(loaded.headParents[0] ?? '')
        setError(null)
        setIsLoading(false)
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return
        setSnapshot(null)
        setError(errorMessage(loadError))
        setIsLoading(false)
      })
    return () => controller.abort()
  }, [project.id])

  const rows = useMemo(
    () => layoutGitGraph(snapshot?.commits ?? []),
    [snapshot],
  )
  const maxLanes = Math.max(1, ...rows.map((row) => row.laneCount))
  const refOptions = useMemo(() => {
    if (!snapshot) return []
    return gitRefOptions(snapshot)
  }, [snapshot])

  async function compare() {
    if (!baseRef || !headRef) return
    setIsComparing(true)
    setError(null)
    try {
      setDiff((await getProjectGitDiff(project.id, baseRef, headRef)).diff)
    } catch (compareError: unknown) {
      setError(errorMessage(compareError))
    } finally {
      setIsComparing(false)
    }
  }

  return (
    <div className="git-workspace">
      <header className="git-header">
        <div>
          <span className="workspace-kicker">Historique du projet</span>
          <h1>Git · {project.name}</h1>
          <p>
            {snapshot?.currentBranch ?? 'HEAD détachée'}
            {snapshot?.head ? ` · ${shortSha(snapshot.head)}` : ''}
          </p>
        </div>
        <div className="git-worktrees" aria-label="Worktrees">
          <span>Worktrees</span>
          <strong>{snapshot?.worktrees.length ?? 0}</strong>
        </div>
      </header>

      {error ? <div className="guardian-error" role="alert">{error}</div> : null}
      {isLoading ? <div className="git-empty">Lecture de l’historique…</div> : null}
      {!isLoading && snapshot?.commits.length === 0 ? (
        <div className="git-empty">Ce dépôt ne contient encore aucun commit.</div>
      ) : null}

      {snapshot ? (
        <>
          <section className="git-ref-strip" aria-label="Branches et worktrees">
            <div>
              <span className="git-section-label">Branches</span>
              <div className="git-chips">
                {snapshot.branches.map((branch) => (
                  <button
                    type="button"
                    className={branch.current ? 'is-current' : ''}
                    key={branch.fullName}
                    onClick={() => setHeadRef(branch.sha)}
                    title={`Comparer vers ${branch.name}`}
                  >
                    {branch.current ? '● ' : ''}{branch.name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="git-section-label">Espaces de travail</span>
              <div className="git-worktree-list">
                {snapshot.worktrees.map((worktree) => (
                  <span key={worktree.path} title={worktree.path}>
                    {worktree.branch ?? (worktree.detached ? 'détaché' : 'worktree')}
                    <small>{worktree.path}</small>
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="git-history" aria-label="Graphe des commits">
            <div className="git-section-heading">
              <h2>Commits</h2>
              <span>{snapshot.commits.length} derniers points d’histoire</span>
            </div>
            <div className="git-commit-list">
              {rows.map((row) => {
                const width = maxLanes * 22
                return (
                  <article className="git-commit" key={row.commit.sha}>
                    <svg
                      className="git-lanes"
                      width={width}
                      height="58"
                      viewBox={`0 0 ${width} 58`}
                      aria-hidden="true"
                    >
                      {row.segments.map((segment, index) => (
                        <path
                          key={`${segment.from}-${segment.to}-${index}`}
                          d={`M ${segment.from * 22 + 11} 0 L ${segment.to * 22 + 11} 58`}
                          className={segment.kind === 'parent' ? 'is-parent' : ''}
                        />
                      ))}
                      <circle cx={row.lane * 22 + 11} cy="19" r="4.5" />
                    </svg>
                    <div className="git-commit-copy">
                      <div className="git-commit-title">
                        <strong>{row.commit.subject}</strong>
                        <code>{shortSha(row.commit.sha)}</code>
                      </div>
                      <div className="git-commit-meta">
                        <span>{row.commit.author} · {commitDate(row.commit.authoredAt)}</span>
                        {row.commit.refs.map((ref) => <em key={ref}>{ref}</em>)}
                      </div>
                      <div className="git-commit-links">
                        {row.commit.conversations.map((conversation) => (
                          <button
                            type="button"
                            key={conversation.id}
                            onClick={() => onConversationSelect(conversation.id)}
                          >
                            Conversation · {conversation.title}
                          </button>
                        ))}
                        {row.commit.guardian.map((review) => (
                          <button
                            type="button"
                            className="git-guardian-link"
                            key={review.reviewId}
                            onClick={() => onGuardianSelect(review.reviewId)}
                          >
                            Gardien · {review.red} rouge · {review.orange} orange
                          </button>
                        ))}
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>

          <section className="git-compare" aria-label="Comparer deux références">
            <div className="git-section-heading">
              <div>
                <span className="git-section-label">Lecture ciblée</span>
                <h2>Comparer deux références</h2>
              </div>
              <div className="git-compare-controls">
                <label>
                  <span>Base</span>
                  <select value={baseRef} onChange={(event) => setBaseRef(event.target.value)}>
                    {refOptions.map(([value, label]) => <option value={value} key={`base-${value}`}>{label}</option>)}
                  </select>
                </label>
                <span aria-hidden="true">→</span>
                <label>
                  <span>Cible</span>
                  <select value={headRef} onChange={(event) => setHeadRef(event.target.value)}>
                    {refOptions.map(([value, label]) => <option value={value} key={`head-${value}`}>{label}</option>)}
                  </select>
                </label>
                <button type="button" onClick={() => void compare()} disabled={!baseRef || !headRef || isComparing}>
                  {isComparing ? 'Comparaison…' : 'Afficher le diff'}
                </button>
              </div>
            </div>
            {diff === null ? (
              <p className="git-diff-empty">Choisissez deux points pour relire exactement ce qui a changé.</p>
            ) : diff.trim() === '' ? (
              <p className="git-diff-empty">Aucune différence entre ces références.</p>
            ) : (
              <DiffViewer diff={diff} label="Diff Git" />
            )}
          </section>
        </>
      ) : null}
    </div>
  )
}

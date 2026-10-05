import { useEffect, useState, useSyncExternalStore } from 'react'
import { launchRequest } from './api'
import Markdown from './Markdown'

type Resume = {
  content: string
  conversations: Array<{ id: string; title: string }>
}
type Snapshot = { data?: Resume; error?: string; loading?: boolean }
const stores = new Map<
  string,
  { snapshot: Snapshot; listeners: Set<() => void>; started: boolean }
>()
function store(id: string) {
  let entry = stores.get(id)
  if (!entry) {
    entry = { snapshot: {}, listeners: new Set(), started: false }
    stores.set(id, entry)
  }
  return entry
}
function load(id: string, refresh: boolean) {
  const entry = store(id)
  entry.started = true
  entry.snapshot = { data: entry.snapshot.data, loading: true }
  entry.listeners.forEach((fn) => fn())
  void launchRequest<Resume>(
    `/api/projects/${id}/resume${refresh ? '?refresh=1' : ''}`,
  )
    .then(
      (data) => {
        entry.snapshot = { data }
      },
      (error) => {
        entry.snapshot = { data: entry.snapshot.data, error: String(error) }
      },
    )
    .finally(() => entry.listeners.forEach((fn) => fn()))
}
function subscribe(id: string, listener: () => void) {
  const entry = store(id)
  entry.listeners.add(listener)
  if (!entry.started) load(id, false)
  return () => {
    entry.listeners.delete(listener)
  }
}
function ResumeContent({
  projectId,
  onResume,
}: {
  projectId: string
  onResume: (conversationId: string) => void
}) {
  const snapshot = useSyncExternalStore(
    (listener) => subscribe(projectId, listener),
    () => store(projectId).snapshot,
  )
  return (
    <>
      {snapshot.error && <p role="alert">{snapshot.error}</p>}
      {snapshot.data ? (
        <>
          <Markdown>{snapshot.data.content}</Markdown>
          {snapshot.data.conversations.slice(0, 3).map((item) => (
            <button
              className="secondary-button"
              key={item.id}
              onClick={() => onResume(item.id)}
            >
              Reprendre · {item.title}
            </button>
          ))}
        </>
      ) : null}
      {snapshot.loading ? (
        <p className="project-resume-status">
          {snapshot.data ? 'Régénération…' : 'Préparation de la reprise…'}
        </p>
      ) : (
        <button
          type="button"
          className="project-resume-refresh"
          onClick={() => load(projectId, true)}
        >
          Régénérer
        </button>
      )}
    </>
  )
}
export function ProjectResume({
  projectId,
  onResume,
}: {
  projectId: string
  onResume: (conversationId: string) => void
}) {
  return (
    <details className="project-resume" open>
      <summary>Où j’en suis</summary>
      <ResumeContent projectId={projectId} onResume={onResume} />
    </details>
  )
}
export function InactiveProjectResume({
  projectId,
  onResume,
}: {
  projectId: string
  onResume: (conversationId: string) => void
}) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    let ignore = false
    setShow(false)
    void launchRequest<{ showAutomatically: boolean }>(
      `/api/projects/${projectId}/resume/status`,
    ).then(
      (status) => {
        if (!ignore) setShow(status.showAutomatically)
      },
      () => {},
    )
    return () => {
      ignore = true
    }
  }, [projectId])
  return show ? (
    <div className="welcome-resume">
      <p className="welcome-resume-hint">Ce projet attend votre reprise.</p>
      <ProjectResume projectId={projectId} onResume={onResume} />
    </div>
  ) : null
}

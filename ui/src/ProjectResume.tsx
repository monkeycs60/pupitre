import { useSyncExternalStore } from 'react'
import { launchRequest } from './api'
import Markdown from './Markdown'

type Resume = {
  content: string
  chantiers: Array<{ id: string; key: string; title: string }>
}
type Snapshot = { data?: Resume; error?: string }
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
function subscribe(id: string, listener: () => void) {
  const entry = store(id)
  entry.listeners.add(listener)
  if (!entry.started) {
    entry.started = true
    void launchRequest<Resume>(`/api/projects/${id}/resume`)
      .then(
        (data) => {
          entry.snapshot = { data }
        },
        (error) => {
          entry.snapshot = { error: String(error) }
        },
      )
      .finally(() => entry.listeners.forEach((fn) => fn()))
  }
  return () => {
    entry.listeners.delete(listener)
  }
}
function ResumeContent({
  projectId,
  onResume,
}: {
  projectId: string
  onResume: (id: string, key: string) => void
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
          {snapshot.data.chantiers.map((item) => (
            <button
              className="secondary-button"
              key={item.id}
              onClick={() => onResume(item.id, item.key)}
            >
              Reprendre · {item.title}
            </button>
          ))}
        </>
      ) : (
        <p>Préparation de la reprise…</p>
      )}
    </>
  )
}
export function ProjectResume({
  projectId,
  onResume,
}: {
  projectId: string
  onResume: (id: string, key: string) => void
}) {
  return (
    <details className="project-resume" open>
      <summary>Où j’en suis</summary>
      <ResumeContent projectId={projectId} onResume={onResume} />
    </details>
  )
}

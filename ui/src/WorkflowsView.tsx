import { useEffect, useState } from 'react'
import { listProjectWorkflows, runWorkflow } from './api'
import { WorkflowDialog } from './WorkflowDialog'
import type { Conversation, Project, Workflow } from './types'
import { filterWorkflows, workflowSummary } from './workflowSidebar'

export function WorkflowsView({ project, onConversationSelect }: { project: Project; onConversationSelect: (conversation: Conversation) => void }) {
  const [items, setItems] = useState<Workflow[]>([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Workflow | null | undefined>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let ignore = false
    void listProjectWorkflows(project.id).then((value) => { if (!ignore) setItems(value) }).catch((reason) => { if (!ignore) setError(String(reason)) })
    return () => { ignore = true }
  }, [project.id])
  async function run(id: string) {
    setBusy(id); setError(null)
    try { onConversationSelect(await runWorkflow(id)) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Lancement impossible') }
    finally { setBusy(null) }
  }
  return <section className="workflows-view">
    <div className="inspector-section-actions"><input aria-label="Filtrer les automatisations" placeholder="Rechercher…" value={query} onChange={(event) => setQuery(event.target.value)} /><button className="secondary-button" onClick={() => setEditing(null)}>Créer</button></div>
    {error ? <p role="alert">{error}</p> : null}
    {!items.length ? <p className="list-empty">Enregistre une consigne pour la réutiliser dans ce projet.</p> : null}
    {filterWorkflows(items, query).map((item) => <article className="automation-row" key={item.id}><div><strong>{item.name}</strong><p>{workflowSummary(item)}</p></div><div><button className="secondary-button" disabled={busy !== null} onClick={() => void run(item.id)}>{busy === item.id ? 'Lancement…' : 'Lancer'}</button><button className="text-button" onClick={() => setEditing(item)} aria-label={`Modifier ${item.name}`}>Modifier</button></div></article>)}
    {editing !== undefined ? <WorkflowDialog project={project} workflows={items} initialWorkflow={editing} onClose={() => setEditing(undefined)} onChanged={setItems} /> : null}
  </section>
}

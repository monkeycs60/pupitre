import { useState } from 'react'
import { completeTodo, deleteTodo, enqueueTodo, isStartable, reopenTodo, startTodo, TODO_FINISH_LABELS, TODO_LABELS, updateTodo, type TodoFinish, type TodoItem } from './todos'
import { modelLabel } from './modelOptions'
import { ConfigPanel, type ConversationConfig } from './ConfigPanel'
import { TicketSelect } from './TicketSelect'
import { ticketLinksOf } from './ticketLinks'
import type { Project, QuotaSnapshot } from './types'
import { mediaUrl } from './transport'
import './styles/todo-editor.css'

interface Props {
  item: TodoItem
  project: Project
  quotas: QuotaSnapshot
  hasTicketIntegration?: boolean
  onChanged: () => void
  onDeleted: () => void
  onOpenConversation: (item: TodoItem) => void
}

export function TodoDetail({ item, project, quotas, hasTicketIntegration = false, onChanged, onDeleted, onOpenConversation }: Props) {
  const [title, setTitle] = useState(item.title)
  const [message, setMessage] = useState(item.message === item.title ? '' : item.message)
  const [ticketId, setTicketId] = useState(item.ticket_id)
  const [config, setConfig] = useState<ConversationConfig>({
    provider: item.provider, model: item.model, effort: item.effort ?? 'high',
    speed: item.speed ?? 'standard', presetId: item.preset_id,
    permissionMode: item.permission_mode ?? null,
    branch: item.target_branch,
  })
  const [finish, setFinish] = useState<TodoFinish>(item.finish)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = item.status === 'running'
  const editable = isStartable(item)
  const canReopen = item.status === 'done'

  async function act(label: string, action: () => Promise<unknown>) {
    setBusy(label)
    setError(null)
    try { await action(); onChanged() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Action impossible') }
    finally { setBusy(null) }
  }

  const payload = () => ({
    title: title.trim(), message: message.trim() || title.trim(), ticketId,
    targetBranch: config.branch?.trim() || null,
    provider: config.provider, model: config.model, effort: config.effort, speed: config.speed,
    presetId: config.presetId, permissionMode: config.permissionMode,
    finish,
  })
  const canSave = !!title.trim()

  return <section className="todo-detail todo-ticket-detail" aria-label="Détail de la tâche">
    <header className="todo-detail-header"><span>{project.name} <span aria-hidden="true">/</span> Tâches</span><span className={`todo-row-state is-${item.status}`}>{TODO_LABELS[item.status]}</span></header>
    <form onSubmit={(event) => { event.preventDefault(); if (canSave && !busy && editable) void act('save', () => updateTodo(item.id, payload())) }}>
      {editable ? <textarea className="todo-title-input" aria-label="Titre de la tâche" rows={2} value={title} onChange={(event) => setTitle(event.target.value)} required /> : <h1>{item.title}</h1>}
      <p className="todo-ticket-meta">Créée le {new Date(item.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</p>
      <label className="todo-field todo-description-field"><span>Description</span><textarea aria-label="Description de la tâche" value={message} onChange={(event) => setMessage(event.target.value)} readOnly={!editable} rows={4} placeholder={editable ? 'Ajouter du contexte, des liens, le résultat attendu…' : 'Aucune description'} /></label>
      {item.attachments?.length ? <div className="todo-attachments" aria-label="Pièces jointes">{item.attachments.map((file) => <a key={file.name} href={mediaUrl(file.name)} target="_blank" rel="noreferrer">{file.originalName}</a>)}</div> : null}
      {hasTicketIntegration || ticketId ? <fieldset className="todo-ticket-field" disabled={!editable || !!busy}>
        <TicketSelect projectId={project.id} value={ticketId} onChange={(ticket) => {
          setTicketId(ticket?.id ?? null)
          setConfig((current) => ({ ...current, ticketKey: ticket?.key ?? null, branch: ticket ? ticketLinksOf(ticket).branch ?? current.branch : current.branch }))
        }} />
      </fieldset> : null}
      {item.error || error ? <p className="todo-error" role="alert">{error ?? item.error}</p> : null}
      <div className="todo-detail-actions todo-ticket-actions">
        {editable ? <>
          <button className="primary-button" type="button" disabled={!!busy || !canSave} onClick={() => void act('start', async () => { await updateTodo(item.id, payload()); await startTodo(item.id) })}>{busy === 'start' ? 'Lancement…' : 'Lancer l’agent'}</button>
          {item.status !== 'queued' ? <button className="secondary-button" type="button" disabled={!!busy || !canSave} onClick={() => void act('enqueue', async () => { await updateTodo(item.id, payload()); await enqueueTodo(item.id) })}>{busy === 'enqueue' ? 'Ajout…' : 'Mettre en file'}</button> : null}
        </> : null}
        <button className="secondary-button" type="button" onClick={() => onOpenConversation(item)}>{item.conversation_id ? 'Ouvrir la conversation →' : 'Ouvrir dans une conversation →'}</button>
        {!running && !canReopen ? <button className="secondary-button" type="button" disabled={!!busy} onClick={() => void act('complete', async () => { if (editable && canSave) await updateTodo(item.id, payload()); await completeTodo(item.id) })}>{busy === 'complete' ? 'Clôture…' : 'Terminer'}</button> : null}
        {canReopen ? <button className="secondary-button" type="button" disabled={!!busy} onClick={() => void act('reopen', () => reopenTodo(item.id))}>{busy === 'reopen' ? 'Réouverture…' : 'Rouvrir la tâche'}</button> : null}
      </div>
      <details className="todo-agent-options" open={editable || undefined}>
        <summary>Options de l’agent <span>{modelLabel(config.model)} · {TODO_FINISH_LABELS[finish]}</span></summary>
        {editable ? <div className="todo-config">
          <span>Modèle et branche cible</span>
          <ConfigPanel project={project} quotas={quotas} config={config} onConfigChange={setConfig} onError={setError} placement="bottom" applyProjectDefault={false} />
        </div> : <p className="todo-model">{modelLabel(config.model)} · Branche cible : {item.target_branch || 'Branche courante'}</p>}
        <label className="todo-field todo-finish-field"><span>Une fois l’agent terminé</span><select value={finish} disabled={!editable} onChange={(event) => setFinish(event.target.value as TodoFinish)}>{(Object.keys(TODO_FINISH_LABELS) as TodoFinish[]).map((value) => <option key={value} value={value}>{TODO_FINISH_LABELS[value]}</option>)}</select></label>
        {item.branch ? <p className="todo-worktree">{item.branch}<br /><span>{item.worktree_path}</span></p> : <p className="todo-footnote">L’agent travaillera dans une branche et un dossier dédiés.</p>}
      </details>
      <div className="todo-detail-actions todo-save-actions">
        {editable ? <button className="secondary-button" type="submit" disabled={!!busy || !canSave}>{busy === 'save' ? 'Enregistrement…' : 'Enregistrer les modifications'}</button> : null}
        {!running ? <button className="text-button todo-delete" type="button" disabled={!!busy} onClick={() => void act('delete', async () => { await deleteTodo(item.id); onDeleted() })}>Supprimer la tâche</button> : null}
      </div>
    </form>
  </section>
}

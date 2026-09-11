import { useState } from 'react'
import { completeTodo, deleteTodo, enqueueTodo, reconcileTodo, reopenTodo, startTodo, TODO_LABELS, updateTodo, type TodoItem } from './todos'
import { modelLabel } from './modelOptions'
import { ConfigPanel, type ConversationConfig } from './ConfigPanel'
import { TicketSelect } from './TicketSelect'
import { ticketLinksOf } from './ticketLinks'
import type { Project, QuotaSnapshot } from './types'
import { mediaUrl } from './transport'
import './styles/todo-editor.css'

interface Props {
  item: TodoItem
  items: TodoItem[]
  project: Project
  quotas: QuotaSnapshot
  hasTicketIntegration?: boolean
  onChanged: () => void
  onDeleted: () => void
  onConversationSelect: (id: string) => void
}

export function TodoDetail({ item, items, project, quotas, hasTicketIntegration = false, onChanged, onDeleted, onConversationSelect }: Props) {
  const [title, setTitle] = useState(item.title)
  const [message, setMessage] = useState(item.message === item.title ? '' : item.message)
  const [ticketId, setTicketId] = useState(item.ticket_id)
  const [config, setConfig] = useState<ConversationConfig>({
    provider: item.provider, model: item.model, effort: item.effort ?? 'high',
    speed: item.speed ?? 'standard', presetId: item.preset_id,
    permissionMode: item.permission_mode ?? null,
    branch: item.target_branch,
  })
  const [integrate, setIntegrate] = useState(item.integrate)
  const [autonomy, setAutonomy] = useState(item.autonomy)
  const [dependsOn, setDependsOn] = useState(item.depends_on ?? '')
  const [checks, setChecks] = useState((item.checks ?? []).join('\n'))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hasExecution = !!(item.conversation_id || item.branch || item.worktree_path)
  const editable = !hasExecution && (item.status === 'backlog' || item.status === 'queued' || item.status === 'blocked')
  const canComplete = editable
  const canReopen = !hasExecution && item.status === 'done'
  const canReconcile = !!item.conversation_id && (item.status === 'awaiting_validation' || item.status === 'blocked') && item.autonomy === 'local'

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
    integrate, autonomy, dependsOn: dependsOn || null,
    checks: checks.split('\n').map((line) => line.trim()).filter(Boolean),
  })
  const canSave = !!title.trim()
  const canStart = editable && canSave && (!integrate || !!checks.trim())
  const dependencies = items.filter((other) => other.id !== item.id && other.ticket_id === ticketId)

  return <section className="todo-detail todo-ticket-detail" aria-label="Détail de la tâche">
    <header className="todo-detail-header"><span>{project.name} <span aria-hidden="true">/</span> Tâches</span><span className={`todo-row-state is-${item.status}`}>{TODO_LABELS[item.status]}</span></header>
    <form onSubmit={(event) => { event.preventDefault(); if (canSave && !busy) void act('save', () => updateTodo(item.id, payload())) }}>
      {editable ? <textarea className="todo-title-input" aria-label="Titre de la tâche" rows={2} value={title} onChange={(event) => setTitle(event.target.value)} required /> : <h1>{item.title}</h1>}
      <p className="todo-ticket-meta">Créée le {new Date(item.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</p>
      <label className="todo-field todo-description-field"><span>Description</span><textarea aria-label="Description de la tâche" value={message} onChange={(event) => setMessage(event.target.value)} readOnly={!editable} rows={4} placeholder={editable ? 'Ajouter du contexte, des liens, le résultat attendu…' : 'Aucune description'} /></label>
      {item.attachments?.length ? <div className="todo-attachments" aria-label="Pièces jointes">{item.attachments.map((file) => <a key={file.name} href={mediaUrl(file.name)} target="_blank" rel="noreferrer">{file.originalName}</a>)}</div> : null}
      {hasTicketIntegration || ticketId ? <fieldset className="todo-ticket-field" disabled={!editable || !!busy}>
        <TicketSelect projectId={project.id} value={ticketId} onChange={(ticket) => {
          setTicketId(ticket?.id ?? null)
          setDependsOn('')
          setConfig((current) => ({ ...current, ticketKey: ticket?.key ?? null, branch: ticket ? ticketLinksOf(ticket).branch ?? current.branch : current.branch }))
        }} />
      </fieldset> : null}
      {item.error || error ? <p className="todo-error" role="alert">{error ?? item.error}</p> : null}
      <div className="todo-detail-actions todo-ticket-actions">
        {editable ? <>
          <button className="primary-button" type="button" disabled={!!busy || !canStart} onClick={() => void act('start', async () => { await updateTodo(item.id, payload()); await startTodo(item.id) })}>{busy === 'start' ? 'Lancement…' : 'Lancer l’agent'}</button>
          {item.status !== 'queued' ? <button className="secondary-button" type="button" disabled={!!busy || !canStart} onClick={() => void act('enqueue', async () => { await updateTodo(item.id, payload()); await enqueueTodo(item.id) })}>{busy === 'enqueue' ? 'Ajout…' : 'Mettre en file'}</button> : null}
          {canComplete ? <button className="secondary-button" type="button" disabled={!!busy || !canSave} onClick={() => void act('complete', async () => { await updateTodo(item.id, payload()); await completeTodo(item.id) })}>{busy === 'complete' ? 'Clôture…' : 'Terminer'}</button> : null}
        </> : null}
        {canReopen ? <button className="secondary-button" type="button" disabled={!!busy} onClick={() => void act('reopen', () => reopenTodo(item.id))}>{busy === 'reopen' ? 'Réouverture…' : 'Rouvrir la tâche'}</button> : null}
        {item.conversation_id ? <button className="secondary-button" type="button" onClick={() => onConversationSelect(item.conversation_id!)}>Ouvrir la conversation →</button> : null}
        {canReconcile ? <button className="primary-button" type="button" disabled={!!busy || !checks.trim()} onClick={() => void act('reconcile', async () => { await updateTodo(item.id, { checks: payload().checks }); await reconcileTodo(item.id) })}>{busy === 'reconcile' ? 'Intégration…' : 'Valider, intégrer et pousser'}</button> : null}
      </div>
      <details className="todo-agent-options" open={canReconcile || undefined}>
        <summary>Options de l’agent <span>{modelLabel(config.model)}</span></summary>
        {editable ? <div className="todo-config">
          <span>Modèle et branche cible</span>
          <ConfigPanel project={project} quotas={quotas} config={config} onConfigChange={setConfig} onError={setError} placement="bottom" applyProjectDefault={false} />
        </div> : <p className="todo-model">{modelLabel(config.model)} · Branche cible : {item.target_branch ?? 'Branche courante'}</p>}
        <div className="todo-settings">
          <label className="todo-field"><span>Autonomie</span><select value={autonomy} disabled={!editable} onChange={(event) => { const value = event.target.value as TodoItem['autonomy']; setAutonomy(value); if (value === 'investigate') setIntegrate(false) }}><option value="local">Corrections locales</option><option value="investigate">Enquête et propositions</option></select></label>
          <label className="todo-field"><span>Après intégration de</span><select value={dependsOn} disabled={!editable || dependencies.length === 0} onChange={(event) => setDependsOn(event.target.value)}><option value="">Aucune dépendance</option>{dependencies.map((other) => <option key={other.id} value={other.id}>{other.title}</option>)}</select></label>
        </div>
        <label className="todo-integrate"><input type="checkbox" checked={integrate} disabled={!editable || autonomy === 'investigate'} onChange={(event) => setIntegrate(event.target.checked)} /><span><strong>Intégrer et pousser</strong><span>Après vérification, fusionner dans la branche cible et publier les changements.</span></span></label>
        <details className="todo-verification" open={integrate || canReconcile || undefined}>
          <summary>Vérifications avant intégration</summary>
          <label className="todo-field"><span>Commandes à exécuter, une par ligne</span><textarea aria-label="Commandes de vérification" rows={3} value={checks} onChange={(event) => setChecks(event.target.value)} readOnly={!editable && !canReconcile} placeholder="bun test" /></label>
          {integrate && !checks.trim() ? <p>Renseigne les vérifications pour autoriser l’intégration automatique.</p> : null}
        </details>
        {item.branch ? <p className="todo-worktree">{item.branch}<br /><span>{item.worktree_path}</span></p> : <p className="todo-footnote">L’agent travaillera dans une branche et un dossier dédiés.</p>}
      </details>
      {editable ? <div className="todo-detail-actions todo-save-actions">
        <button className="secondary-button" type="submit" disabled={!!busy || !canSave}>{busy === 'save' ? 'Enregistrement…' : 'Enregistrer les modifications'}</button>
        <button className="text-button todo-delete" type="button" disabled={!!busy} onClick={() => void act('delete', async () => { await deleteTodo(item.id); onDeleted() })}>Supprimer la tâche</button>
      </div> : null}
    </form>
  </section>
}

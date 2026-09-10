import { useState } from 'react'
import { deleteTodo, reconcileTodo, startTodo, TODO_LABELS, updateTodo, type TodoItem } from './todos'
import { modelLabel } from './modelOptions'
import { ConfigPanel, type ConversationConfig } from './ConfigPanel'
import type { Project, QuotaSnapshot } from './types'
import { mediaUrl } from './transport'

interface Props {
  item: TodoItem
  items: TodoItem[]
  project: Project
  quotas: QuotaSnapshot
  onProjectUpdated: (project: Project) => void
  onChanged: () => void
  onDeleted: () => void
  onConversationSelect: (id: string) => void
}
export function TodoDetail({ item, items, project, quotas, onProjectUpdated, onChanged, onDeleted, onConversationSelect }: Props) {
  const [title, setTitle] = useState(item.title)
  const [message, setMessage] = useState(item.message)
  const [config, setConfig] = useState<ConversationConfig>({
    provider: item.provider, model: item.model, effort: item.effort ?? 'high',
    speed: item.speed ?? 'standard', presetId: item.preset_id,
    permissionMode: item.permission_mode ?? null, orchestrator: item.orchestrator ?? true,
    subagentPresetId: item.subagent_preset_id ?? null, subagentEffort: item.subagent_effort ?? null,
    branch: item.target_branch,
  })
  const [integrate, setIntegrate] = useState(item.integrate)
  const [autonomy, setAutonomy] = useState(item.autonomy)
  const [dependsOn, setDependsOn] = useState(item.depends_on ?? '')
  const [checks, setChecks] = useState((item.checks ?? []).join('\n'))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const editable = item.status === 'queued' || (item.status === 'blocked' && !item.conversation_id)
  async function act(label: string, action: () => Promise<unknown>) {
    setBusy(label); setError(null)
    try { await action(); onChanged() } catch (reason) { setError(reason instanceof Error ? reason.message : 'Action impossible') }
    finally { setBusy(null) }
  }
  const payload = () => ({ title, message, targetBranch: config.branch?.trim() || null,
    provider: config.provider, model: config.model, effort: config.effort, speed: config.speed,
    presetId: config.presetId, permissionMode: config.permissionMode, orchestrator: config.orchestrator,
    subagentPresetId: config.subagentPresetId, subagentEffort: config.subagentEffort, integrate, autonomy, dependsOn: dependsOn || null, checks: checks.split('\n').map((line) => line.trim()).filter(Boolean) })
  const canStart = editable && !!message.trim() && (!integrate || !!checks.trim())
  const dependencies = items.filter((other) => other.id !== item.id && other.ticket_id === item.ticket_id)
  return <section className="todo-detail" aria-label="Détail de la TODO">
    <header className="todo-detail-header"><span>{project.name} <span aria-hidden="true">/</span> TODO</span><span className={`todo-row-state is-${item.status}`}>{TODO_LABELS[item.status]}</span></header>
    <form onSubmit={(event) => { event.preventDefault(); void act('save', () => updateTodo(item.id, payload())) }}>
      {editable ? <input className="todo-title-input" aria-label="Titre de la TODO" value={title} onChange={(event) => setTitle(event.target.value)} required /> : <h1>{item.title}</h1>}
      <p className="todo-model">{modelLabel(config.model)} · {item.autonomy === 'investigate' ? 'Enquête' : 'Corrections locales'}</p>
      <label className="todo-field"><span>Consigne</span><textarea aria-label="Consigne de la TODO" value={message} onChange={(event) => setMessage(event.target.value)} readOnly={!editable} rows={7} required /></label>
      {item.attachments?.length ? <div className="todo-attachments">{item.attachments.map((file) => <a key={file.name} href={mediaUrl(file.name)} target="_blank" rel="noreferrer">{file.originalName}</a>)}</div> : null}
      {editable ? <div className="todo-config">
        <span>Modèle et branche cible</span>
        <ConfigPanel project={project} quotas={quotas} config={config} onConfigChange={setConfig} onProjectUpdated={onProjectUpdated} onError={setError} applyProjectDefault={false} />
      </div> : <p className="todo-model">Branche cible : {item.target_branch}</p>}
      <div className="todo-settings">
        <label className="todo-field"><span>Autonomie</span><select value={autonomy} disabled={!editable} onChange={(event) => { const value = event.target.value as TodoItem['autonomy']; setAutonomy(value); if (value === 'investigate') setIntegrate(false) }}><option value="local">Corrections locales</option><option value="investigate">Enquête et propositions</option></select></label>
        <label className="todo-field"><span>Après intégration de</span><select value={dependsOn} disabled={!editable} onChange={(event) => setDependsOn(event.target.value)}><option value="">Aucune dépendance</option>{dependencies.map((other) => <option key={other.id} value={other.id}>{other.title}</option>)}</select></label>
      </div>
      <label className="todo-integrate"><input type="checkbox" checked={integrate} disabled={!editable || autonomy === 'investigate'} onChange={(event) => setIntegrate(event.target.checked)} /><span><strong>Intégrer et pousser</strong><span>Après vérification, réunir les changements dans la branche cible et les publier. La TODO suivante partira de ce résultat.</span></span></label>
      <details className="todo-verification" open={integrate || undefined}>
        <summary>Vérifications avant intégration</summary>
        <label className="todo-field"><span>Commandes à exécuter, une par ligne</span><textarea aria-label="Commandes de vérification" rows={3} value={checks} onChange={(event) => setChecks(event.target.value)} readOnly={!editable && item.status === 'done'} placeholder="bun test" /></label>
        {integrate && !checks.trim() ? <p>Renseigne les vérifications pour autoriser l’intégration automatique.</p> : null}
      </details>
      {item.error || error ? <p className="todo-error" role="alert">{error ?? item.error}</p> : null}
      <div className="todo-detail-actions">
        {editable ? <>
          <button className="primary-button" type="button" disabled={!!busy || !canStart} onClick={() => void act('start', async () => { await updateTodo(item.id, payload()); await startTodo(item.id) })}>{busy === 'start' ? 'Lancement…' : 'Lancer maintenant'}</button>
          <button className="secondary-button" type="submit" disabled={!!busy || !message.trim()}>{busy === 'save' ? 'Enregistrement…' : 'Enregistrer'}</button>
          <button className="text-button todo-delete" type="button" disabled={!!busy} onClick={() => void act('delete', async () => { await deleteTodo(item.id); onDeleted() })}>Supprimer la TODO</button>
        </> : null}
        {item.conversation_id ? <button className="secondary-button" type="button" onClick={() => onConversationSelect(item.conversation_id!)}>Ouvrir la conversation →</button> : null}
        {item.conversation_id && (item.status === 'awaiting_validation' || item.status === 'blocked') && item.autonomy === 'local' ? <button className="primary-button" type="button" disabled={!!busy || !checks.trim()} onClick={() => void act('reconcile', async () => { await updateTodo(item.id, { checks: payload().checks }); await reconcileTodo(item.id) })}>{busy === 'reconcile' ? 'Intégration…' : 'Valider, intégrer et pousser'}</button> : null}
      </div>
      {item.branch ? <p className="todo-worktree">{item.branch}<br /><span>{item.worktree_path}</span></p> : <p className="todo-footnote">Une branche et un dossier de travail dédiés seront créés au lancement.</p>}
    </form>
  </section>
}

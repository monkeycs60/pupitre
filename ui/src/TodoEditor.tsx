import { useRef, useState, type FormEvent } from 'react'
import { uploadMedia } from './api'
import { ConfigPanel, type ConversationConfig } from './ConfigPanel'
import { PROVIDER_MODELS } from './modelOptions'
import { TicketSelect } from './TicketSelect'
import { ticketLinksOf } from './ticketLinks'
import { buildTodoInput } from './todoDraft'
import { createTodo, type TodoItem } from './todos'
import { mediaUrl } from './transport'
import type { Attachment, Project, QuotaSnapshot } from './types'

interface Props {
  project: Project
  items: TodoItem[]
  quotas: QuotaSnapshot
  initialTicketId?: string | null
  onProjectUpdated: (project: Project) => void
  onCreated: (todo: TodoItem) => void
  onCancel: () => void
}

export function TodoEditor({ project, items, quotas, initialTicketId = null, onProjectUpdated, onCreated, onCancel }: Props) {
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [ticketId, setTicketId] = useState<string | null>(initialTicketId)
  const [autonomy, setAutonomy] = useState<'local' | 'investigate'>('local')
  const [integrate, setIntegrate] = useState(false)
  const [checks, setChecks] = useState('')
  const [dependsOn, setDependsOn] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [pending, setPending] = useState(0)
  const [configReady, setConfigReady] = useState(false)
  const [config, setConfig] = useState<ConversationConfig>({
    presetId: null,
    provider: 'claude',
    model: PROVIDER_MODELS.claude[0],
    effort: 'high',
    speed: 'standard',
    permissionMode: null,
    orchestrator: true,
    subagentPresetId: null,
    subagentEffort: null,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const dependencies = items.filter((item) => item.ticket_id === ticketId && item.status !== 'done')
  const canSubmit = configReady && !busy && pending === 0 && message.trim().length > 0 && (!integrate || checks.trim().length > 0)

  async function attach(files: File[]) {
    if (files.length === 0) return
    setPending((count) => count + files.length)
    setError(null)
    const results = await Promise.allSettled(files.map((file) => uploadMedia(file, file.name)))
    setAttachments((current) => [...current, ...results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])])
    if (results.some((result) => result.status === 'rejected')) setError('Impossible de téléverser une pièce jointe.')
    setPending((count) => count - files.length)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const input = buildTodoInput(config, { message: message.trim(), ticketId, integrate, autonomy, checks, attachments })
      onCreated(await createTodo(project.id, { ...input, title: title.trim() || undefined, dependsOn: dependsOn || null }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Création impossible')
      setBusy(false)
    }
  }

  return <section className="todo-detail todo-editor" aria-label="Nouvelle TODO">
    <header className="todo-detail-header"><span>{project.name} <span aria-hidden="true">/</span> TODO</span><span>Nouvelle</span></header>
    <form onSubmit={(event) => void submit(event)}>
      <input className="todo-title-input" aria-label="Titre de la TODO" placeholder="Titre (facultatif, déduit de la consigne)" value={title} onChange={(event) => setTitle(event.target.value)} />
      <p className="todo-model">Préparée maintenant, lancée quand tu dépiles la file, dans une branche et un dossier de travail dédiés.</p>
      <label className="todo-field"><span>Consigne</span><textarea aria-label="Consigne de la TODO" autoFocus rows={8} required placeholder="Ce que l’agent doit faire, et le résultat attendu." value={message} onChange={(event) => setMessage(event.target.value)} /></label>
      <div className="todo-attach">
        {attachments.length > 0 || pending > 0 ? <div className="composer-attachments" aria-label="Pièces jointes">
          {attachments.map((attachment) => attachment.mimeType.startsWith('image/')
            ? <div className="composer-image" key={attachment.name}>
                <img src={mediaUrl(attachment.name)} alt={attachment.originalName} />
                <button type="button" aria-label={`Retirer ${attachment.originalName}`} onClick={() => setAttachments((current) => current.filter((item) => item.name !== attachment.name))}>×</button>
              </div>
            : <div className="composer-file" key={attachment.name}>
                <span className="composer-file-kind" aria-hidden="true">{attachment.originalName.split('.').pop()?.toUpperCase() ?? 'FICHIER'}</span>
                <span className="composer-file-name" title={attachment.originalName}>{attachment.originalName}</span>
                <button type="button" aria-label={`Retirer ${attachment.originalName}`} onClick={() => setAttachments((current) => current.filter((item) => item.name !== attachment.name))}>×</button>
              </div>)}
          {pending > 0 ? <span className="todo-attach-pending" role="status">Téléversement…</span> : null}
        </div> : null}
        <button type="button" className="text-button" onClick={() => fileInput.current?.click()}>Joindre des images ou des fichiers</button>
        <input ref={fileInput} className="composer-file-input" type="file" multiple accept="image/*,.csv,.doc,.docx,.json,.md,.pdf,.txt,.xls,.xlsx,.xml,.zip" onChange={(event) => { void attach(Array.from(event.target.files ?? [])); event.target.value = '' }} />
      </div>
      <div className="todo-settings">
        <TicketSelect projectId={project.id} value={ticketId} onChange={(ticket) => {
          setTicketId(ticket?.id ?? null)
          setDependsOn('')
          setConfig((current) => ({ ...current, ticketKey: ticket?.key ?? null, branch: ticket ? ticketLinksOf(ticket).branch ?? current.branch : current.branch }))
        }} />
        <label className="todo-field"><span>Autonomie</span><select value={autonomy} onChange={(event) => { const value = event.target.value as 'local' | 'investigate'; setAutonomy(value); if (value === 'investigate') setIntegrate(false) }}><option value="local">Corrections locales</option><option value="investigate">Enquête et propositions</option></select></label>
        <label className="todo-field"><span>Après intégration de</span><select value={dependsOn} disabled={dependencies.length === 0} onChange={(event) => setDependsOn(event.target.value)}><option value="">Aucune dépendance</option>{dependencies.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      </div>
      <div className="todo-config">
        <span>Modèle et branche cible</span>
        <ConfigPanel project={project} quotas={quotas} config={config} onConfigChange={setConfig} onProjectUpdated={onProjectUpdated} onError={setError} onReady={setConfigReady} />
      </div>
      <label className="todo-integrate"><input type="checkbox" checked={integrate} disabled={autonomy === 'investigate'} onChange={(event) => setIntegrate(event.target.checked)} /><span><strong>Intégrer et pousser</strong><span>Après vérification, réunir les changements dans la branche cible et les publier. La TODO suivante partira de ce résultat.</span></span></label>
      <details className="todo-verification" open={integrate || undefined}>
        <summary>Vérifications avant intégration</summary>
        <label className="todo-field"><span>Commandes à exécuter, une par ligne</span><textarea aria-label="Commandes de vérification" rows={3} value={checks} onChange={(event) => setChecks(event.target.value)} placeholder="bun test" /></label>
        {integrate && !checks.trim() ? <p>Renseigne les vérifications pour autoriser l’intégration automatique.</p> : null}
      </details>
      {error ? <p className="todo-error" role="alert">{error}</p> : null}
      <div className="todo-detail-actions">
        <button className="primary-button" type="submit" disabled={!canSubmit}>{busy ? 'Ajout…' : 'Ajouter à la file'}</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>Annuler</button>
      </div>
    </form>
  </section>
}

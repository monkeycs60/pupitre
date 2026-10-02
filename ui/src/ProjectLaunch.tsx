import { useState } from 'react'
import { launchRequest } from './api'
import type { Project } from './types'

type Command = { id: string; project_id: string; name: string; command: string; cwd_relative: string; port: number | null; kind: string; running?: boolean; logs?: string; url?: string }
type Suggestion = { name: string; command: string; frequency?: number }

export function ProjectLaunch({ project, conversationId, settings = false }: { project: Project; conversationId?: string; settings?: boolean }) {
  const [open, setOpen] = useState(false)
  const [commands, setCommands] = useState<Command[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [error, setError] = useState('')
  const [output, setOutput] = useState('')
  const [name, setName] = useState('Serveur de dev')
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('.')
  const [port, setPort] = useState('')
  const [kind, setKind] = useState('run')
  const [workspace, setWorkspace] = useState('')
  const [busy, setBusy] = useState(false)
  const base = `/api/projects/${project.id}/launch`
  async function load() {
    setError('')
    try {
      setCommands(await launchRequest<Command[]>(base))
      if (settings) setSuggestions(await launchRequest<Suggestion[]>(`${base}/suggestions`))
      setOpen(true)
    } catch (error) { setError(String(error)) }
  }
  async function execute(id: string) {
    setBusy(true); setError('')
    try {
      const result = await launchRequest<Command>(`${base}/${id}`, 'POST', { conversationId: workspace || undefined, port: port ? Number(port) : undefined })
      setOutput(`${result.url ?? ''}\n${result.logs ?? ''}`)
    } catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  async function save() {
    setBusy(true); setError('')
    try {
      await launchRequest(base, 'PUT', { name, command, cwd_relative: cwd, port: port ? Number(port) : null, kind })
      await load(); setCommand('')
    } catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  return <div style={{ position: 'relative' }}>
    <button className="secondary-button" type="button" aria-label={settings ? 'Configurer le lancement' : `Lancer ${project.name}`} onClick={() => open ? setOpen(false) : void load()}>{settings ? 'Lancement' : '▶'}</button>
    {open && <div className={settings ? 'project-settings-defaults' : 'conversation-actions-menu'} style={settings ? undefined : { position: 'absolute', top: '100%', right: 0, minWidth: 280, zIndex: 20 }}>
      {conversationId && <label>Répertoire<select value={workspace} onChange={(event) => setWorkspace(event.target.value)}><option value="">Projet principal</option><option value={conversationId}>Conversation actuelle</option></select></label>}
      {commands.length === 0 && <p>Aucune commande. Configurez le lancement dans les paramètres du projet.</p>}
      {commands.map((item) => <div key={item.id}>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void execute(item.id)}>▶ {item.name}{item.kind === 'deploy' ? ' · Déployer' : ''}</button>
        {settings && <><code>{item.command}</code><button className="secondary-button" type="button" onClick={() => { setName(item.name); setCommand(item.command); setCwd(item.cwd_relative); setPort(item.port ? String(item.port) : ''); setKind(item.kind) }}>Copier</button><button className="secondary-button" type="button" onClick={() => void launchRequest(`${base}/${item.id}`, 'DELETE').then(load).catch((error) => setError(String(error)))}>Supprimer</button></>}
      </div>)}
      <label>Port alternatif<input type="number" value={port} onChange={(event) => setPort(event.target.value)} /></label>
      {settings && <>
        <label>Nom<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Commande<input value={command} onChange={(event) => setCommand(event.target.value)} /></label>
        <label>Sous-répertoire<input value={cwd} onChange={(event) => setCwd(event.target.value)} /></label>
        <label>Usage<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="run">Lancer</option><option value="deploy">Déployer</option></select></label>
        <button className="secondary-button" type="button" disabled={busy || !command.trim()} onClick={() => void save()}>Ajouter la commande</button>
        {suggestions.map((item, index) => <button className="secondary-button" type="button" key={index} onClick={() => { setName(item.name); setCommand(item.command) }}>{item.command}{item.frequency ? ` · ${item.frequency} conversations` : ''}</button>)}
      </>}
      {output && <pre>{output}</pre>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>
}

export function ManagedLaunches() {
  const [items, setItems] = useState<Command[]>([])
  const [error, setError] = useState('')
  async function refresh() {
    try { setItems(await launchRequest<Command[]>('/api/launches')); setError('') } catch (error) { setError(String(error)) }
  }
  async function action(item: Command, action: string) {
    try { await launchRequest(`/api/projects/${item.project_id}/launch/${item.id}/${action}`, 'POST', {}); await refresh() } catch (error) { setError(String(error)) }
  }
  return <section className="managed-launches" aria-label="Commandes de lancement">
    <button className="secondary-button" type="button" onClick={() => void refresh()}>Actualiser les commandes de lancement</button>
    {error && <p role="alert">{error}</p>}
    {items.map((item) => <div key={item.id}><strong>{item.name}</strong> · {item.running ? 'En cours' : 'Arrêtée'}
      <button className="secondary-button" type="button" disabled={!item.running} onClick={() => void action(item, 'stop')}>Arrêter</button>
      <button className="secondary-button" type="button" onClick={() => void action(item, 'restart')}>Relancer</button>
      {item.url && <a href={item.url} target="_blank" rel="noreferrer">Ouvrir</a>}
      <details><summary>Logs</summary><pre>{item.logs}</pre></details>
    </div>)}
  </section>
}

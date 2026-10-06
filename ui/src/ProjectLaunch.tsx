import { useState } from 'react'
import { launchRequest } from './api'
import { ExternalLink } from './externalLink'
import {
  launchUrlLabel,
  refreshProjectLaunches,
  useProjectLaunches,
  type LaunchCommand as Command,
  type LaunchUrl,
} from './projectLaunchStore'
import type { Project } from './types'

function commandUrls(item: Command): LaunchUrl[] {
  if (!item.running) return []
  if (item.urls?.length) return item.urls
  return item.url ? [{ url: item.url, port: 0, front: true, live: true }] : []
}

function LaunchLinks({ urls }: { urls: LaunchUrl[] }) {
  if (urls.length === 0)
    return <span className="launch-link is-pending">Démarrage…</span>
  return (
    <>
      {urls.map((item, index) => (
        <ExternalLink
          key={item.url}
          href={item.url}
          className={`launch-link${item.live ? ' is-live' : ' is-pending'}${index === 0 ? ' is-primary' : ''}`}
          title={item.live ? `Ouvrir ${item.url}` : `${item.url} n’écoute pas encore`}
        >
          {launchUrlLabel(item.url)}
          <span aria-hidden="true"> ↗</span>
        </ExternalLink>
      ))}
    </>
  )
}

async function stopLaunch(item: Command) {
  await launchRequest(
    `/api/projects/${item.project_id}/launch/${item.id}/stop`,
    'POST',
    {},
  )
  await refreshProjectLaunches(item.project_id)
}

export function ProjectLiveLaunches({ project }: { project: Project }) {
  const running = useProjectLaunches(project.id).filter((item) => item.running)
  if (running.length === 0) return null
  return (
    <div className="launch-live-strip" aria-label="Commandes en cours">
      {running.map((item) => {
        const urls = commandUrls(item)
        return (
          <div
            className={`launch-live-row${urls.some((url) => url.live) ? ' is-live' : ''}`}
            key={item.id}
          >
            <span className="launch-live-dot" aria-hidden="true" />
            <span className="launch-live-name" title={item.command}>
              {item.name}
            </span>
            <span className="launch-live-links">
              <LaunchLinks urls={urls} />
            </span>
            <button
              className="launch-live-stop"
              type="button"
              aria-label={`Arrêter ${item.name}`}
              title={`Arrêter ${item.name}`}
              onClick={() => void stopLaunch(item).catch(() => {})}
            >
              ■
            </button>
          </div>
        )
      })}
    </div>
  )
}
type Suggestion = { name: string; command: string; frequency?: number }

export function ProjectLaunch({
  project,
  conversationId,
  settings = false,
}: {
  project: Project
  conversationId?: string
  settings?: boolean
}) {
  const [open, setOpen] = useState(false)
  const commands = useProjectLaunches(project.id)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [error, setError] = useState('')
  const [output, setOutput] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [env, setEnv] = useState('{}')
  const [url, setUrl] = useState('')
  const [conflict, setConflict] = useState<{
    id: string
    pid: number
    process: string
    port: number
  } | null>(null)
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
      await refreshProjectLaunches(project.id)
      if (settings)
        setSuggestions(await launchRequest<Suggestion[]>(`${base}/suggestions`))
      setOpen(true)
    } catch (error) {
      setError(String(error))
    }
  }
  async function execute(id: string, replacePid?: number) {
    setBusy(true)
    setError('')
    try {
      const result = await launchRequest<Command>(`${base}/${id}`, 'POST', {
        conversationId: workspace || undefined,
        port: port ? Number(port) : undefined,
        replacePid,
      })
      setConflict(null)
      setOutput(result.logs ?? '')
      await refreshProjectLaunches(project.id)
    } catch (error) {
      setError(String(error))
      const owner = await launchRequest<{
        pid: number
        process: string
        port: number
      } | null>(
        `${base}/${id}/conflict${port ? `?port=${encodeURIComponent(port)}` : ''}`,
      ).catch(() => null)
      if (owner) setConflict({ id, ...owner })
    } finally {
      setBusy(false)
    }
  }
  async function stop(item: Command) {
    setBusy(true)
    setError('')
    try {
      await stopLaunch(item)
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }
  const live = commands.some((item) =>
    commandUrls(item).some((url) => url.live),
  )
  async function save() {
    setBusy(true)
    setError('')
    try {
      await launchRequest(`${base}${editingId ? `/${editingId}` : ''}`, 'PUT', {
        name,
        command,
        cwd_relative: cwd,
        env_json: env,
        url: url || null,
        port: port ? Number(port) : null,
        kind,
      })
      await load()
      setCommand('')
      setEditingId(null)
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={settings ? { position: 'relative' } : undefined}>
      <button
        className={`secondary-button${!settings && live ? ' launch-trigger is-live' : ''}`}
        type="button"
        aria-label={
          settings ? 'Configurer le lancement' : `Lancer ${project.name}`
        }
        title={!settings && live ? 'Une commande tourne' : undefined}
        onClick={() => (open ? setOpen(false) : void load())}
      >
        {settings ? 'Lancement' : '▶'}
      </button>
      {open && (
        <div
          className={
            settings
              ? 'project-settings-defaults'
              : 'conversation-actions-menu launch-menu'
          }
        >
          {conversationId && (
            <label>
              Répertoire
              <select
                value={workspace}
                onChange={(event) => setWorkspace(event.target.value)}
              >
                <option value="">Projet principal</option>
                <option value={conversationId}>Conversation actuelle</option>
              </select>
            </label>
          )}
          {commands.length === 0 && (
            <p>
              Aucune commande. Configurez le lancement dans les paramètres du
              projet.
            </p>
          )}
          {commands.map((item) => (
            <div
              key={item.id}
              className={item.running ? 'launch-running-row' : undefined}
            >
              {item.running ? (
                <>
                  <span className="launch-running-badge">
                    <span className="launch-live-dot" aria-hidden="true" />
                    En cours
                  </span>
                  <strong>{item.name}</strong>
                  <span className="launch-live-links">
                    <LaunchLinks urls={commandUrls(item)} />
                  </span>
                  <button
                    className="secondary-button launch-running-stop"
                    type="button"
                    disabled={busy}
                    onClick={() => void stop(item)}
                  >
                    Arrêter
                  </button>
                </>
              ) : (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void execute(item.id)}
                >
                  ▶ {item.name}
                  {item.kind === 'deploy' ? ' · Déployer' : ''}
                </button>
              )}
              {settings && (
                <>
                  <code>{item.command}</code>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                      setEditingId(item.id)
                      setEnv(item.env_json ?? '{}')
                      setUrl(item.url ?? '')
                      setName(item.name)
                      setCommand(item.command)
                      setCwd(item.cwd_relative)
                      setPort(item.port ? String(item.port) : '')
                      setKind(item.kind)
                    }}
                  >
                    Modifier
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() =>
                      void launchRequest(`${base}/${item.id}`, 'DELETE')
                        .then(load)
                        .catch((error) => setError(String(error)))
                    }
                  >
                    Supprimer
                  </button>
                </>
              )}
            </div>
          ))}
          <label>
            Port alternatif
            <input
              type="number"
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </label>
          {settings && (
            <>
              <label>
                Nom
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Commande
                <input
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </label>
              <label>
                Sous-répertoire
                <input
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                />
              </label>
              <label>
                Variables d’environnement (JSON)
                <textarea
                  value={env}
                  onChange={(event) => setEnv(event.target.value)}
                />
              </label>
              <label>
                URL
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
              <label>
                Usage
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                >
                  <option value="run">Lancer</option>
                  <option value="deploy">Déployer</option>
                </select>
              </label>
              <button
                className="secondary-button"
                type="button"
                disabled={busy || !command.trim()}
                onClick={() => void save()}
              >
                {editingId ? 'Enregistrer la commande' : 'Ajouter la commande'}
              </button>
              {suggestions.map((item, index) => (
                <button
                  className="secondary-button"
                  type="button"
                  key={index}
                  onClick={() => {
                    setName(item.name)
                    setCommand(item.command)
                  }}
                >
                  {item.command}
                  {item.frequency ? ` · ${item.frequency} conversations` : ''}
                </button>
              ))}
            </>
          )}
          {conflict && (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void execute(conflict.id, conflict.pid)}
            >
              Arrêter {conflict.process} (PID {conflict.pid}) et lancer
            </button>
          )}
          {output && <pre>{output}</pre>}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}

export function ManagedLaunches() {
  const [items, setItems] = useState<Command[]>([])
  const [error, setError] = useState('')
  async function refresh() {
    try {
      setItems(await launchRequest<Command[]>('/api/launches'))
      setError('')
    } catch (error) {
      setError(String(error))
    }
  }
  async function action(item: Command, action: string) {
    try {
      await launchRequest(
        `/api/projects/${item.project_id}/launch/${item.id}/${action}`,
        'POST',
        {},
      )
      await refresh()
    } catch (error) {
      setError(String(error))
    }
  }
  return (
    <section className="managed-launches" aria-label="Commandes de lancement">
      <button
        className="secondary-button"
        type="button"
        onClick={() => void refresh()}
      >
        Actualiser les commandes de lancement
      </button>
      {error && <p role="alert">{error}</p>}
      {items.map((item) => (
        <div key={item.id}>
          <strong>{item.name}</strong> · {item.running ? 'En cours' : 'Arrêtée'}
          <button
            className="secondary-button"
            type="button"
            disabled={!item.running}
            onClick={() => void action(item, 'stop')}
          >
            Arrêter
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void action(item, 'restart')}
          >
            Relancer
          </button>
          {item.running && <LaunchLinks urls={commandUrls(item)} />}
          <details>
            <summary>Logs</summary>
            <pre>{item.logs}</pre>
          </details>
        </div>
      ))}
    </section>
  )
}

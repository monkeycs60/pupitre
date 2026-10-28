import { useState } from 'react'
import { track } from './analytics'
import { launchRequest, type RunningApplication } from './api'
import { ExternalLink } from './externalLink'
import {
  launchUrlLabel,
  refreshProjectLaunches,
  useProjectLaunches,
  type LaunchCommand as Command,
  type LaunchUrl,
} from './projectLaunchStore'
import { useRunningApplications } from './runningApplicationsStore'
import { branchOfWorktree } from './conversationBranch'
import { Icon } from './Icon'
import { PortChip } from './PortChip'
import type { Conversation, Project } from './types'

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
          title={
            item.live ? `Ouvrir ${item.url}` : `${item.url} n’écoute pas encore`
          }
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

function normalizedOrigin(value: string | null | undefined): string {
  return (value ?? '').replace(/^(?:refs\/heads\/|origin\/)/, '').replace(/\//g, '-').toLowerCase()
}

function conversationsForGroup(conversations: Conversation[], ticketKey: string | null, origin: string): Conversation[] {
  const branch = normalizedOrigin(origin)
  return conversations
    .filter((conversation) => (ticketKey !== null && conversation.ticket_key === ticketKey)
      || normalizedOrigin(branchOfWorktree(conversation.worktree_path) ?? conversation.created_on_branch) === branch)
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
}

function ManagedServerRow({ item }: { item: Command }) {
  const [logsOpen, setLogsOpen] = useState(false)
  const [logs, setLogs] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const urls = commandUrls(item)

  async function restart() {
    track('servers.restart', {}, item.project_id)
    setRestarting(true)
    try {
      await launchRequest(`/api/projects/${item.project_id}/launch/${item.id}/restart`, 'POST', {})
      await refreshProjectLaunches(item.project_id)
    } catch {
      setLogs((current) => current ?? 'La relance a échoué : ouvre les logs pour voir la sortie.')
    } finally {
      setRestarting(false)
    }
  }

  function toggleLogs() {
    const next = !logsOpen
    setLogsOpen(next)
    if (!next) return
    track('servers.logs', {}, item.project_id)
    void launchRequest<Command>(`/api/projects/${item.project_id}/launch/${item.id}`)
      .then((status) => setLogs(status.logs ?? ''))
      .catch((error) => setLogs(String(error)))
  }

  return (
    <div className="servers-row is-managed">
      <div className="servers-row-who">
        <strong title={item.command}>{item.name}</strong>
        <span>lancé par Pupitre</span>
        <span className="servers-row-actions">
          <button type="button" onClick={() => void restart()} disabled={restarting} aria-label={`Relancer ${item.name}`} title="Relancer">
            <Icon name="refresh" size={13} />
          </button>
          <button type="button" onClick={toggleLogs} aria-expanded={logsOpen} aria-label={`Logs de ${item.name}`} title="Logs">
            <Icon name="logs" size={13} />
          </button>
          <button type="button" onClick={() => void stopLaunch(item).catch(() => {})} aria-label={`Arrêter ${item.name}`} title="Arrêter">
            <Icon name="stop" size={13} />
          </button>
        </span>
      </div>
      <div className="servers-row-ports">
        {urls.length === 0 ? <span className="port-chip is-pending">Démarrage…</span> : urls.map((url) => (
          <ExternalLink
            key={url.url}
            href={url.url}
            className={`port-chip${url.live ? '' : ' is-pending'}`}
            title={url.live ? `Ouvrir ${url.url}` : `${url.url} n’écoute pas encore`}
          >
            <span className="port-chip-dot" aria-hidden="true" />
            <span className="port-chip-port">{launchUrlLabel(url.url)}</span>
          </ExternalLink>
        ))}
      </div>
      {logsOpen ? <pre className="servers-logs">{logs ?? 'Chargement…'}</pre> : null}
    </div>
  )
}

export function ProjectLiveLaunches({ project, conversations = [], onConversationSelect }: {
  project: Project
  conversations?: Conversation[]
  onConversationSelect?: (conversation: Conversation) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const launches = useProjectLaunches(project.id)
  const running = launches.filter((item) => item.running)
  const applications = useRunningApplications(15_000).items
  const known = new Map<number, string>()
  for (const item of launches)
    for (const url of item.known_urls ?? [])
      if (!known.has(url.port) || url.front) known.set(url.port, url.url)
  const managed = new Set(
    running.flatMap((item) => commandUrls(item).map((url) => url.port)),
  )
  const external = applications
    .filter(
      (application, index, all) =>
        application.projectId === project.id &&
        !managed.has(application.port) &&
        all.findIndex((other) => other.port === application.port) === index,
    )
    .sort((a, b) => a.port - b.port)
  if (running.length === 0 && external.length === 0) return null
  const groups = externalGroups(external)
  const serverCount = external.length + running.reduce((total, item) => total + Math.max(1, commandUrls(item).length), 0)
  const branchCount = groups.length + running.length
  return (
    <div className={`servers-block${expanded ? ' is-expanded' : ''}`} aria-label="Serveurs du projet">
      <button
        type="button"
        className="servers-summary"
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded) track('servers.expand', {}, project.id)
          setExpanded(!expanded)
        }}
        title="Serveurs en écoute pour ce projet, lancés par Pupitre ou ailleurs"
      >
        <span className="servers-dot" aria-hidden="true" />
        <strong>{serverCount} serveur{serverCount > 1 ? 's' : ''}</strong>
        <span>sur {branchCount} branche{branchCount > 1 ? 's' : ''}</span>
        <span className="servers-toggle">
          {expanded ? 'Réduire' : 'Voir'}
          <Icon name={expanded ? 'chevron-up' : 'chevron-right'} size={13} />
        </span>
      </button>
      {expanded ? (
        <div className="servers-list">
          {running.map((item) => <ManagedServerRow item={item} key={item.id} />)}
          {groups.map(({ origin, ticket, items }) => {
            const related = conversationsForGroup(conversations, ticket?.key ?? null, origin)
            return (
              <div className="servers-row" key={origin}>
                <div className="servers-row-who" title={ticket ? `${ticket.key} · ${ticket.title}\nBranche ${origin}` : `Branche ${origin}`}>
                  <strong>{ticket?.key ?? origin}</strong>
                  {ticket ? <span>{ticket.title}</span> : null}
                  {related.length > 0 && onConversationSelect ? (
                    <button
                      type="button"
                      className="servers-row-conv"
                      onClick={() => onConversationSelect(related[0]!)}
                      title={`Ouvrir « ${related[0]!.title} »`}
                    >
                      {related.length} conv.
                    </button>
                  ) : null}
                </div>
                <div className="servers-row-ports">
                  {items.map((application) => (
                    <PortChip
                      key={application.id}
                      application={application}
                      projectName={project.name}
                      href={known.get(application.port) ?? application.url}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function externalGroups(applications: RunningApplication[]) {
  const groups = new Map<
    string,
    { origin: string; ticket: RunningApplication['ticket']; items: RunningApplication[] }
  >()
  for (const application of applications) {
    const origin = application.branch ?? application.workspace
    const group = groups.get(origin) ?? { origin, ticket: null, items: [] }
    group.ticket ??= application.ticket ?? null
    group.items.push(application)
    groups.set(origin, group)
  }
  return [...groups.values()]
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
            <p className="launch-empty">
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
          <label className="launch-port">
            Port alternatif
            <input
              placeholder="auto"
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

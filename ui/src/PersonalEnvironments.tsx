import { useState } from 'react'
import { launchRequest } from './api'

type Config = {
  name: string
  type: 'http' | 'ssh-systemd' | 'ssh-docker'
  url?: string
  versionUrl?: string
  host?: string
  service?: string
  directory?: string
}
interface Environment {
  id: string
  config: Config
  result: {
    healthy: boolean
    latencyMs: number
    status?: number
    behind: number | null
    commit?: string
    error?: string
  } | null
  incidents: Array<{
    id: string
    message: string
    count: number
    triage_json?: string | null
  }>
}
const empty: Config = { name: 'Production', type: 'http' }
export function PersonalEnvironments({
  projectId,
  onConversation,
}: {
  projectId: string
  onConversation: (id: string) => void
}) {
  const [items, setItems] = useState<Environment[]>([])
  const [hosts, setHosts] = useState<string[]>([])
  const [deploys, setDeploys] = useState<
    Array<{ id: string; name: string; kind: string }>
  >([])
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Config>(empty)
  const [editing, setEditing] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const base = `/api/projects/${projectId}/personal-environments`
  async function load() {
    try {
      const data = await launchRequest<{
        environments: Environment[]
        hosts: string[]
      }>(base)
      setItems(data.environments)
      setHosts(data.hosts)
      setDeploys(
        (
          await launchRequest<
            Array<{ id: string; name: string; kind: string }>
          >(`/api/projects/${projectId}/launch`)
        ).filter((command) => command.kind === 'deploy'),
      )
      setError('')
    } catch (error) {
      setError(String(error))
    }
  }
  async function save() {
    try {
      await launchRequest(
        `${base}${editing ? `/${editing}` : ''}`,
        editing ? 'PUT' : 'POST',
        draft,
      )
      setDraft(empty)
      setEditing(null)
      setFormOpen(false)
      await load()
    } catch (error) {
      setError(String(error))
    }
  }
  const field = (key: keyof Config, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }))
  return (
    <section className="personal-environments-view" aria-label="Environnements personnels">
      <button className="secondary-button" onClick={() => void load()}>
        Actualiser les environnements personnels
      </button>
      {error && <p role="alert">{error}</p>}
      {items.map((item) => (
        <div className="personal-environment-row" key={item.id}>
          <strong>{item.config.name}</strong>
          <p>
            {item.result
              ? `${item.result.healthy ? 'Disponible' : 'Indisponible'} · ${item.result.status ? `HTTP ${item.result.status} · ` : ''}${item.result.latencyMs ?? '?'} ms · retard : ${item.result.behind ?? '?'} commits`
              : 'Pas encore sondé'}
          </p>
          {item.result?.commit && (
            <p>
              Commit déployé : <code>{item.result.commit}</code>
            </p>
          )}
          {item.result?.error && <p>{item.result.error}</p>}
          <button
            className="secondary-button"
            onClick={() => {
              setDraft(item.config)
              setEditing(item.id)
              setFormOpen(true)
            }}
          >
            Modifier
          </button>
          <button
            className="secondary-button"
            onClick={() =>
              void launchRequest(`${base}/${item.id}`, 'POST', {})
                .then(load)
                .catch((error) => setError(String(error)))
            }
          >
            Sonder
          </button>
          <button
            className="secondary-button"
            onClick={() =>
              void launchRequest(`${base}/${item.id}`, 'DELETE')
                .then(load)
                .catch((error) => setError(String(error)))
            }
          >
            Supprimer l’environnement
          </button>
          {(item.result?.behind ?? 0) > 0 &&
            deploys.map((command) => (
              <button
                className="secondary-button"
                key={command.id}
                onClick={() =>
                  void launchRequest(
                    `/api/projects/${projectId}/launch/${command.id}`,
                    'POST',
                    {},
                  ).catch((error) => setError(String(error)))
                }
              >
                Déployer · {command.name}
              </button>
            ))}
          {item.incidents.map((incident) => (
            <div key={incident.id}>
              <p>
                {incident.message} · {incident.count} occurrences
              </p>
              {incident.triage_json && (
                <p>
                  {
                    (JSON.parse(incident.triage_json) as { summary: string })
                      .summary
                  }
                </p>
              )}
              <button
                className="secondary-button"
                onClick={() =>
                  void launchRequest<{ id: string }>(
                    `/api/personal-incidents/${incident.id}/triage`,
                    'POST',
                    {},
                  )
                    .then((c) => onConversation(c.id))
                    .catch((error) => setError(String(error)))
                }
              >
                Lancer un triage
              </button>
            </div>
          ))}
        </div>
      ))}
      <details
        open={formOpen}
        onToggle={(event) => setFormOpen(event.currentTarget.open)}
      >
        <summary>
          {editing ? 'Modifier l’environnement' : 'Ajouter un environnement'}
        </summary>
        <label>
          Nom
          <input
            value={draft.name}
            onChange={(event) => field('name', event.target.value)}
          />
        </label>
        <label>
          Type
          <select
            value={draft.type}
            onChange={(event) => field('type', event.target.value)}
          >
            <option value="http">HTTP</option>
            <option value="ssh-systemd">SSH · systemd</option>
            <option value="ssh-docker">SSH · Docker</option>
          </select>
        </label>
        {draft.type === 'http' ? (
          <>
            <label>
              URL de santé
              <input
                value={draft.url ?? ''}
                onChange={(event) => field('url', event.target.value)}
              />
            </label>
            <label>
              URL de version (facultative)
              <input
                value={draft.versionUrl ?? ''}
                onChange={(event) => field('versionUrl', event.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              Hôte SSH
              <select
                value={draft.host ?? ''}
                onChange={(event) => field('host', event.target.value)}
              >
                <option value="">Choisir…</option>
                {hosts.map((host) => (
                  <option key={host}>{host}</option>
                ))}
              </select>
            </label>
            <label>
              Service ou conteneur
              <input
                value={draft.service ?? ''}
                onChange={(event) => field('service', event.target.value)}
              />
            </label>
            <label>
              Répertoire Git
              <input
                value={draft.directory ?? ''}
                onChange={(event) => field('directory', event.target.value)}
              />
            </label>
          </>
        )}
        <button className="primary-button" onClick={() => void save()}>
          Enregistrer l’environnement
        </button>
      </details>
    </section>
  )
}

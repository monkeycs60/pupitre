import { useEffect, useState } from 'react'
import {
  deleteProjectIntegration,
  listProjectMcpServers,
  listProjectIntegrations,
  listPresets,
  measureProjectMcpServers,
  saveProjectIntegration,
  setProjectDefaultCorrectionPreset,
  setProjectDefaultReviewPreset,
  setProjectFilesystemScope,
  updateProjectMcpServers,
  verifyProjectMcpCost,
} from './api'
import type { McpContextProbe, ProjectMcpConfig } from './api'
import { formatCompact } from './formatCompact'
import { ProviderMark } from './ProviderMark'
import type { DashboardIntegration } from './types'
import type { FilesystemScope, Preset, Project } from './types'

interface ProjectSettingsDialogProps {
  project: Project
  onClose: () => void
  onUpdated: (project: Project) => void
}

const DEFAULT_BRANCH_PATTERN = '^(issue|maintenance|feature)/(TECH-\\d+)'

interface ClickUpIntegrationForm {
  enabled: boolean
  existed: boolean
  teamId: string
  listIds: string
}

interface GitLabProjectForm {
  path: string
  label: string
  environments: string
}

interface GitLabIntegrationForm {
  enabled: boolean
  existed: boolean
  host: string
  projects: GitLabProjectForm[]
}

interface SentryIntegrationForm {
  enabled: boolean
  existed: boolean
  baseUrl: string
  org: string
  projects: string
  token: string
}

interface IntegrationsForm {
  branchPattern: string
  clickup: ClickUpIntegrationForm
  gitlab: GitLabIntegrationForm
  sentry: SentryIntegrationForm
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Impossible d’enregistrer le projet.'
}

function projectPresetId(value: string | null | undefined, legacy: string | null): string {
  return value === undefined ? legacy ?? '' : value ?? ''
}

function presetLabel(preset: Preset, kind: 'review' | 'correction'): string {
  const model = kind === 'review' ? preset.review_model : preset.model
  const effort = kind === 'review' ? preset.review_effort : (preset.effort ?? '—')
  return `${preset.name} · ${model} · ${effort}`
}

function emptyGitLabProject(): GitLabProjectForm {
  return { path: '', label: '', environments: '' }
}

function defaultIntegrations(): IntegrationsForm {
  return {
    branchPattern: DEFAULT_BRANCH_PATTERN,
    clickup: {
      enabled: false,
      existed: false,
      teamId: '',
      listIds: '',
    },
    gitlab: {
      enabled: false,
      existed: false,
      host: 'https://git.kaizen-hosting.com',
      projects: [],
    },
    sentry: {
      enabled: false,
      existed: false,
      baseUrl: 'https://sentry.io',
      org: '',
      projects: 'hapigator, reactor, reactivator',
      token: '',
    },
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function integrationForm(items: DashboardIntegration[]): IntegrationsForm {
  const next = defaultIntegrations()
  const savedPattern = items.find((item) => item.branch_pattern)?.branch_pattern
  if (savedPattern) next.branchPattern = savedPattern

  for (const item of items) {
    if (item.type === 'clickup') {
      const config = readObject(item.config)
      next.clickup = {
        enabled: true,
        existed: true,
        teamId: readString(config?.teamId),
        listIds: readStringArray(config?.listIds).join(', '),
      }
    }
    if (item.type === 'gitlab') {
      const config = readObject(item.config)
      const projects = Array.isArray(config?.projects)
        ? config.projects
            .map((value) => readObject(value))
            .filter((value): value is Record<string, unknown> => value !== null)
            .map((value) => ({
              path: readString(value.path),
              label: readString(value.label),
              environments: readStringArray(value.environments).join(', '),
            }))
        : []
      next.gitlab = {
        enabled: true,
        existed: true,
        host: readString(config?.host) || 'https://git.kaizen-hosting.com',
        projects,
      }
    }
    if (item.type === 'sentry') {
      const config = readObject(item.config)
      next.sentry = {
        enabled: true,
        existed: true,
        baseUrl: readString(config?.baseUrl) || 'https://sentry.io',
        org: readString(config?.org),
        projects: readStringArray(config?.projects).join(', '),
        token: '',
      }
    }
  }

  return next
}

export function ProjectSettingsDialog({ project, onClose, onUpdated }: ProjectSettingsDialogProps) {
  const [scope, setScope] = useState<FilesystemScope>(project.filesystem_scope)
  const [presets, setPresets] = useState<Preset[]>([])
  const [reviewPresetId, setReviewPresetId] = useState(() => projectPresetId(project.default_review_preset_id, project.default_preset_id))
  const [correctionPresetId, setCorrectionPresetId] = useState(() => projectPresetId(project.default_correction_preset_id, project.default_preset_id))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mcp, setMcp] = useState<ProjectMcpConfig | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [probe, setProbe] = useState<McpContextProbe | null>(null)
  const [integrations, setIntegrations] = useState<IntegrationsForm>(() => defaultIntegrations())

  useEffect(() => {
    const controller = new AbortController()
    void listPresets(controller.signal).then(setPresets).catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void listProjectMcpServers(project.id, controller.signal)
      .then(setMcp)
      // La section MCP disparaît si l'inventaire échoue ; le reste du dialogue
      // doit rester utilisable.
      .catch(() => {})
    return () => controller.abort()
  }, [project.id])

  useEffect(() => {
    setIntegrations(defaultIntegrations())
    const controller = new AbortController()
    void listProjectIntegrations(project.id, controller.signal)
      .then((items) => setIntegrations(integrationForm(items)))
      .catch(() => {})
    return () => controller.abort()
  }, [project.id])

  /** `null` = aucun filtre : tous les serveurs configurés sont chargés. */
  const enabled = mcp?.enabled ?? null
  const isEnabled = (name: string) => enabled === null || enabled.includes(name)

  /** Coût de la sélection courante, limité aux serveurs déjà mesurés. */
  function selectionTokens(): { total: number; measured: number; unknown: number } {
    if (mcp === null) return { total: 0, measured: 0, unknown: 0 }
    let total = 0
    let measured = 0
    let unknown = 0
    for (const server of mcp.servers) {
      if (!isEnabled(server.name)) continue
      const tokens = mcp.weights[server.name]?.tokens
      if (typeof tokens === 'number') {
        total += tokens
        measured += 1
      } else {
        unknown += 1
      }
    }
    return { total, measured, unknown }
  }

  async function handleMeasure() {
    if (mcp === null) return
    setMeasuring(true)
    setError(null)
    try {
      const weights = await measureProjectMcpServers(project.id)
      setMcp({
        ...mcp,
        weights: Object.fromEntries(weights.map((weight) => [weight.name, weight])),
      })
    } catch (measureError: unknown) {
      setError(errorMessage(measureError))
    } finally {
      setMeasuring(false)
    }
  }

  async function handleVerify() {
    setVerifying(true)
    setError(null)
    try {
      setProbe(await verifyProjectMcpCost(project.id))
    } catch (verifyError: unknown) {
      setError(errorMessage(verifyError))
    } finally {
      setVerifying(false)
    }
  }

  function toggleServer(name: string) {
    if (mcp === null) return
    const current = enabled ?? mcp.servers.map((server) => server.name)
    setMcp({
      ...mcp,
      enabled: current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name],
    })
  }

  function updateGitLabProject(index: number, patch: Partial<GitLabProjectForm>) {
    setIntegrations((current) => ({
      ...current,
      gitlab: {
        ...current.gitlab,
        projects: current.gitlab.projects.map((projectItem, projectIndex) => (
          projectIndex === index ? { ...projectItem, ...patch } : projectItem
        )),
      },
    }))
  }

  async function handleSave() {
    if (scope === 'full-system' && project.filesystem_scope !== 'full-system') {
      const confirmed = window.confirm(
        `Autoriser Claude et Codex à modifier tout le système pour « ${project.name} » ?`,
      )
      if (!confirmed) return
    }
    setSaving(true)
    setError(null)
    try {
      let updated = await setProjectFilesystemScope(project.id, scope)
      updated = await setProjectDefaultReviewPreset(project.id, reviewPresetId || null)
      updated = await setProjectDefaultCorrectionPreset(project.id, correctionPresetId || null)
      for (const type of ['clickup', 'gitlab', 'sentry'] as const) {
        const form = integrations[type]
        if (form.enabled) {
          const config = type === 'clickup'
              ? {
                  teamId: integrations.clickup.teamId.trim(),
                  listIds: integrations.clickup.listIds.split(',').map((item) => item.trim()).filter(Boolean),
                }
              : type === 'gitlab' ? {
                  host: integrations.gitlab.host.trim(),
                  projects: integrations.gitlab.projects
                    .map((item) => ({
                      path: item.path.trim(),
                      label: item.label.trim() || item.path.trim(),
                      environments: item.environments.split(',').map((value) => value.trim()).filter(Boolean),
                    }))
                    .filter((item) => item.path.length > 0),
                } : {
                  baseUrl: integrations.sentry.baseUrl.trim() || 'https://sentry.io',
                  org: integrations.sentry.org.trim(),
                  projects: integrations.sentry.projects.split(',').map((item) => item.trim()).filter(Boolean),
                  environment: 'production',
                  domains: [
                    { id: 'match-ai', label: 'Match AI', keywords: ['matching', 'match ai', 'affiliate profile', 'vectorize', 'vectorization', 'signup', 'onboarding'], exclude: ['brand search'] },
                    { id: 'wishlists', label: 'Wishlists', keywords: ['wishlist', 'wishlists'] },
                    { id: 'instagram', label: 'Instagram', keywords: ['instagram', 'insta'] },
                  ],
                }
          await saveProjectIntegration(project.id, type, {
            config,
            branchPattern: integrations.branchPattern.trim() || null,
            ...(type === 'sentry' && integrations.sentry.token.trim()
              ? { token: integrations.sentry.token.trim() }
              : {}),
          })
        } else if (form.existed) {
          await deleteProjectIntegration(project.id, type)
        }
      }
      if (mcp !== null) await updateProjectMcpServers(project.id, mcp.enabled)
      onUpdated(updated)
      onClose()
    } catch (saveError: unknown) {
      setError(errorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal project-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <p className="eyebrow">Projet</p>
            <h2 id="project-settings-title">Paramètres · {project.name}</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>
        <div className="project-settings-body">
          <section className="project-settings-defaults" aria-labelledby="project-gardien-defaults-title">
            <div className="project-settings-section-heading">
              <strong id="project-gardien-defaults-title">Defaults du Gardien</strong>
              <span>Appliqués au prochain lancement, y compris dans les conversations en cours.</span>
            </div>
            <label htmlFor="project-review-preset">
              <strong>Preset de review</strong>
              <select
                id="project-review-preset"
                value={reviewPresetId}
                disabled={saving}
                onChange={(event) => setReviewPresetId(event.target.value)}
              >
                <option value="">Automatique · modèle de la conversation</option>
                {presets.map((preset) => <option key={preset.id} value={preset.id}>{presetLabel(preset, 'review')}</option>)}
              </select>
            </label>
            <label htmlFor="project-correction-preset">
              <strong>Preset de correction</strong>
              <select
                id="project-correction-preset"
                value={correctionPresetId}
                disabled={saving}
                onChange={(event) => setCorrectionPresetId(event.target.value)}
              >
                <option value="">Automatique · modèle de la conversation</option>
                {presets.map((preset) => <option key={preset.id} value={preset.id}>{presetLabel(preset, 'correction')}</option>)}
              </select>
            </label>
          </section>
          <label htmlFor="project-filesystem-scope">
            <strong>Accès filesystem</strong>
            <select
              id="project-filesystem-scope"
              value={scope}
              disabled={saving}
              onChange={(event) => setScope(event.target.value as FilesystemScope)}
            >
              <option value="project-and-ai-roots">Projet + racines IA</option>
              <option value="full-system">Tout le système</option>
            </select>
          </label>
          <p>
            Ce réglage s’applique à toutes les conversations de ce projet. Les racines
            <code> ~/.claude</code> et <code> ~/.codex</code> restent toujours accessibles.
          </p>
          {mcp !== null && mcp.servers.length > 0 ? (
            <div className="project-mcp">
              <div className="project-mcp-heading">
                <strong>Serveurs MCP chargés</strong>
                <span className="project-mcp-actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={saving || measuring}
                    onClick={() => void handleMeasure()}
                  >
                    {measuring ? 'Mesure en cours…' : 'Estimer le coût'}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={saving || verifying}
                    title="Lance deux tours CLI réels et compare le contexte obtenu"
                    onClick={() => void handleVerify()}
                  >
                    {verifying ? 'Vérification…' : 'Vérifier en réel'}
                  </button>
                  {mcp.used.length > 0 ? (
                    <button
                      type="button"
                      className="text-button"
                      disabled={saving}
                      title="Ne garder que les serveurs déjà appelés dans ce projet"
                      onClick={() => setMcp({ ...mcp, enabled: mcp.used })}
                    >
                      Garder les {mcp.used.length} utilisés
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="text-button"
                    disabled={saving}
                    onClick={() => setMcp({ ...mcp, enabled: enabled === null ? [] : null })}
                  >
                    {enabled === null ? 'Tout décocher' : 'Tout charger'}
                  </button>
                </span>
              </div>
              <p>
                Chaque serveur coché occupe du contexte dans <em>toutes</em> les
                conversations de ce projet. Décocher ce qui n’y sert pas libère
                autant de fenêtre, sans toucher à votre configuration globale.
              </p>
              <ul className="project-mcp-list">
                {mcp.servers.map((server) => (
                  <li key={`${server.provider}:${server.name}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={isEnabled(server.name)}
                        disabled={saving}
                        onChange={() => toggleServer(server.name)}
                      />
                      <ProviderMark provider={server.provider} className="project-mcp-badge" />
                      <span className="project-mcp-name">
                        {server.name}
                        {mcp.used.includes(server.name) ? (
                          <span className="project-mcp-used" title="Déjà appelé dans ce projet"> ✓</span>
                        ) : null}
                      </span>
                      <span
                        className="project-mcp-cost"
                        title={mcp.weights[server.name]?.error ?? undefined}
                      >
                        {typeof mcp.weights[server.name]?.tokens === 'number' ? (
                          <>
                            <strong>{formatCompact(mcp.weights[server.name]!.tokens!)}</strong>
                            {' '}· {mcp.weights[server.name]!.toolCount} outils
                          </>
                        ) : mcp.weights[server.name]?.error ? (
                          <span className="project-mcp-failed">non mesurable</span>
                        ) : '—'}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="project-mcp-total">
                {selectionTokens().measured === 0 ? (
                  <>Coût inconnu : lancez « Mesurer le coût » pour peser chaque serveur.</>
                ) : (
                  <>
                    Cette sélection coûte{' '}
                    <strong>{formatCompact(selectionTokens().total)} tokens</strong> par
                    conversation
                    {selectionTokens().unknown > 0
                      ? `, plus ${selectionTokens().unknown} serveur(s) non mesuré(s)`
                      : ''}
                    .
                  </>
                )}
              </p>
              {probe ? (
                <p className="project-mcp-total">
                  {probe.error ? (
                    <span className="project-mcp-failed">Vérification impossible : {probe.error}</span>
                  ) : (
                    <>
                      Mesure réelle : la sélection enregistrée coûte{' '}
                      <strong>{formatCompact(probe.cost)} tokens</strong>{' '}
                      ({formatCompact(probe.without)} sans aucun serveur,{' '}
                      {formatCompact(probe.withServers)} avec).
                    </>
                  )}
                </p>
              ) : null}
            </div>
          ) : null}
          <section className="project-integrations" aria-labelledby="project-integrations-title">
            <div className="project-settings-section-heading">
              <strong id="project-integrations-title">Intégrations</strong>
              <span>Relie ClickUp et GitLab à ce projet pour alimenter le tableau de bord.</span>
            </div>

            <article className="project-integration-card">
              <label className="project-settings-toggle">
                <input
                  type="checkbox"
                  checked={integrations.clickup.enabled}
                  disabled={saving}
                  onChange={(event) => setIntegrations((current) => ({
                    ...current,
                    clickup: { ...current.clickup, enabled: event.target.checked },
                  }))}
                />
                <span>Activer ClickUp</span>
              </label>
              <label htmlFor="project-clickup-team-id">
                <strong>Team ID</strong>
                <input
                  id="project-clickup-team-id"
                  value={integrations.clickup.teamId}
                  disabled={saving || !integrations.clickup.enabled}
                  onChange={(event) => setIntegrations((current) => ({
                    ...current,
                    clickup: { ...current.clickup, teamId: event.target.value },
                  }))}
                />
              </label>
              <label htmlFor="project-clickup-list-ids">
                <strong>Listes ClickUp</strong>
                <input
                  id="project-clickup-list-ids"
                  value={integrations.clickup.listIds}
                  disabled={saving || !integrations.clickup.enabled}
                  onChange={(event) => setIntegrations((current) => ({
                    ...current,
                    clickup: { ...current.clickup, listIds: event.target.value },
                  }))}
                />
              </label>
            </article>

            <article className="project-integration-card">
              <label className="project-settings-toggle">
                <input
                  type="checkbox"
                  checked={integrations.sentry.enabled}
                  disabled={saving}
                  onChange={(event) => setIntegrations((current) => ({
                    ...current,
                    sentry: { ...current.sentry, enabled: event.target.checked },
                  }))}
                />
                <span>Activer Sentry</span>
              </label>
              <label htmlFor="project-sentry-token">
                <strong>Auth token du projet</strong>
                <input
                  id="project-sentry-token"
                  type="password"
                  autoComplete="off"
                  value={integrations.sentry.token}
                  placeholder={integrations.sentry.existed ? 'Laisser vide pour conserver le token' : 'sntrys_…'}
                  disabled={saving || !integrations.sentry.enabled}
                  onChange={(event) => setIntegrations((current) => ({
                    ...current,
                    sentry: { ...current.sentry, token: event.target.value },
                  }))}
                />
              </label>
              <label htmlFor="project-sentry-org">
                <strong>Organisation Sentry</strong>
                <input
                  id="project-sentry-org"
                  value={integrations.sentry.org}
                  disabled={saving || !integrations.sentry.enabled}
                  onChange={(event) => setIntegrations((current) => ({
                    ...current,
                    sentry: { ...current.sentry, org: event.target.value },
                  }))}
                />
              </label>
              <label htmlFor="project-sentry-projects">
                <strong>Projets Sentry</strong>
                <input
                  id="project-sentry-projects"
                  value={integrations.sentry.projects}
                  disabled={saving || !integrations.sentry.enabled}
                  onChange={(event) => setIntegrations((current) => ({
                    ...current,
                    sentry: { ...current.sentry, projects: event.target.value },
                  }))}
                />
              </label>
              <label htmlFor="project-sentry-url">
                <strong>URL Sentry</strong>
                <input
                  id="project-sentry-url"
                  value={integrations.sentry.baseUrl}
                  disabled={saving || !integrations.sentry.enabled}
                  onChange={(event) => setIntegrations((current) => ({
                    ...current,
                    sentry: { ...current.sentry, baseUrl: event.target.value },
                  }))}
                />
              </label>
              <p className="project-integration-note">
                Production uniquement · Match AI, signup/onboarding, vectorisation, wishlists et Instagram.
                Brand Search seul est exclu. Le token reste stocké localement et n’est jamais renvoyé à l’interface.
              </p>
            </article>

            <article className="project-integration-card">
              <label className="project-settings-toggle">
                <input
                  type="checkbox"
                  checked={integrations.gitlab.enabled}
                  disabled={saving}
                  onChange={(event) => setIntegrations((current) => ({
                    ...current,
                    gitlab: { ...current.gitlab, enabled: event.target.checked },
                  }))}
                />
                <span>Activer GitLab</span>
              </label>
              <label htmlFor="project-gitlab-host">
                <strong>Hôte GitLab</strong>
                <input
                  id="project-gitlab-host"
                  value={integrations.gitlab.host}
                  disabled={saving || !integrations.gitlab.enabled}
                  onChange={(event) => setIntegrations((current) => ({
                    ...current,
                    gitlab: { ...current.gitlab, host: event.target.value },
                  }))}
                />
              </label>
              <div className="project-integration-projects">
                <div className="project-integration-projects-heading">
                  <strong>Projets GitLab</strong>
                  <button
                    type="button"
                    className="text-button"
                    disabled={saving || !integrations.gitlab.enabled}
                    onClick={() => setIntegrations((current) => ({
                      ...current,
                      gitlab: {
                        ...current.gitlab,
                        projects: [...current.gitlab.projects, emptyGitLabProject()],
                      },
                    }))}
                  >
                    + Ajouter un projet
                  </button>
                </div>
                {integrations.gitlab.projects.length > 0 ? (
                  <div className="project-integration-project-list">
                    {integrations.gitlab.projects.map((item, index) => (
                      <div key={`gitlab-project-${index}`} className="project-integration-project-row">
                        <label htmlFor={`project-gitlab-path-${index}`}>
                          <strong>Chemin</strong>
                          <input
                            id={`project-gitlab-path-${index}`}
                            value={item.path}
                            disabled={saving || !integrations.gitlab.enabled}
                            onChange={(event) => updateGitLabProject(index, { path: event.target.value })}
                          />
                        </label>
                        <label htmlFor={`project-gitlab-label-${index}`}>
                          <strong>Libellé</strong>
                          <input
                            id={`project-gitlab-label-${index}`}
                            value={item.label}
                            disabled={saving || !integrations.gitlab.enabled}
                            onChange={(event) => updateGitLabProject(index, { label: event.target.value })}
                          />
                        </label>
                        <label htmlFor={`project-gitlab-environments-${index}`}>
                          <strong>Environnements</strong>
                          <input
                            id={`project-gitlab-environments-${index}`}
                            value={item.environments}
                            disabled={saving || !integrations.gitlab.enabled}
                            onChange={(event) => updateGitLabProject(index, { environments: event.target.value })}
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="project-integration-note">Ajoutez un ou plusieurs projets suivis dans ce dépôt.</p>
                )}
              </div>
              <p className="project-integration-note">
                Token : celui de <code>glab</code> est utilisé automatiquement ; sinon,
                renseigne-le dans Paramètres › Tokens.
              </p>
            </article>

            <label htmlFor="project-branch-pattern">
              <strong>Motif de branche</strong>
              <input
                id="project-branch-pattern"
                value={integrations.branchPattern}
                disabled={saving}
                onChange={(event) => setIntegrations((current) => ({
                  ...current,
                  branchPattern: event.target.value,
                }))}
              />
            </label>
            <p className="project-integration-note">
              La clé du ticket est le dernier groupe capturant.
            </p>
          </section>
          {error ? <p className="modal-error" role="alert">{error}</p> : null}
        </div>
        <footer className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>Annuler</button>
          <button type="button" className="primary-button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </footer>
      </section>
    </div>
  )
}

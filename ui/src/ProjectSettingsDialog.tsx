import { useEffect, useState } from 'react'
import {
  listProjectMcpServers,
  listPresets,
  measureProjectMcpServers,
  setProjectDefaultCorrectionPreset,
  setProjectDefaultReviewPreset,
  setProjectFilesystemScope,
  updateProjectMcpServers,
  verifyProjectMcpCost,
} from './api'
import type { McpContextProbe, ProjectMcpConfig } from './api'
import { formatCompact } from './formatCompact'
import { ProviderMark } from './ProviderMark'
import type { FilesystemScope, Preset, Project } from './types'

interface ProjectSettingsDialogProps {
  project: Project
  onClose: () => void
  onUpdated: (project: Project) => void
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
              <span>Chaque conversation peut ensuite les remplacer.</span>
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

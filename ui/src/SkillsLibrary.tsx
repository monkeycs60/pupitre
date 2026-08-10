import { useEffect, useState } from 'react'
import Markdown from './Markdown'
import { HelpLink } from './HelpLink'
import {
  getSkill,
  listSkills,
  refreshSkills,
  setSkillFavorite,
} from './api'
import type {
  Project,
  Provider,
  SkillDetail,
  SkillProvenance,
  SkillSummary,
} from './types'
import { SkillComposerDialog } from './SkillComposerDialog'

interface SkillsLibraryProps {
  project: Project | null
}

const PROVENANCE_LABELS: Record<SkillProvenance, string> = {
  'claude-global': 'Claude · global',
  'claude-plugin': 'Claude · plugin',
  'claude-project': 'Claude · projet',
  'codex-prompt': 'Codex · prompt',
  'agents-global': 'Codex · AGENTS global',
  'agents-project': 'Codex · AGENTS projet',
}

const SCOPE_BADGES: Record<SkillProvenance, { label: string; kind: string }> = {
  'claude-project': { label: 'PROJET', kind: 'projet' },
  'agents-project': { label: 'PROJET', kind: 'projet' },
  'claude-global': { label: 'GLOBAL', kind: 'global' },
  'claude-plugin': { label: 'PLUGIN', kind: 'plugin' },
  'codex-prompt': { label: 'CODEX', kind: 'codex' },
  'agents-global': { label: 'CODEX', kind: 'codex' },
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Impossible de charger les skills.'
}

function formatDate(iso: string): string {
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) return '—'
  return value.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function SkillsLibrary({ project }: SkillsLibraryProps) {
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState<Provider | 'all'>('all')
  const [projectOnly, setProjectOnly] = useState(false)
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ id: string; value: SkillDetail } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [savingFavorite, setSavingFavorite] = useState(false)
  const [showComposer, setShowComposer] = useState(false)

  const scopedProjectId = projectOnly ? project?.id : undefined
  const activeSkill = skills.find((skill) => skill.id === selectedId) ?? null
  const activeSkillId = activeSkill?.id ?? null

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void listSkills({
      query,
      provider: provider === 'all' ? undefined : provider,
      projectId: scopedProjectId,
      favoriteProjectId: project?.id,
      signal: controller.signal,
    })
      .then(setSkills)
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [query, provider, scopedProjectId, project?.id, refreshVersion])

  useEffect(() => {
    if (!activeSkillId) return
    const controller = new AbortController()
    void getSkill(activeSkillId, project?.id, controller.signal)
      .then((value) => setDetail({ id: activeSkillId, value }))
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(loadError))
      })
    return () => controller.abort()
  }, [activeSkillId, project?.id])

  async function handleRefresh() {
    setRefreshing(true)
    setError(null)
    try {
      await refreshSkills()
      setRefreshVersion((current) => current + 1)
    } catch (refreshError: unknown) {
      setError(errorMessage(refreshError))
    } finally {
      setRefreshing(false)
    }
  }

  async function handleFavorite(skill: SkillSummary) {
    if (!project) return
    setSavingFavorite(true)
    setError(null)
    try {
      const favorite = !skill.favorite
      await setSkillFavorite(project.id, skill.id, favorite)
      setSkills((current) => current.map((item) => (
        item.id === skill.id ? { ...item, favorite } : item
      )))
      setDetail((current) => current?.id === skill.id
        ? { ...current, value: { ...current.value, favorite } }
        : current)
    } catch (favoriteError: unknown) {
      setError(errorMessage(favoriteError))
    } finally {
      setSavingFavorite(false)
    }
  }

  const selectedDetail = activeSkill && detail?.id === activeSkill.id ? detail.value : null

  return (
    <section className="skills-library" aria-labelledby="skills-library-title">
      {error ? <p className="library-error" role="alert">{error}</p> : null}

      <div className="library-body">
        <div className="skill-list-pane">
          <div className="library-sidebar-header">
            <h1 id="skills-library-title">Skills</h1>
            <p>
              {loading ? 'index…' : `${skills.length} skill${skills.length === 1 ? '' : 's'} indexé${skills.length === 1 ? '' : 's'}`}
              {' '}<HelpLink slug="skills" />
            </p>

            <label className="library-search">
              <span className="sr-only">Rechercher un skill</span>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <circle cx="7" cy="7" r="4.2" />
                  <path d="m10.2 10.2 3 3" />
                </g>
              </svg>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Nom, description, déclencheur…"
              />
            </label>

            <div className="library-pills" role="group" aria-label="Filtres de la bibliothèque">
              <button
                type="button"
                className={`library-pill ${provider === 'all' ? 'is-active' : ''}`}
                onClick={() => setProvider('all')}
              >
                Tous
              </button>
              <button
                type="button"
                className={`library-pill ${provider === 'claude' ? 'is-active' : ''}`}
                onClick={() => setProvider('claude')}
              >
                Claude
              </button>
              <button
                type="button"
                className={`library-pill ${provider === 'codex' ? 'is-active' : ''}`}
                onClick={() => setProvider('codex')}
              >
                Codex
              </button>
              <button
                type="button"
                className={`library-pill ${projectOnly ? 'is-active' : ''}`}
                onClick={() => setProjectOnly((current) => !current)}
                disabled={!project}
                title={project ? `Disponibles pour ${project.name}` : 'Sélectionnez un projet'}
              >
                Projet
              </button>
            </div>

            <div className="library-header-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleRefresh()}
                disabled={refreshing}
                title="Relire immédiatement les sources locales ; le watcher garde ensuite l’index à jour."
              >
                {refreshing ? 'Actualisation…' : 'Actualiser'}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => setShowComposer(true)}
                disabled={!project}
                title={project
                  ? 'Faire rédiger et installer un nouveau SKILL.md avec Codex Sol.'
                  : 'Sélectionnez un projet pour donner son contexte au composer.'}
              >
                Nouveau skill
              </button>
            </div>
          </div>

          <div className="skill-list" aria-label="Skills indexés">
            {!loading && skills.length === 0 ? (
              <div className="library-empty">
                <strong>Aucun skill trouvé.</strong>
                <p>Ajoutez un SKILL.md, un prompt Codex ou un AGENTS.md ; Pupitre l’indexera automatiquement.</p>
              </div>
            ) : skills.map((skill) => {
              const scope = SCOPE_BADGES[skill.provenance]
              const selected = activeSkill?.id === skill.id
              return (
                <div key={skill.id} className={`skill-row ${selected ? 'is-selected' : ''}`}>
                  <button
                    type="button"
                    className={`skill-favorite ${skill.favorite ? 'is-favorite' : ''}`}
                    onClick={() => void handleFavorite(skill)}
                    disabled={!project || savingFavorite}
                    aria-pressed={skill.favorite}
                    aria-label={skill.favorite ? `Retirer ${skill.name} des favoris` : `Ajouter ${skill.name} aux favoris`}
                    title={project
                      ? `Garder ce skill en favori pour ${project.name}`
                      : 'Sélectionnez un projet pour gérer ses favoris'}
                  >
                    <span aria-hidden="true">{skill.favorite ? '★' : '☆'}</span>
                  </button>
                  <button
                    type="button"
                    className="skill-row-main"
                    onClick={() => setSelectedId(skill.id)}
                  >
                    <span className="skill-row-heading">
                      <span className="skill-row-name">${skill.invocation}</span>
                      <span className={`scope-badge is-${scope.kind}`}>{scope.label}</span>
                    </span>
                    <span className="skill-row-description">{skill.description || 'Sans description.'}</span>
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        <article className="skill-detail" aria-live="polite">
          {activeSkill === null ? (
            <div className="library-empty">
              <strong>Sélectionnez un skill.</strong>
              <p>Son contenu source apparaîtra ici sans exécuter de script ni modifier le fichier.</p>
            </div>
          ) : selectedDetail === null ? (
            <p className="skill-preview-loading">Chargement de {activeSkill.name}…</p>
          ) : (
            <>
              <header className="skill-detail-header">
                <span className="skill-detail-name">${selectedDetail.invocation}</span>
                <span className={`scope-badge is-${SCOPE_BADGES[selectedDetail.provenance].kind}`}>
                  {SCOPE_BADGES[selectedDetail.provenance].label}
                </span>
                <button
                  type="button"
                  className={`skill-detail-favorite ${selectedDetail.favorite ? 'is-favorite' : ''}`}
                  onClick={() => void handleFavorite(selectedDetail)}
                  disabled={!project || savingFavorite}
                  aria-pressed={selectedDetail.favorite}
                  title={project ? `Favori pour ${project.name}` : 'Sélectionnez un projet pour gérer ses favoris'}
                >
                  <span aria-hidden="true">{selectedDetail.favorite ? '★' : '☆'}</span>
                  {selectedDetail.favorite ? ' Favori' : ' Ajouter aux favoris'}
                </button>
              </header>

              <p className="skill-detail-description">{selectedDetail.description || 'Sans description.'}</p>

              <div className="skill-stat-grid">
                <div className="skill-stat">
                  <div className="skill-stat-label">Provenance</div>
                  <div className="skill-stat-value">{PROVENANCE_LABELS[selectedDetail.provenance]}</div>
                </div>
                <div className="skill-stat">
                  <div className="skill-stat-label">Modifié</div>
                  <div className="skill-stat-value">{formatDate(selectedDetail.modified_at)}</div>
                </div>
                <div className="skill-stat">
                  <div className="skill-stat-label">Indexé</div>
                  <div className="skill-stat-value">{formatDate(selectedDetail.indexed_at)}</div>
                </div>
              </div>

              {selectedDetail.triggers.length > 0 ? (
                <div className="skill-detail-section">
                  <div className="skill-section-label">Déclencheurs indexés</div>
                  <div className="skill-triggers" aria-label="Déclencheurs indexés">
                    {selectedDetail.triggers.map((trigger) => <span key={trigger}>{trigger}</span>)}
                  </div>
                </div>
              ) : null}

              <div className="skill-detail-section">
                <div className="skill-section-label">Source</div>
                <code className="skill-path" title={selectedDetail.path}>{selectedDetail.path}</code>
                <div className="skill-markdown">
                  <Markdown>{selectedDetail.content_md}</Markdown>
                </div>
              </div>
            </>
          )}
        </article>
      </div>
      {showComposer && project ? (
        <SkillComposerDialog
          project={project}
          onClose={() => setShowComposer(false)}
          onCreated={(skill) => {
            setShowComposer(false)
            setSelectedId(skill.id)
            setRefreshVersion((current) => current + 1)
          }}
        />
      ) : null}
    </section>
  )
}

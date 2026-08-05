import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Impossible de charger les skills.'
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
  const activeSkill = skills.find((skill) => skill.id === selectedId) ?? skills[0] ?? null
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
      <header className="library-header">
        <div>
          <h1 id="skills-library-title">Bibliothèque</h1>
          <p>Skills Claude, prompts Codex et consignes AGENTS indexés localement.</p>
          <HelpLink slug="skills" />
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
      </header>

      <div className="library-filters" aria-label="Filtres de la bibliothèque">
        <label className="library-search">
          <span className="sr-only">Rechercher un skill</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Rechercher nom, description ou déclencheur"
          />
        </label>
        <label>
          <span>Provider</span>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as Provider | 'all')}
          >
            <option value="all">Tous</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label>
          <span>Portée</span>
          <select
            value={projectOnly ? 'project' : 'all'}
            onChange={(event) => setProjectOnly(event.target.value === 'project')}
            disabled={!project}
          >
            <option value="all">Toutes les sources</option>
            {project ? <option value="project">Disponibles pour {project.name}</option> : null}
          </select>
        </label>
        <span className="library-count" aria-live="polite">
          {loading ? 'index…' : `${skills.length} résultat${skills.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {error ? <p className="library-error" role="alert">{error}</p> : null}

      <div className="library-body">
        <div className="skill-list" aria-label="Skills indexés">
          {!loading && skills.length === 0 ? (
            <div className="library-empty">
              <strong>Aucun skill trouvé.</strong>
              <p>Ajoutez un SKILL.md, un prompt Codex ou un AGENTS.md ; Pupitre l’indexera automatiquement.</p>
            </div>
          ) : skills.map((skill) => (
            <div
              key={skill.id}
              className={`skill-row ${activeSkill?.id === skill.id ? 'is-selected' : ''}`}
            >
              <button
                type="button"
                className="skill-row-main"
                onClick={() => setSelectedId(skill.id)}
              >
                <span className="skill-row-heading">
                  <strong>{skill.name}</strong>
                  <span className={`provider-mark is-${skill.provider}`}>{skill.provider}</span>
                </span>
                <span className="skill-row-description">{skill.description || 'Sans description.'}</span>
                <span className="skill-row-source">{PROVENANCE_LABELS[skill.provenance]}</span>
              </button>
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
            </div>
          ))}
        </div>

        <article className="skill-preview" aria-live="polite">
          {activeSkill === null ? (
            <div className="library-empty">
              <strong>Sélectionnez un skill.</strong>
              <p>Son contenu source apparaîtra ici sans exécuter de script ni modifier le fichier.</p>
            </div>
          ) : selectedDetail === null ? (
            <p className="skill-preview-loading">Chargement de {activeSkill.name}…</p>
          ) : (
            <>
              <header className="skill-preview-header">
                <div>
                  <h2>{selectedDetail.name}</h2>
                  <p>{PROVENANCE_LABELS[selectedDetail.provenance]}</p>
                </div>
                <button
                  type="button"
                  className={`skill-favorite preview-favorite ${selectedDetail.favorite ? 'is-favorite' : ''}`}
                  onClick={() => void handleFavorite(selectedDetail)}
                  disabled={!project || savingFavorite}
                  aria-pressed={selectedDetail.favorite}
                  title={project ? `Favori pour ${project.name}` : 'Sélectionnez un projet pour gérer ses favoris'}
                >
                  <span aria-hidden="true">{selectedDetail.favorite ? '★' : '☆'}</span>
                  {selectedDetail.favorite ? ' Favori' : ' Favori projet'}
                </button>
              </header>
              {selectedDetail.triggers.length > 0 ? (
                <div className="skill-triggers" aria-label="Déclencheurs indexés">
                  {selectedDetail.triggers.map((trigger) => <span key={trigger}>{trigger}</span>)}
                </div>
              ) : null}
              <code className="skill-path" title={selectedDetail.path}>{selectedDetail.path}</code>
              <div className="skill-markdown">
                <ReactMarkdown>{selectedDetail.content_md}</ReactMarkdown>
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

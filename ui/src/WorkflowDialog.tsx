import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import {
  createWorkflow,
  deleteWorkflow,
  listPresets,
  listSkills,
  updateWorkflow,
} from './api'
import { PROVIDER_EFFORTS, PROVIDER_MODELS } from './modelOptions'
import type {
  ConversationSpeed,
  Preset,
  Project,
  Provider,
  SkillSummary,
  Workflow,
} from './types'

interface WorkflowDialogProps {
  project: Project
  workflows: Workflow[]
  initialWorkflow?: Workflow | null
  onClose: () => void
  onChanged: (workflows: Workflow[]) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Impossible de sauvegarder le workflow.'
}

function normalized(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

function skillOptionLabel(skill: SkillSummary): string {
  return `${skill.name} · $${skill.invocation}`
}

interface SkillComboboxProps {
  skills: SkillSummary[]
  query: string
  selectedId: string
  onQueryChange: (query: string) => void
  onSelect: (skill: SkillSummary | null) => void
}

function SkillCombobox({
  skills,
  query,
  selectedId,
  onQueryChange,
  onSelect,
}: SkillComboboxProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const filteredSkills = useMemo(() => {
    const needle = normalized(query.trim())
    if (!needle) return skills
    return skills.filter((skill) => normalized([
      skill.name,
      skill.invocation,
      skill.description,
      skill.provenance,
      ...skill.triggers,
    ].join(' ')).includes(needle))
  }, [query, skills])

  function selectSkill(skill: SkillSummary) {
    onQueryChange(skillOptionLabel(skill))
    onSelect(skill)
    setActiveIndex(0)
    setOpen(false)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((current) => filteredSkills.length
        ? Math.min(current + 1, filteredSkills.length - 1)
        : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter' && open) {
      const skill = filteredSkills[activeIndex]
      if (skill) {
        event.preventDefault()
        selectSkill(skill)
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div
      className="workflow-skill-combobox"
      onBlur={(event) => {
        const nextTarget = event.relatedTarget as Node | null
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) setOpen(false)
      }}
    >
      <input
        value={query}
        onChange={(event) => {
          const nextQuery = event.target.value
          onQueryChange(nextQuery)
          const exactMatch = skills.find((skill) => normalized(skillOptionLabel(skill)) === normalized(nextQuery.trim()))
          onSelect(exactMatch ?? null)
          setActiveIndex(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder="Rechercher un skill"
        required
        role="combobox"
        aria-autocomplete="list"
        aria-controls="workflow-skill-options"
        aria-expanded={open}
        aria-activedescendant={open && filteredSkills[activeIndex]
          ? `workflow-skill-option-${encodeURIComponent(filteredSkills[activeIndex]!.id)}`
          : undefined}
        aria-invalid={query.trim() !== '' && selectedId === ''}
      />
      {open ? (
        <div id="workflow-skill-options" className="workflow-skill-options" role="listbox" aria-label="Skills disponibles">
          {filteredSkills.length === 0 ? (
            <p className="workflow-skill-empty">Aucun skill correspondant.</p>
          ) : filteredSkills.map((skill, index) => (
            <button
              type="button"
              key={skill.id}
              id={`workflow-skill-option-${encodeURIComponent(skill.id)}`}
              className={`workflow-skill-option ${skill.id === selectedId ? 'is-selected' : ''} ${index === activeIndex ? 'is-active' : ''}`}
              role="option"
              aria-selected={skill.id === selectedId}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectSkill(skill)}
            >
              <strong>{skillOptionLabel(skill)}</strong>
              <small>{skill.provider} · {skill.provenance} · {skill.description || 'Sans description.'}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function WorkflowDialog({
  project,
  workflows,
  initialWorkflow = null,
  onClose,
  onChanged,
}: WorkflowDialogProps) {
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [skillId, setSkillId] = useState('')
  const [skillQuery, setSkillQuery] = useState('')
  const [prompt, setPrompt] = useState('')
  const [presetId, setPresetId] = useState(project.default_preset_id ?? 'builtin-speed')
  const [provider, setProvider] = useState<Provider>('codex')
  const [model, setModel] = useState<string>(PROVIDER_MODELS.codex[1])
  const [effort, setEffort] = useState('low')
  const [speed, setSpeed] = useState<ConversationSpeed>('fast')
  const [orchestrator, setOrchestrator] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      listSkills({ projectId: project.id, favoriteProjectId: project.id, signal: controller.signal }),
      listPresets(controller.signal),
    ]).then(([loadedSkills, loadedPresets]) => {
      if (controller.signal.aborted) return
      setSkills(loadedSkills)
      setPresets(loadedPresets)
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(loadError))
    })
    return () => controller.abort()
  }, [project.id])

  function resetForm() {
    setEditingId(null)
    setName('')
    setSkillId('')
    setSkillQuery('')
    setPrompt('')
    setPresetId(project.default_preset_id ?? 'builtin-speed')
    setProvider('codex')
    setModel(PROVIDER_MODELS.codex[1])
    setEffort('low')
    setSpeed('fast')
    setOrchestrator(true)
  }

  const edit = useCallback((workflow: Workflow) => {
    setEditingId(workflow.id)
    setName(workflow.name)
    setSkillId(workflow.skill_id ?? '')
    const selectedSkill = skills.find((skill) => skill.id === workflow.skill_id)
    setSkillQuery(selectedSkill ? skillOptionLabel(selectedSkill) : workflow.skill_invocation ? `$${workflow.skill_invocation}` : '')
    setPrompt(workflow.prompt)
    setPresetId(workflow.preset_id ?? '')
    setProvider(workflow.provider)
    setModel(workflow.model)
    setEffort(workflow.effort ?? 'high')
    setSpeed(workflow.speed ?? 'standard')
    setOrchestrator(workflow.orchestrator)
  }, [skills])

  useEffect(() => {
    if (initialWorkflow === null || skills.length === 0) return
    edit(initialWorkflow)
  }, [edit, initialWorkflow, skills.length])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting || !name.trim() || !prompt.trim()) return
    if (!skillId) {
      setError('Choisissez un skill dans la liste.')
      return
    }
    setIsSubmitting(true)
    setError(null)
    const input = {
      projectId: project.id,
      name: name.trim(),
      skillId,
      prompt: prompt.trim(),
      presetId: presetId || null,
      ...(!presetId ? {
        provider,
        model,
        effort,
        speed: provider === 'codex' ? speed : null,
        orchestrator,
      } : {}),
    }
    try {
      const saved = editingId
        ? await updateWorkflow(editingId, input)
        : await createWorkflow(input)
      onChanged(editingId
        ? workflows.map((workflow) => workflow.id === saved.id ? saved : workflow)
        : [...workflows, saved])
      resetForm()
    } catch (submitError: unknown) {
      setError(errorMessage(submitError))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function remove(workflow: Workflow) {
    if (!window.confirm(`Supprimer le workflow « ${workflow.name} » ?`)) return
    setError(null)
    try {
      await deleteWorkflow(workflow.id)
      onChanged(workflows.filter((item) => item.id !== workflow.id))
      if (editingId === workflow.id) resetForm()
    } catch (deleteError: unknown) {
      setError(errorMessage(deleteError))
    }
  }

  function handleProvider(next: Provider) {
    setProvider(next)
    setModel(PROVIDER_MODELS[next][0])
    setEffort('high')
    setSpeed('standard')
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal review-dialog workflow-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2 id="workflow-dialog-title">Workflows · {project.name}</h2>
            <p>Un clic lancera une conversation avec le skill et le prompt préparés.</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>

        <div className="workflow-dialog-body">
          <div className="workflow-existing">
            {workflows.length === 0 ? (
              <p>Aucun workflow. Créez un raccourci pour vos tâches répétitives.</p>
            ) : workflows.map((workflow) => (
              <div key={workflow.id} className="workflow-existing-row">
                <button type="button" onClick={() => edit(workflow)}>
                  <strong>{workflow.name}</strong>
                  <span>${workflow.skill_invocation} · {workflow.preset_id ? 'preset' : workflow.model}</span>
                </button>
                <button type="button" className="workflow-delete" onClick={() => void remove(workflow)} title="Supprimer ce workflow">×</button>
              </div>
            ))}
          </div>

          <form className="review-dialog-form workflow-form" onSubmit={(event) => void handleSubmit(event)}>
            <label>
              <span>Nom du workflow</span>
              <input value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label className="workflow-skill-field">
              <span>Skill</span>
              <SkillCombobox
                skills={skills}
                query={skillQuery}
                selectedId={skillId}
                onQueryChange={setSkillQuery}
                onSelect={(skill) => setSkillId(skill?.id ?? '')}
              />
            </label>
            <label>
              <span>Prompt pré-rempli</span>
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} required />
            </label>
            <label>
              <span>Preset</span>
              <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
                <option value="">Configuration manuelle</option>
                {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
            </label>
            {!presetId ? (
              <div className="workflow-model-grid">
                <label><span>Provider</span><select value={provider} onChange={(event) => handleProvider(event.target.value as Provider)}><option value="codex">codex</option><option value="claude">claude</option></select></label>
                <label><span>Modèle</span><select value={model} onChange={(event) => setModel(event.target.value)}>{PROVIDER_MODELS[provider].map((item) => <option key={item}>{item}</option>)}</select></label>
                <label><span>Effort</span><select value={effort} onChange={(event) => setEffort(event.target.value)}>{PROVIDER_EFFORTS[provider].map((item) => <option key={item}>{item}</option>)}</select></label>
                {provider === 'codex' ? <label><span>Vitesse</span><select value={speed} onChange={(event) => setSpeed(event.target.value as ConversationSpeed)}><option value="standard">standard</option><option value="fast">fast</option></select></label> : null}
                <label className="workflow-orchestrator"><input type="checkbox" checked={orchestrator} onChange={(event) => setOrchestrator(event.target.checked)} /><span>Orchestrateur</span></label>
              </div>
            ) : null}
            {error ? <p className="modal-error" role="alert">{error}</p> : null}
            <footer className="modal-actions">
              {editingId ? <button type="button" className="secondary-button" onClick={resetForm}>Nouveau</button> : null}
              <button type="submit" className="primary-button" disabled={isSubmitting || skills.length === 0}>{isSubmitting ? 'Sauvegarde…' : editingId ? 'Mettre à jour' : 'Créer'}</button>
            </footer>
          </form>
        </div>
      </section>
    </div>
  )
}

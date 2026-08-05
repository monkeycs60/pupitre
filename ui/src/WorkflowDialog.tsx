import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
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
  onClose: () => void
  onChanged: (workflows: Workflow[]) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Impossible de sauvegarder le workflow.'
}

export function WorkflowDialog({
  project,
  workflows,
  onClose,
  onChanged,
}: WorkflowDialogProps) {
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [skillId, setSkillId] = useState('')
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
      setSkillId((current) => current || loadedSkills[0]?.id || '')
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(loadError))
    })
    return () => controller.abort()
  }, [project.id])

  function resetForm() {
    setEditingId(null)
    setName('')
    setPrompt('')
    setPresetId(project.default_preset_id ?? 'builtin-speed')
    setProvider('codex')
    setModel(PROVIDER_MODELS.codex[1])
    setEffort('low')
    setSpeed('fast')
    setOrchestrator(true)
  }

  function edit(workflow: Workflow) {
    setEditingId(workflow.id)
    setName(workflow.name)
    setSkillId(workflow.skill_id ?? '')
    setPrompt(workflow.prompt)
    setPresetId(workflow.preset_id ?? '')
    setProvider(workflow.provider)
    setModel(workflow.model)
    setEffort(workflow.effort ?? 'high')
    setSpeed(workflow.speed ?? 'standard')
    setOrchestrator(workflow.orchestrator)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim() || !skillId || !prompt.trim() || isSubmitting) return
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
            <label>
              <span>Skill</span>
              <select value={skillId} onChange={(event) => setSkillId(event.target.value)} required>
                <option value="" disabled>Choisir un skill</option>
                {skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.favorite ? '★ ' : ''}{skill.name}</option>)}
              </select>
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

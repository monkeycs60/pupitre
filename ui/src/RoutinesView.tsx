import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  createRoutine,
  deleteRoutine,
  getSettings,
  listPresets,
  listProjects,
  listProjectWorkflows,
  listRoutineRuns,
  listRoutines,
  runRoutine,
  updateRoutine,
  updateSettings,
  type RoutineInput,
} from './api'
import type { Preset, Project, Routine, RoutineRun, Workflow } from './types'
import { HelpLink } from './HelpLink'

interface RoutinesViewProps {
  initialProject: Project | null
  onConversationSelect: (projectId: string, conversationId: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'La vue Routines est indisponible.'
}

function compactDate(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value))
}

function duration(run: RoutineRun): string {
  if (!run.completed_at) return 'en cours'
  const seconds = Math.max(0, Math.round(
    (new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1_000,
  ))
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

const SCHEDULE_PRESETS = [
  { value: '0 9 * * 1-5', label: 'Jours ouvrés · 09:00' },
  { value: '0 9 * * *', label: 'Tous les jours · 09:00' },
  { value: '0 9 * * 1', label: 'Chaque lundi · 09:00' },
] as const

function scheduleLabel(schedule: string): string {
  return SCHEDULE_PRESETS.find((preset) => preset.value === schedule)?.label ?? 'Planning personnalisé'
}

function toInput(routine: Routine, enabled = routine.enabled): RoutineInput {
  return {
    projectId: routine.project_id,
    name: routine.name,
    schedule: routine.schedule,
    workflowId: routine.workflow_id,
    prompt: routine.prompt,
    presetId: routine.preset_id,
    provider: routine.provider,
    model: routine.model,
    effort: routine.effort,
    speed: routine.speed,
    orchestrator: routine.orchestrator,
    enabled,
  }
}

export function RoutinesView({ initialProject, onConversationSelect }: RoutinesViewProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [routines, setRoutines] = useState<Routine[]>([])
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [projectFilter, setProjectFilter] = useState(initialProject?.id ?? '')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [projectId, setProjectId] = useState(initialProject?.id ?? '')
  const [name, setName] = useState('')
  const [schedule, setSchedule] = useState('0 9 * * 1-5')
  const [workflowId, setWorkflowId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [presetId, setPresetId] = useState('builtin-speed')
  const [enabled, setEnabled] = useState(true)
  const [longTaskThreshold, setLongTaskThreshold] = useState(120)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selectedSchedulePreset = SCHEDULE_PRESETS.some((preset) => preset.value === schedule) ? schedule : 'custom'

  const selected = useMemo(
    () => routines.find((routine) => routine.id === selectedId) ?? null,
    [routines, selectedId],
  )

  useEffect(() => {
    let ignore = false
    void Promise.all([listProjects(), listPresets(), getSettings()])
      .then(([loadedProjects, loadedPresets, settings]) => {
        if (ignore) return
        setProjects(loadedProjects)
        setPresets(loadedPresets)
        setLongTaskThreshold(settings.longTaskThresholdSeconds ?? 120)
      })
      .catch((loadError: unknown) => !ignore && setError(errorMessage(loadError)))
    return () => { ignore = true }
  }, [])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refreshList() {
      try {
        const loadedRoutines = await listRoutines(projectFilter || undefined)
        if (disposed) return
        setRoutines(loadedRoutines)
        setSelectedId((current) => loadedRoutines.some((item) => item.id === current)
          ? current
          : null)
      } catch (loadError) {
        if (!disposed) setError(errorMessage(loadError))
      } finally {
        if (!disposed) timer = setTimeout(() => void refreshList(), 5_000)
      }
    }
    void refreshList()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [projectFilter])

  useEffect(() => {
    if (!projectId) {
      setWorkflows([])
      return
    }
    let ignore = false
    void listProjectWorkflows(projectId)
      .then((items) => { if (!ignore) setWorkflows(items) })
      .catch((loadError: unknown) => !ignore && setError(errorMessage(loadError)))
    return () => { ignore = true }
  }, [projectId])

  useEffect(() => {
    if (!selectedId) {
      setRuns([])
      return
    }
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      try {
        const items = await listRoutineRuns(selectedId as string)
        if (!disposed) setRuns(items)
      } catch (loadError) {
        if (!disposed) setError(errorMessage(loadError))
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 3_000)
      }
    }
    void refresh()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [selectedId])

  function resetForm() {
    setEditingId(null)
    setProjectId(projectFilter || initialProject?.id || projects[0]?.id || '')
    setName('')
    setSchedule('0 9 * * 1-5')
    setWorkflowId('')
    setPrompt('')
    setPresetId(initialProject?.default_preset_id ?? 'builtin-speed')
    setEnabled(true)
  }

  function startCreate() {
    resetForm()
    setShowForm(true)
  }

  function startEdit(routine: Routine) {
    setEditingId(routine.id)
    setProjectId(routine.project_id)
    setName(routine.name)
    setSchedule(routine.schedule)
    setWorkflowId(routine.workflow_id ?? '')
    setPrompt(routine.prompt ?? '')
    setPresetId(routine.preset_id ?? 'builtin-speed')
    setEnabled(routine.enabled)
    setShowForm(true)
  }

  async function reload(preferredId?: string) {
    const items = await listRoutines(projectFilter || undefined)
    setRoutines(items)
    setSelectedId(preferredId && items.some((item) => item.id === preferredId)
      ? preferredId
      : null)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!projectId || !name.trim() || !schedule.trim()) return
    if (!workflowId && !prompt.trim()) {
      setError('Choisissez un workflow ou saisissez un prompt.')
      return
    }
    const workflow = workflows.find((item) => item.id === workflowId)
    const preset = presets.find((item) => item.id === presetId)
    const config = workflow ?? preset
    const input: RoutineInput = {
      projectId,
      name: name.trim(),
      schedule: schedule.trim(),
      workflowId: workflowId || null,
      prompt: workflowId ? null : prompt.trim(),
      presetId: workflowId ? null : presetId || null,
      provider: config?.provider ?? 'codex',
      model: config?.model ?? 'gpt-5.6-luna',
      effort: config?.effort ?? 'low',
      speed: config?.speed ?? 'fast',
      orchestrator: config?.orchestrator ?? true,
      enabled,
    }
    setBusy('save')
    setError(null)
    try {
      const saved = editingId
        ? await updateRoutine(editingId, input)
        : await createRoutine(input)
      await reload(saved.id)
      setShowForm(false)
      resetForm()
    } catch (saveError) {
      setError(errorMessage(saveError))
    } finally {
      setBusy(null)
    }
  }

  async function toggle(routine: Routine) {
    setBusy(routine.id)
    setError(null)
    try {
      const updated = await updateRoutine(routine.id, toInput(routine, !routine.enabled))
      setRoutines((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (toggleError) {
      setError(errorMessage(toggleError))
    } finally {
      setBusy(null)
    }
  }

  async function runNow(routine: Routine) {
    setBusy(`run-${routine.id}`)
    setError(null)
    try {
      await runRoutine(routine.id)
      setRuns(await listRoutineRuns(routine.id))
      await reload(routine.id)
    } catch (runError) {
      setError(errorMessage(runError))
    } finally {
      setBusy(null)
    }
  }

  async function remove(routine: Routine) {
    if (!window.confirm(`Supprimer la routine « ${routine.name} » et son historique ?`)) return
    setBusy(routine.id)
    setError(null)
    try {
      await deleteRoutine(routine.id)
      await reload()
    } catch (deleteError) {
      setError(errorMessage(deleteError))
    } finally {
      setBusy(null)
    }
  }

  async function saveLongTaskThreshold() {
    setBusy('threshold')
    setError(null)
    try {
      const settings = await updateSettings({ longTaskThresholdSeconds: longTaskThreshold })
      setLongTaskThreshold(settings.longTaskThresholdSeconds ?? longTaskThreshold)
    } catch (settingsError) {
      setError(errorMessage(settingsError))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="routines-view" aria-labelledby="routines-title">
      <header className="routines-header">
        <div>
          <h1 id="routines-title">Routines</h1>
          <p>Exécutions planifiées dans des conversations normales, sans cron système.</p>
          <HelpLink slug="routines" />
        </div>
        <div className="routines-header-actions">
          <label>
            <span>Projet</span>
            <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
              <option value="">Tous les projets</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className="threshold-setting" title="Notifier à la fin d’une tâche interactive qui dépasse cette durée.">
            <span>Notif tâche ≥</span>
            <input type="number" min={10} max={86400} value={longTaskThreshold} onChange={(event) => setLongTaskThreshold(Number(event.target.value))} />
          </label>
          <button
            type="button"
            className="text-button threshold-save"
            onClick={() => void saveLongTaskThreshold()}
            disabled={busy === 'threshold'}
            title="Enregistrer le seuil de notification"
          >
            {busy === 'threshold' ? 'Enregistrement…' : 'Enregistrer'}
          </button>
          <button type="button" className="header-action" onClick={startCreate}>Nouvelle routine</button>
        </div>
      </header>

      {error ? <p className="routines-error" role="alert">{error}</p> : null}

      {showForm ? (
        <form className="routine-form" onSubmit={(event) => void submit(event)}>
          <label><span>Projet</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)} required disabled={editingId !== null}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label><span>Nom</span><input value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label><span>Fréquence</span><select value={selectedSchedulePreset} onChange={(event) => setSchedule(event.target.value === 'custom' ? '' : event.target.value)} required><option value="custom">Planning personnalisé</option>{SCHEDULE_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}</select></label>
          {selectedSchedulePreset === 'custom' ? <label><span>Cron avancé</span><input className="cron-input" value={schedule} onChange={(event) => setSchedule(event.target.value)} placeholder="0 9 * * 1-5" required aria-describedby="routine-schedule-help" /><small id="routine-schedule-help">Fuseau local · cinq champs cron</small></label> : null}
          <label><span>Workflow</span><select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}><option value="">Prompt libre</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label>
          {!workflowId ? <label className="routine-prompt"><span>Prompt</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} required /></label> : null}
          {!workflowId ? <label><span>Preset</span><select value={presetId} onChange={(event) => setPresetId(event.target.value)}>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label> : null}
          <label className="routine-enabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>Active</span></label>
          <div className="routine-form-actions">
            <button type="button" className="text-button" onClick={() => setShowForm(false)}>Annuler</button>
            <button type="submit" className="header-action" disabled={busy === 'save'}>{busy === 'save' ? 'Enregistrement…' : editingId ? 'Mettre à jour' : 'Créer'}</button>
          </div>
        </form>
      ) : null}

      <div className="routines-body">
        <nav className="routine-list" aria-label="Routines enregistrées">
          {routines.length === 0 ? (
            <div className="routine-empty"><strong>Aucune routine</strong><p>Planifiez un workflow ou un prompt ; chaque passage créera une conversation consultable.</p></div>
          ) : routines.map((routine) => (
            <button key={routine.id} type="button" className={`routine-row ${selectedId === routine.id ? 'is-selected' : ''}`} onClick={() => setSelectedId(routine.id)}>
              <span className="routine-row-title"><strong>{routine.name}</strong><em className={routine.enabled ? 'is-on' : ''}>{routine.enabled ? 'active' : 'pause'}</em></span>
              <span>{projects.find((project) => project.id === routine.project_id)?.name ?? 'Projet'} · {scheduleLabel(routine.schedule)}</span>
              <span>Prochain passage · {compactDate(routine.next_run_at)}</span>
            </button>
          ))}
        </nav>

        <section className="routine-detail">
          {selected ? (
            <>
              <header className="routine-detail-header">
                <div><h2>{selected.name}</h2><p>{selected.workflow_id ? 'Workflow épinglé' : selected.prompt}</p></div>
                <div>
                  <button type="button" className="text-button" onClick={() => startEdit(selected)}>Modifier</button>
                  <button type="button" className="text-button" onClick={() => void toggle(selected)} disabled={busy === selected.id}>{selected.enabled ? 'Mettre en pause' : 'Activer'}</button>
                  <button type="button" className="text-button danger-text" onClick={() => void remove(selected)} disabled={busy === selected.id}>Supprimer</button>
                  <button type="button" className="header-action" onClick={() => void runNow(selected)} disabled={busy === `run-${selected.id}`}>{busy === `run-${selected.id}` ? 'Exécution…' : 'Lancer maintenant'}</button>
                </div>
              </header>
              <div className="routine-meta"><span>{scheduleLabel(selected.schedule)} · <code>{selected.schedule}</code></span><span>{selected.provider} · {selected.model}</span><span>prochain {compactDate(selected.next_run_at)}</span></div>
              <h3>Historique</h3>
              {runs.length === 0 ? <div className="routine-empty"><strong>Aucun passage</strong><p>Lancez la routine maintenant ou attendez sa prochaine occurrence.</p></div> : (
                <div className="routine-runs">
                  <div className="routine-run routine-run-head"><span>Début</span><span>État</span><span>Durée</span><span>Coût</span><span>Sortie</span></div>
                  {runs.map((run) => (
                    <div className="routine-run" key={run.id}>
                      <span>{compactDate(run.started_at)}</span>
                      <span className={`run-status is-${run.status}`}>{run.status === 'done' ? 'terminé' : run.status === 'error' ? 'échec' : 'en cours'}</span>
                      <span>{duration(run)}</span>
                      <span>{run.tokens.toLocaleString('fr-FR')} tokens</span>
                      <span>{run.conversation_id ? <button type="button" className="text-button" onClick={() => onConversationSelect(selected.project_id, run.conversation_id as string)}>Ouvrir</button> : run.error ?? '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : <div className="routine-empty"><strong>Sélectionnez une routine</strong><p>Son planning, ses sorties et sa consommation apparaîtront ici.</p></div>}
        </section>
      </div>
    </section>
  )
}

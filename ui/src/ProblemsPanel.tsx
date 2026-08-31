import { useState } from 'react'
import {
  closeProblem,
  createConversation,
  deleteProblem,
  listPresets,
  reopenProblem,
  retryProblemCapture,
  updateProblemTicket,
} from './api'
import { configOf } from './ConfigPanel'
import { buildCreateConversationInput } from './conversationDraft'
import { problemMissionDraft, type ProblemMissionMode, type ProblemMissionSeed } from './problemMission'
import type { Problem, ProblemProjectPayload, Project, TicketRow } from './types'

export type { ProblemMissionSeed } from './problemMission'

interface ProblemsPanelProps {
  project: Project
  payload: ProblemProjectPayload
  tickets: TicketRow[]
  onChanged: () => void
  onStartConversation: (seed: ProblemMissionSeed) => void
  onConversationSelect: (conversationId: string) => void
}

interface MissionLaunchProps {
  label: string
  disabled: boolean
  busy: boolean
  onLaunch: (mode: ProblemMissionMode) => void
}

function MissionLaunch({ label, disabled, busy, onLaunch }: MissionLaunchProps) {
  const [open, setOpen] = useState(false)

  function pick(mode: ProblemMissionMode) {
    setOpen(false)
    onLaunch(mode)
  }

  return (
    <div
      className="problem-launch-menu"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        type="button"
        className="primary-button"
        disabled={disabled || busy}
        onClick={() => pick('agent')}
      >
        {busy ? 'Lancement…' : label}
      </button>
      <button
        type="button"
        className="primary-button problem-launch-caret"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choisir le mode de lancement"
        disabled={disabled || busy}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div className="problem-launch-dropdown" role="menu">
          <button type="button" role="menuitem" onClick={() => pick('agent')}>
            Lancer en agentique
            <small>La conversation démarre seule, sans passer par le composer.</small>
          </button>
          <button type="button" role="menuitem" onClick={() => pick('conversation')}>
            Ouvrir en conversation
            <small>Brouillon prérempli : tu choisis la config puis tu envoies.</small>
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function ProblemsPanel({
  project,
  payload,
  tickets,
  onChanged,
  onStartConversation,
  onConversationSelect,
}: ProblemsPanelProps) {
  const [filter, setFilter] = useState<'open' | 'closed'>('open')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [excludedAxes, setExcludedAxes] = useState<Record<string, number[]>>({})
  const [missionTitle, setMissionTitle] = useState('')
  const visibleProblems = payload.problems.filter((problem) => problem.status === filter)
  const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]))

  async function mutate(key: string, operation: () => Promise<unknown>) {
    if (busy) return
    setBusy(key)
    setError(null)
    try {
      await operation()
      onChanged()
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'Action impossible.')
    } finally {
      setBusy(null)
    }
  }

  function changeFilter(nextFilter: 'open' | 'closed') {
    setFilter(nextFilter)
    setSelectedIds(new Set())
    setMissionTitle('')
  }

  function toggleProblem(problem: Problem) {
    const next = new Set(selectedIds)
    if (next.has(problem.id)) next.delete(problem.id)
    else next.add(problem.id)
    setSelectedIds(next)
    if (next.size < 2) setMissionTitle('')
    else if (!missionTitle.trim()) setMissionTitle(`Mission · ${next.size} problématiques`)
  }

  function axesOf(problem: Problem): number[] {
    const excluded = excludedAxes[problem.id] ?? []
    return problem.plans
      .map((_, index) => index)
      .filter((index) => !excluded.includes(index))
  }

  function toggleAxis(problem: Problem, index: number) {
    const excluded = excludedAxes[problem.id] ?? []
    setExcludedAxes({
      ...excludedAxes,
      [problem.id]: excluded.includes(index)
        ? excluded.filter((candidate) => candidate !== index)
        : [...excluded, index],
    })
  }

  function planIndicesOf(problems: Problem[]): Record<string, number[]> {
    return Object.fromEntries(problems.map((problem) => [problem.id, axesOf(problem)]))
  }

  /**
   * Le lancement agentique n'ouvre pas le composer : la conversation naît avec
   * le preset par défaut du projet et son premier tour part immédiatement.
   */
  async function launchAgent(seed: ProblemMissionSeed) {
    const presets = await listPresets()
    const preset = presets.find((candidate) => candidate.id === project.default_preset_id)
      ?? presets.find((candidate) => candidate.id === 'builtin-speed')
      ?? presets[0]
    if (!preset) throw new Error('Aucun preset disponible pour lancer la mission.')
    const first = seed.problems[0]!
    const sharedTicketId = first.ticket_id !== null
      && seed.problems.every((problem) => problem.ticket_id === first.ticket_id)
      ? first.ticket_id
      : null
    const sharedBranch = first.ticket_branch
      && seed.problems.every((problem) => problem.ticket_branch === first.ticket_branch)
      ? first.ticket_branch
      : null
    const conversation = await createConversation(buildCreateConversationInput({
      projectId: project.id,
      ...configOf(preset),
      branch: sharedBranch,
      ticketId: sharedTicketId,
      problemIds: seed.problems.map((problem) => problem.id),
      problemPlanIndices: seed.planIndices,
      missionTitle: seed.missionTitle,
      message: problemMissionDraft(seed),
      images: [],
    }))
    onConversationSelect(conversation.id)
  }

  function launch(seed: ProblemMissionSeed, mode: ProblemMissionMode) {
    if (mode === 'conversation') {
      onStartConversation({ ...seed, mode })
      return
    }
    void mutate(`launch:${seed.problems.map((problem) => problem.id).join(',')}`, () => launchAgent(seed))
  }

  const selectedProblems = visibleProblems.filter((problem) => selectedIds.has(problem.id))
  const groupAxisCount = selectedProblems.reduce((total, problem) => total + axesOf(problem).length, 0)

  return (
    <section
      id="dashboard-panel-problems"
      role="tabpanel"
      aria-labelledby="dashboard-tab-problems"
      className="dashboard-section problems-panel"
    >
      <div className="dashboard-section-head">
        <div>
          <h2 className="dashboard-section-title">Problématiques</h2>
          <p>Du vrac capturé au travail prêt à lancer.</p>
        </div>
        <div className="problems-filter" role="group" aria-label="Filtrer les problématiques">
          <button type="button" aria-pressed={filter === 'open'} onClick={() => changeFilter('open')}>Ouvertes</button>
          <button type="button" aria-pressed={filter === 'closed'} onClick={() => changeFilter('closed')}>Fermées</button>
        </div>
      </div>

      {error ? <p className="dashboard-banner is-danger" role="alert">{error}</p> : null}

      {selectedProblems.length >= 2 ? (
        <div className="problem-group-bar" aria-label="Regrouper les problématiques sélectionnées">
          <strong>{selectedProblems.length} sélectionnées · {groupAxisCount} axe{groupAxisCount > 1 ? 's' : ''}</strong>
          <label>
            <span>Titre</span>
            <input
              aria-label="Titre de la mission"
              value={missionTitle}
              onChange={(event) => setMissionTitle(event.target.value)}
            />
          </label>
          <MissionLaunch
            label="Lancer ensemble"
            busy={busy === `launch:${selectedProblems.map((problem) => problem.id).join(',')}`}
            disabled={!missionTitle.trim() || groupAxisCount === 0}
            onLaunch={(mode) => launch({
              problems: selectedProblems,
              planIndices: planIndicesOf(selectedProblems),
              missionTitle: missionTitle.trim(),
            }, mode)}
          />
        </div>
      ) : null}

      {payload.captures.map((capture) => (
        <article key={capture.id} className={`problem-capture is-${capture.status}`}>
          <div>
            <strong>{capture.status === 'error' ? 'Traitement en échec' : 'Traitement en cours'}</strong>
            <p>{capture.status === 'error' ? capture.error : 'Luna structure le collage et prépare les conversations.'}</p>
          </div>
          {capture.status === 'error' ? (
            <button
              type="button"
              className="secondary-button"
              disabled={busy === `retry:${capture.id}`}
              onClick={() => void mutate(`retry:${capture.id}`, () => retryProblemCapture(capture.id))}
            >
              Réessayer
            </button>
          ) : <span className="problem-processing" aria-label="Traitement en cours" />}
        </article>
      ))}

      {visibleProblems.length === 0 ? (
        <div className="dashboard-empty">
          <strong>{filter === 'open' ? 'Aucune problématique ouverte' : 'Aucune problématique fermée'}</strong>
          <p>{filter === 'open' ? 'Capture un bloc de notes pour préparer le prochain travail.' : 'Les résolutions apparaîtront ici.'}</p>
        </div>
      ) : (
        <div className="problems-list">
          {visibleProblems.map((problem) => {
            const ticket = problem.ticket_id ? ticketsById.get(problem.ticket_id) : undefined
            const axes = axesOf(problem)
            return (
              <article key={problem.id} className="problem-card">
                <header>
                  {problem.status === 'open' ? (
                    <input
                      type="checkbox"
                      className="problem-select"
                      aria-label={`Sélectionner ${problem.public_id}`}
                      checked={selectedIds.has(problem.id)}
                      onChange={() => toggleProblem(problem)}
                    />
                  ) : null}
                  <div>
                    <span className="problem-id">{problem.public_id}</span>
                    {ticket ? <span className="problem-ticket">{ticket.key}</span> : null}
                    {problem.conversation_count > 0 ? <span>{problem.conversation_count} conv.</span> : null}
                  </div>
                  <h3>{problem.title}</h3>
                </header>
                <div className="problem-copy">
                  <div><strong>Contexte</strong><p>{problem.context}</p></div>
                  <div><strong>Résolution attendue</strong><p>{problem.resolution}</p></div>
                </div>
                <ol className="problem-plans">
                  {problem.plans.map((plan, planIndex) => (
                    <li key={`${problem.id}:${planIndex}`}>
                      {problem.status === 'open' ? (
                        <label className="problem-axis">
                          <input
                            type="checkbox"
                            aria-label={`Axe ${plan.title} de ${problem.public_id}`}
                            checked={axes.includes(planIndex)}
                            onChange={() => toggleAxis(problem, planIndex)}
                          />
                          <div><strong>{plan.title}</strong><p>{plan.instruction}</p></div>
                        </label>
                      ) : (
                        <div><strong>{plan.title}</strong><p>{plan.instruction}</p></div>
                      )}
                    </li>
                  ))}
                </ol>
                {problem.status === 'open' ? (
                  <div className="problem-launch-row">
                    <span>{axes.length}/{problem.plans.length} axe{problem.plans.length > 1 ? 's' : ''}</span>
                    <MissionLaunch
                      label={axes.length === problem.plans.length
                        ? 'Lancer tous les axes'
                        : `Lancer ${axes.length} axe${axes.length > 1 ? 's' : ''}`}
                      busy={busy === `launch:${problem.id}`}
                      disabled={axes.length === 0}
                      onLaunch={(mode) => launch({
                        problems: [problem],
                        planIndices: { [problem.id]: axes },
                        missionTitle: problem.title,
                      }, mode)}
                    />
                  </div>
                ) : null}
                <footer className="problem-actions">
                  {problem.status === 'open' ? (
                    <label>
                      <span>Ticket</span>
                      <select
                        aria-label={`Ticket de ${problem.public_id}`}
                        value={problem.ticket_id ?? ''}
                        disabled={busy === `ticket:${problem.id}`}
                        onChange={(event) => void mutate(
                          `ticket:${problem.id}`,
                          () => updateProblemTicket(problem.id, event.target.value || null),
                        )}
                      >
                        <option value="">Sans ticket</option>
                        {tickets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.key} · {candidate.title}</option>)}
                      </select>
                    </label>
                  ) : problem.closed_commit_sha ? (
                    <span className="problem-closed-sha">Fermée par <code>{problem.closed_commit_sha.slice(0, 7)}</code></span>
                  ) : <span>Fermée manuellement</span>}
                  <div>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy === `status:${problem.id}`}
                      aria-label={`${problem.status === 'open' ? 'Fermer' : 'Rouvrir'} ${problem.public_id}`}
                      onClick={() => void mutate(
                        `status:${problem.id}`,
                        () => problem.status === 'open' ? closeProblem(problem.id) : reopenProblem(problem.id),
                      )}
                    >
                      {problem.status === 'open' ? 'Fermer' : 'Rouvrir'}
                    </button>
                    <button
                      type="button"
                      className="text-button is-danger"
                      aria-label={`Supprimer ${problem.public_id}`}
                      onClick={() => {
                        if (!window.confirm(`Supprimer définitivement ${problem.public_id} ?`)) return
                        void mutate(`delete:${problem.id}`, () => deleteProblem(problem.id))
                      }}
                    >
                      Supprimer
                    </button>
                  </div>
                </footer>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

import { useState } from 'react'
import {
  closeProblem,
  deleteProblem,
  reopenProblem,
  retryProblemCapture,
  updateProblemTicket,
} from './api'
import type { Problem, ProblemProjectPayload, TicketRow } from './types'

export interface ProblemMissionSeed {
  problems: Problem[]
  missionTitle: string
}

interface ProblemsPanelProps {
  payload: ProblemProjectPayload
  tickets: TicketRow[]
  onChanged: () => void
  onStartConversation: (seed: ProblemMissionSeed) => void
}

export function ProblemsPanel({
  payload,
  tickets,
  onChanged,
  onStartConversation,
}: ProblemsPanelProps) {
  const [filter, setFilter] = useState<'open' | 'closed'>('open')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
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

  const selectedProblems = visibleProblems.filter((problem) => selectedIds.has(problem.id))

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
          <strong>{selectedProblems.length} sélectionnées</strong>
          <label>
            <span>Titre</span>
            <input
              aria-label="Titre de la mission"
              value={missionTitle}
              onChange={(event) => setMissionTitle(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={!missionTitle.trim()}
            onClick={() => onStartConversation({ problems: selectedProblems, missionTitle: missionTitle.trim() })}
          >
            Lancer ensemble
          </button>
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
                      <div><strong>{plan.title}</strong><p>{plan.instruction}</p></div>
                    </li>
                  ))}
                </ol>
                {problem.status === 'open' ? (
                  <div className="problem-launch-row">
                    <span>{problem.plans.length} axe{problem.plans.length > 1 ? 's' : ''}</span>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => onStartConversation({ problems: [problem], missionTitle: problem.title })}
                    >
                      Lancer tous les axes
                    </button>
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

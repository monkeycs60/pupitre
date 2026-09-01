import { useEffect, useMemo, useState } from 'react'
import { listProjectProblems } from './api'
import type { Problem } from './types'
import type { ProblemMissionSeed } from './problemMission'

interface ProblemSuggestionsProps {
  problems: Problem[]
  onSelect: (seed: ProblemMissionSeed) => void
  onSeeAll: () => void
}

interface ProblemSuggestionsLoaderProps {
  projectId: string
  onSelect: (seed: ProblemMissionSeed) => void
  onSeeAll: () => void
}

export function ProblemSuggestions({ problems, onSelect, onSeeAll }: ProblemSuggestionsProps) {
  const suggestions = useMemo(() => [...problems]
    .filter((problem) => problem.status === 'open' && (problem.axis_states === undefined || problem.axis_states.some((axis) => (
      axis.status === 'interrupted' || axis.status === 'failed' || axis.status === 'awaiting_validation'
    ))))
    .sort((left, right) => {
      const launchPriority = Number(left.conversation_count > 0) - Number(right.conversation_count > 0)
      return launchPriority || Date.parse(right.created_at) - Date.parse(left.created_at)
    })
    .slice(0, 5), [problems])

  if (suggestions.length === 0) return null

  return (
    <aside className="problem-suggestions" aria-label="Problématiques à reprendre">
      <header>
        <div><strong>À reprendre</strong><span>{suggestions.length} problématique{suggestions.length > 1 ? 's' : ''} ouverte{suggestions.length > 1 ? 's' : ''}</span></div>
        <button type="button" className="text-button" onClick={onSeeAll}>Voir toutes</button>
      </header>
      <ul>
        {suggestions.map((problem) => (
          <li key={problem.id}>
            <div className="problem-suggestion-copy">
              <div><span className="problem-id">{problem.public_id}</span><strong>{problem.title}</strong></div>
              <div className="problem-suggestion-meta">
                {problem.ticket_key ? <span>{problem.ticket_key} · {problem.ticket_title}</span> : <span>Sans ticket</span>}
                {problem.ticket_branch ? <code>{problem.ticket_branch}</code> : null}
                <span>{problem.axis_states ? `${problem.axis_states.filter((axis) => ['interrupted', 'failed', 'awaiting_validation'].includes(axis.status)).length} axe${problem.axis_states.filter((axis) => ['interrupted', 'failed', 'awaiting_validation'].includes(axis.status)).length > 1 ? 's' : ''} à reprendre` : `${problem.plans.length} axe${problem.plans.length > 1 ? 's' : ''}`}</span>
              </div>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onSelect(problem.axis_states ? {
                problems: [problem], missionTitle: problem.title,
                planIndices: { [problem.id]: problem.axis_states.filter((axis) => ['interrupted', 'failed', 'awaiting_validation'].includes(axis.status)).map((axis) => axis.plan_index) },
              } : { problems: [problem], missionTitle: problem.title })}
            >
              Lancer
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}

export function ProblemSuggestionsLoader({ projectId, onSelect, onSeeAll }: ProblemSuggestionsLoaderProps) {
  const [problems, setProblems] = useState<Problem[]>([])

  useEffect(() => {
    const controller = new AbortController()
    void listProjectProblems(projectId, 'open', controller.signal)
      .then((payload) => setProblems(payload.problems))
      .catch(() => {})
    return () => controller.abort()
  }, [projectId])

  return <ProblemSuggestions problems={problems} onSelect={onSelect} onSeeAll={onSeeAll} />
}

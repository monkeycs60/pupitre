import { useEffect, useMemo, useState } from 'react'
import { listProjectProblems } from './api'
import type { Problem } from './types'
import type { ProblemConversationSeed } from './ProblemsPanel'

interface ProblemSuggestionsProps {
  problems: Problem[]
  onSelect: (seed: ProblemConversationSeed) => void
  onSeeAll: () => void
}

interface ProblemSuggestionsLoaderProps {
  projectId: string
  onSelect: (seed: ProblemConversationSeed) => void
  onSeeAll: () => void
}

export function ProblemSuggestions({ problems, onSelect, onSeeAll }: ProblemSuggestionsProps) {
  const suggestions = useMemo(() => [...problems]
    .filter((problem) => problem.status === 'open')
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
            <div><span className="problem-id">{problem.public_id}</span><strong>{problem.title}</strong></div>
            <div className="problem-suggestion-actions">
              {problem.plans.map((plan, planIndex) => (
                <button
                  key={`${problem.id}:${planIndex}`}
                  type="button"
                  className="secondary-button"
                  onClick={() => onSelect({
                    problem,
                    plan,
                    planIndex,
                    originType: 'problem',
                    originKey: problem.public_id,
                    problemPlanIndex: planIndex,
                  })}
                >
                  Lancer {plan.title}
                </button>
              ))}
            </div>
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

import { useEffect, useState } from 'react'
import { suggestSkills } from './api'
import {
  SKILL_SUGGESTION_ACTION_LABEL,
  rankSuggestionsWithFeedback,
  setSuggestionFeedback,
  suggestionFeedbackKey,
  type SuggestionFeedback,
  type SuggestionFeedbackMap,
} from './skillSuggestionFeedback'
import type { SkillSuggestion, SkillSuggestionResult } from './types'

const SUGGESTION_FEEDBACK_STORAGE_KEY = 'pupitre.skill-suggestion-feedback.v1'

function readSuggestionFeedback(): SuggestionFeedbackMap {
  if (typeof window === 'undefined') return {}
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(SUGGESTION_FEEDBACK_STORAGE_KEY) ?? '{}',
    )
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, SuggestionFeedback] => (
        entry[1] === 'useful' || entry[1] === 'irrelevant'
      )),
    )
  } catch {
    return {}
  }
}

function writeSuggestionFeedback(feedback: SuggestionFeedbackMap): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      SUGGESTION_FEEDBACK_STORAGE_KEY,
      JSON.stringify(feedback),
    )
  } catch {
    // Le panneau reste utilisable si le stockage web est indisponible.
  }
}

const SKILL_SOURCE_LABELS: Record<SkillSuggestion['provenance'], string> = {
  'claude-global': 'Claude · global',
  'claude-plugin': 'Claude · plugin',
  'claude-project': 'Claude · projet',
  'codex-prompt': 'Codex · prompt',
  'agents-global': 'AGENTS · global',
  'agents-project': 'AGENTS · projet',
}

interface SkillsSuggestionsPanelProps {
  projectId: string
  text: string
  open: boolean
  onToggle: () => void
  onLaunch: (skill: SkillSuggestion) => void
}

interface SuggestionState {
  text: string
  result: SkillSuggestionResult
}

interface SuggestionError {
  text: string
  message: string
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export function SkillsSuggestionsPanel({
  projectId,
  text,
  open,
  onToggle,
  onLaunch,
}: SkillsSuggestionsPanelProps) {
  const [state, setState] = useState<SuggestionState | null>(null)
  const [error, setError] = useState<SuggestionError | null>(null)
  const [feedback, setFeedback] = useState<SuggestionFeedbackMap>(() => readSuggestionFeedback())
  const normalizedText = text.trim()

  useEffect(() => {
    if (!open || normalizedText.length < 3) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void suggestSkills(projectId, normalizedText, false, controller.signal)
        .then(async (result) => {
          if (controller.signal.aborted) return
          setState({ text: normalizedText, result })
          setError(null)
          if (!result.ambiguous) return
          await wait(650, controller.signal)
          if (controller.signal.aborted) return
          const resolved = await suggestSkills(
            projectId,
            normalizedText,
            true,
            controller.signal,
          )
          if (!controller.signal.aborted) {
            setState({ text: normalizedText, result: resolved })
          }
        })
        .catch((loadError: unknown) => {
          if (controller.signal.aborted) return
          setError({
            text: normalizedText,
            message: loadError instanceof Error
              ? loadError.message
              : 'Suggestions indisponibles.',
          })
        })
    }, 450)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, normalizedText, projectId])

  if (!open) {
    return (
      <aside className="skill-suggestions-rail" aria-label="Skills suggérés">
        <button
          type="button"
          onClick={onToggle}
          title="Ouvrir les suggestions de skills adaptées au message en cours."
        >
          Skills
        </button>
      </aside>
    )
  }

  const result = state?.text === normalizedText ? state.result : null
  const suggestions = result === null
    ? []
    : rankSuggestionsWithFeedback(result.suggestions, projectId, feedback)
  const currentError = error?.text === normalizedText ? error.message : null
  const loading = normalizedText.length >= 3 && result === null && currentError === null

  function handleFeedback(skillId: string, value: SuggestionFeedback) {
    const next = setSuggestionFeedback(feedback, projectId, skillId, value)
    setFeedback(next)
    writeSuggestionFeedback(next)
  }

  return (
    <aside className="skill-suggestions" aria-labelledby="skill-suggestions-title">
      <header>
        <div>
          <h2 id="skill-suggestions-title">Skills suggérés</h2>
          <p>Selon le brouillon ou le dernier tour</p>
        </div>
        <button
          type="button"
          className="panel-collapse"
          onClick={onToggle}
          aria-label="Replier les suggestions de skills"
          title="Replier ce panneau ; c’est le seul panneau latéral de Pupitre."
        >
          ›
        </button>
      </header>

      <div className="skill-suggestions-content">
        {normalizedText.length < 3 ? (
          <p className="suggestions-empty">
            Commencez un message : Pupitre comparera ses mots aux descriptions et déclencheurs indexés.
          </p>
        ) : loading ? (
          <p className="suggestions-status">Recherche dans la bibliothèque…</p>
        ) : currentError ? (
          <p className="suggestions-error" role="alert">{currentError}</p>
        ) : suggestions.length === 0 ? (
          <p className="suggestions-empty">
            Aucune correspondance nette. Vous pouvez toujours invoquer un skill avec <code>$son-nom</code>.
          </p>
        ) : (
          <>
            {result?.resolvedByModel ? (
              <p className="suggestions-status">Luna fast a départagé les correspondances proches.</p>
            ) : result?.ambiguous ? (
              <p className="suggestions-status">Correspondances proches · affinage en cours…</p>
            ) : null}
            <div className="suggestion-list">
              {suggestions.map((skill) => {
                const currentFeedback = feedback[suggestionFeedbackKey(projectId, skill.id)]
                return (
                  <div className="suggestion-row" key={skill.id}>
                    <div>
                      <strong>{skill.name}</strong>
                      <span className="suggestion-description">{skill.description}</span>
                      <span className="suggestion-reason">{skill.reason}</span>
                      <span className="suggestion-source">{SKILL_SOURCE_LABELS[skill.provenance]}</span>
                      <code>${skill.invocation}</code>
                    </div>
                    <div className="suggestion-actions">
                      <button
                        type="button"
                      className="suggestion-add"
                        onClick={() => onLaunch(skill)}
                        title="Ajouter l’invocation au message sans lancer le tour."
                      >
                        {SKILL_SUGGESTION_ACTION_LABEL}
                      </button>
                      <div className="suggestion-feedback" aria-label={`Évaluer ${skill.name}`}>
                        <button
                          type="button"
                          className={currentFeedback === 'useful' ? 'is-selected' : undefined}
                          aria-pressed={currentFeedback === 'useful'}
                          onClick={() => handleFeedback(skill.id, 'useful')}
                          title="Marquer cette suggestion comme utile."
                        >
                          Utile
                        </button>
                        <button
                          type="button"
                          className={currentFeedback === 'irrelevant' ? 'is-selected' : undefined}
                          aria-pressed={currentFeedback === 'irrelevant'}
                          onClick={() => handleFeedback(skill.id, 'irrelevant')}
                          title="Marquer cette suggestion comme pas pertinente."
                        >
                          Pas pertinent
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

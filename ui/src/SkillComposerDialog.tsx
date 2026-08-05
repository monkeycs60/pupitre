import { useState } from 'react'
import type { FormEvent } from 'react'
import { composeSkill } from './api'
import type { Project, SkillDetail } from './types'

interface SkillComposerDialogProps {
  project: Project
  onClose: () => void
  onCreated: (skill: SkillDetail) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Impossible de créer le skill.'
}

export function SkillComposerDialog({
  project,
  onClose,
  onCreated,
}: SkillComposerDialogProps) {
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const need = description.trim()
    if (!need || isSubmitting) return
    setIsSubmitting(true)
    setError(null)
    try {
      onCreated(await composeSkill({
        projectId: project.id,
        description: need,
        scope,
      }))
    } catch (submitError: unknown) {
      setError(errorMessage(submitError))
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={onClose}
      onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}
    >
      <section
        className="modal review-dialog skill-composer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-composer-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2 id="skill-composer-title">Nouveau skill</h2>
            <p>Décrivez le besoin ; Codex Sol rédigera le SKILL.md.</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>

        <form className="review-dialog-form skill-composer-form" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            <span>Besoin à automatiser</span>
            <textarea
              autoFocus
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Ex. Quand je colle un ticket client, préparer une réponse sourcée et vérifier le ton…"
              rows={7}
              required
            />
          </label>

          <label>
            <span>Installer dans</span>
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as 'project' | 'global')}
            >
              <option value="project">Ce projet · {project.name}</option>
              <option value="global">Tous les projets · source globale</option>
            </select>
          </label>

          <p className="review-dialog-note">
            Pupitre utilise le skill-creator indexé s’il existe, puis installe le fichier sans
            écraser un nom déjà présent. Scripts, références et assets ne sont pas générés en v1.
          </p>
          {error ? <p className="modal-error" role="alert">{error}</p> : null}

          <footer className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>Annuler</button>
            <button type="submit" className="primary-button" disabled={isSubmitting || !description.trim()}>
              {isSubmitting ? 'Rédaction avec Sol…' : 'Créer le skill'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}

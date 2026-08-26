import { useMemo, useState } from 'react'
import { publishChangelogReview } from './api'
import type { ChangeProposal, ChangelogReview } from './types'

export function ChangelogReviewDialog({ review, onClose, onPublished }: {
  review: ChangelogReview
  onClose: () => void
  onPublished?: () => void
}) {
  const [changes, setChanges] = useState(review.changes)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const certain = useMemo(() => changes.filter((change) => !change.ambiguous), [changes])
  const ambiguous = useMemo(() => changes.filter((change) => change.ambiguous), [changes])
  const domains = useMemo(() => [...new Map(review.changes.map((change) => [change.domainId, change.domainName])).entries()], [review.changes])

  function update(id: string, patch: Partial<ChangeProposal>) {
    setChanges((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  }

  async function publish() {
    setSaving(true)
    setError(null)
    try {
      await publishChangelogReview(review.id, changes)
      onPublished?.()
      onClose()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Publication impossible')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal review-dialog changelog-review" role="dialog" aria-modal="true" aria-labelledby="changelog-review-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2 id="changelog-review-title">Valider les changements</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>
        <div className="changelog-review-body">
          {changes.length === 0 ? <p className="changelog-empty">Aucune modification notable détectée. Associe d’abord un domaine actif si cette session doit enrichir un catalogue.</p> : null}
          {certain.length > 0 ? (
            <section>
              <h3 className="changelog-section-title">Changements proposés</h3>
              {certain.map((change) => <ChangeCard key={change.id} change={change} domains={domains} onChange={update} />)}
            </section>
          ) : null}
          {ambiguous.length > 0 ? (
            <details className="changelog-ambiguous">
              <summary>Attribution incertaine ({ambiguous.length})</summary>
              {ambiguous.map((change) => <ChangeCard key={change.id} change={change} domains={domains} onChange={update} />)}
            </details>
          ) : null}
        </div>
        {error ? <p className="modal-error" role="alert">{error}</p> : null}
        <footer className="modal-actions"><button type="button" onClick={onClose}>Annuler</button><button type="button" className="primary" disabled={saving || changes.every((item) => !item.selected)} onClick={() => void publish()}>{saving ? 'Publication…' : publishLabel(changes.filter((item) => item.selected).length)}</button></footer>
      </section>
    </div>
  )
}

function publishLabel(count: number): string {
  return `Publier ${count} changement${count > 1 ? 's' : ''}`
}

function ChangeCard({ change, domains, onChange }: { change: ChangeProposal; domains: Array<[string, string]>; onChange: (id: string, patch: Partial<ChangeProposal>) => void }) {
  return (
    <article className={`changelog-change ${change.selected ? 'is-selected' : ''}`}>
      <div className="changelog-change-head">
        <span>{change.domainName} · {natureLabel(change.nature)}</span>
        <label className="changelog-check"><input type="checkbox" checked={change.selected} onChange={(event) => onChange(change.id, { selected: event.target.checked })} /><span>Inclure</span></label>
      </div>
      <p className="changelog-change-title">{change.title}</p>
      <details className="changelog-change-edit">
        <summary>Modifier</summary>
        <div className="changelog-change-fields">
          <div className="changelog-change-taxonomy">
            <label><span>Domaine</span><select aria-label="Domaine du changement" value={change.domainId} onChange={(event) => onChange(change.id, { domainId: event.target.value, domainName: domains.find(([id]) => id === event.target.value)?.[1] ?? change.domainName })}>{domains.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
            <label><span>Nature</span><select aria-label="Nature du changement" value={change.nature} onChange={(event) => onChange(change.id, { nature: event.target.value as ChangeProposal['nature'] })}><option value="ajout">Ajout</option><option value="modification">Modification</option><option value="correction">Correction</option><option value="retrait">Retrait</option></select></label>
          </div>
          <label><span>Phrase affichée</span><input aria-label="Titre du changement" value={change.title} onChange={(event) => onChange(change.id, { title: event.target.value })} /></label>
          <label><span>Description détaillée</span><textarea aria-label="Description du changement" value={change.description} onChange={(event) => onChange(change.id, { description: event.target.value })} /></label>
          <label><span>Impact</span><textarea aria-label="Impact du changement" value={change.impact} onChange={(event) => onChange(change.id, { impact: event.target.value })} /></label>
          {change.evidence.length ? <p className="changelog-evidence"><strong>Preuves</strong>{change.evidence.join(' · ')}</p> : null}
        </div>
      </details>
    </article>
  )
}

function natureLabel(nature: ChangeProposal['nature']): string {
  return nature.charAt(0).toUpperCase() + nature.slice(1)
}

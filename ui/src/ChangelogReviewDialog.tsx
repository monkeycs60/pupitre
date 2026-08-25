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
          <div><p className="eyebrow">Mémoire produit</p><h2 id="changelog-review-title">Valider les changements</h2></div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>
        <div className="changelog-review-body">
          {changes.length === 0 ? <p className="changelog-empty">Aucune modification notable détectée. Associe d’abord un domaine actif si cette session doit enrichir un catalogue.</p> : null}
          {certain.length > 0 ? (
            <section>
              <div className="changelog-section-title"><h3>Modifications certaines</h3><button type="button" onClick={() => setChanges((items) => items.map((item) => item.ambiguous ? item : { ...item, selected: true }))}>Tout valider</button></div>
              {certain.map((change, index) => <ChangeCard key={change.id} change={change} domains={domains} onChange={update} onMerge={index === 0 || certain[index - 1]?.domainId !== change.domainId ? undefined : () => setChanges((items) => mergeChanges(items, certain[index - 1]!.id, change.id))} onSplit={() => setChanges((items) => [...items, { ...change, id: crypto.randomUUID(), groupId: crypto.randomUUID(), title: `${change.title} — suite` }])} />)}
            </section>
          ) : null}
          {ambiguous.length > 0 ? (
            <details className="changelog-ambiguous">
              <summary>Attribution incertaine ({ambiguous.length})</summary>
              {ambiguous.map((change, index) => <ChangeCard key={change.id} change={change} domains={domains} onChange={update} onMerge={index === 0 || ambiguous[index - 1]?.domainId !== change.domainId ? undefined : () => setChanges((items) => mergeChanges(items, ambiguous[index - 1]!.id, change.id))} onSplit={() => setChanges((items) => [...items, { ...change, id: crypto.randomUUID(), groupId: crypto.randomUUID(), title: `${change.title} — suite` }])} />)}
            </details>
          ) : null}
        </div>
        {error ? <p className="modal-error" role="alert">{error}</p> : null}
        <footer className="modal-actions"><button type="button" onClick={onClose}>Annuler</button><button type="button" className="primary" disabled={saving || changes.length === 0} onClick={() => void publish()}>{saving ? 'Publication…' : `Publier ${changes.filter((item) => item.selected).length} changement(s)`}</button></footer>
      </section>
    </div>
  )
}

function mergeChanges(changes: ChangeProposal[], previousId: string, currentId: string): ChangeProposal[] {
  const previous = changes.find((change) => change.id === previousId)
  const current = changes.find((change) => change.id === currentId)
  if (!previous || !current) return changes
  const merged = {
    ...previous,
    description: `${previous.description}\n\n${current.title} : ${current.description}`,
    impact: [...new Set([previous.impact, current.impact])].join('\n'),
    evidence: [...new Set([...previous.evidence, ...current.evidence])],
    ambiguous: previous.ambiguous || current.ambiguous,
    selected: previous.selected || current.selected,
  }
  return changes.flatMap((change) => change.id === previousId ? [merged] : change.id === currentId ? [] : [change])
}

function ChangeCard({ change, domains, onChange, onMerge, onSplit }: { change: ChangeProposal; domains: Array<[string, string]>; onChange: (id: string, patch: Partial<ChangeProposal>) => void; onMerge?: () => void; onSplit: () => void }) {
  return (
    <article className={`changelog-change ${change.selected ? 'is-selected' : ''}`}>
      <div className="changelog-change-head"><label className="changelog-check"><input type="checkbox" checked={change.selected} onChange={(event) => onChange(change.id, { selected: event.target.checked })} /><span>Inclure</span></label><select aria-label="Domaine du changement" value={change.domainId} onChange={(event) => onChange(change.id, { domainId: event.target.value, domainName: domains.find(([id]) => id === event.target.value)?.[1] ?? change.domainName })}>{domains.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><select aria-label="Nature du changement" value={change.nature} onChange={(event) => onChange(change.id, { nature: event.target.value as ChangeProposal['nature'] })}><option value="ajout">Ajout</option><option value="modification">Modification</option><option value="correction">Correction</option><option value="retrait">Retrait</option></select><span className="changelog-change-actions">{onMerge ? <button type="button" onClick={onMerge}>Fusionner avec la précédente</button> : null}<button type="button" onClick={onSplit}>Scinder</button></span></div>
      <input aria-label="Titre du changement" value={change.title} onChange={(event) => onChange(change.id, { title: event.target.value })} />
      <textarea aria-label="Description du changement" value={change.description} onChange={(event) => onChange(change.id, { description: event.target.value })} />
      <textarea aria-label="Impact du changement" value={change.impact} onChange={(event) => onChange(change.id, { impact: event.target.value })} />
      {change.evidence.length ? <p className="changelog-evidence">{change.evidence.join(' · ')}</p> : null}
    </article>
  )
}

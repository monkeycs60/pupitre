import { useEffect, useMemo, useState } from 'react'
import { getReview, sendMessage } from './api'
import type { Review, ReviewFlag } from './types'
import type { ReviewReportBlock } from './groupEvents'
import { parseUnifiedDiff } from './reviewDiff'

function severityLabel(severity: ReviewFlag['severity']): string {
  return severity === 'red' ? 'Bloquant' : severity === 'orange' ? 'À corriger' : 'À considérer'
}

function excerpt(review: Review, flag: ReviewFlag): string {
  const lines = parseUnifiedDiff(review.diff_text, [])
  const index = lines.findIndex((line) => line.file === flag.file
    && (line.newLine === flag.line_start || line.oldLine === flag.line_start))
  if (index < 0) return `${flag.file}:${flag.line_start}`
  return lines.slice(Math.max(0, index - 2), index + 3)
    .filter((line) => line.kind !== 'meta')
    .map((line) => `${line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' '} ${line.text}`)
    .join('\n')
}

function correctionPrompt(review: Review, flags: ReviewFlag[]): string {
  return [
    `Corrige les ${flags.length} point${flags.length > 1 ? 's' : ''} sélectionné${flags.length > 1 ? 's' : ''} par le Gardien (relecture ${review.id}).`,
    'Traite-les comme un seul tour de conversation. Vérifie l’état actuel du code avant toute modification, pose-moi une question uniquement si une ambiguïté produit importante empêche une correction sûre, puis teste et committe les corrections.',
    ...flags.map((flag, index) => `${index + 1}. ${flag.file}:${flag.line_start} — ${flag.category}\n${flag.message}`),
  ].join('\n\n')
}

export function ReviewReportCard({ block, conversationId }: { block: ReviewReportBlock, conversationId: string }) {
  const [review, setReview] = useState<Review | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void getReview(block.reviewId, controller.signal).then((value) => {
      setReview(value)
      setSelected(new Set(value.flags.filter((flag) => flag.status === 'open').map((flag) => flag.id)))
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Rapport indisponible')
    })
    return () => controller.abort()
  }, [block.reviewId])

  const chosen = useMemo(() => review?.flags.filter((flag) => selected.has(flag.id)) ?? [], [review, selected])

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function correct() {
    if (!review || chosen.length === 0 || sending) return
    setSending(true)
    setError(null)
    try { await sendMessage(conversationId, { message: correctionPrompt(review, chosen), images: [], attachments: [] }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Impossible de lancer la correction') }
    finally { setSending(false) }
  }

  if (error && !review) return <article className="review-report-card is-error" role="alert">{error}</article>
  if (!review) return <article className="review-report-card is-loading" role="status">Le Gardien prépare son rapport…</article>

  const open = review.flags.filter((flag) => flag.status === 'open')
  return <article className="review-report-card" aria-label="Rapport du Gardien">
    <header className="review-report-header">
      <span className="review-report-shield" aria-hidden="true">◇</span>
      <div><strong>Rapport du Gardien</strong><span>{open.length === 0 ? 'Rien à signaler' : `${open.length} point${open.length > 1 ? 's' : ''} à examiner`}</span></div>
    </header>
    {open.length > 0 ? <div className="review-report-findings">
      {open.map((flag) => <label className={`review-finding severity-${flag.severity}`} key={flag.id}>
        <input type="checkbox" checked={selected.has(flag.id)} onChange={() => toggle(flag.id)} />
        <span className="review-finding-body">
          <span className="review-finding-meta"><b>{severityLabel(flag.severity)}</b><code>{flag.file}:{flag.line_start}</code><span>{flag.category}</span></span>
          <span className="review-finding-message">{flag.message}</span>
          <pre>{excerpt(review, flag)}</pre>
        </span>
      </label>)}
    </div> : <p className="review-report-clean">La relecture complète n’a relevé aucun problème utile. Le code peut continuer sans boucle de correction.</p>}
    {open.length > 0 ? <footer>
      <span>{chosen.length} sélectionné{chosen.length > 1 ? 's' : ''}</span>
      <button type="button" className="primary-button" onClick={() => void correct()} disabled={chosen.length === 0 || sending}>{sending ? 'Lancement…' : 'Corriger la sélection'}</button>
    </footer> : null}
    {error ? <p className="review-report-error" role="alert">{error}</p> : null}
  </article>
}

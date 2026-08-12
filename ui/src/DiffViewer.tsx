import { useEffect, useMemo, useRef, useState } from 'react'
import { SubtaskCard } from './SubtaskCard'
import { dispatchFlag, setReviewFlagStatus, startFlagCounterOpinion } from './api'
import { flagActionDraft, optimisticFlagStatus, parseUnifiedDiff } from './reviewDiff'
import type { DiffLine } from './reviewDiff'
import type { ReviewFlag } from './types'

interface DiffViewerProps {
  diff: string
  flags?: ReviewFlag[]
  label: string
  selectedFlagId?: string | null
  onFlagUpdated?: (flag: ReviewFlag) => void
}

type DiffRow = { type: 'file'; file: string } | { type: 'line'; line: DiffLine }
const HIDDEN_META_PREFIXES = ['diff --git ', 'index ', '--- ', '+++ ']

function toRows(lines: DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = []
  let announcedFile: string | null = null
  for (const line of lines) {
    if (line.kind === 'meta') {
      if (line.text === '') continue
      const header = line.text.match(/^diff --git a\/.+ b\/(.+)$/)
      if (header) { rows.push({ type: 'file', file: header[1] }); announcedFile = header[1]; continue }
      if (HIDDEN_META_PREFIXES.some((prefix) => line.text.startsWith(prefix))) continue
    } else if (line.file !== null && line.file !== announcedFile) {
      rows.push({ type: 'file', file: line.file }); announcedFile = line.file
    }
    rows.push({ type: 'line', line })
  }
  return rows
}

function severityLabel(flag: ReviewFlag): string {
  return flag.severity === 'red' ? 'Rouge' : flag.severity === 'orange' ? 'Orange' : 'Gris'
}

function FlagCard({ flag, onUpdated }: { flag: ReviewFlag, onUpdated?: (flag: ReviewFlag) => void }) {
  const [message, setMessage] = useState(() => flagActionDraft(flag))
  const [isDispatching, setIsDispatching] = useState(false)
  const [isCountering, setIsCountering] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function setStatus(status: 'treated' | 'ignored') {
    setError(null)
    const optimistic = optimisticFlagStatus(flag, status)
    onUpdated?.(optimistic)
    try { onUpdated?.(await setReviewFlagStatus(flag.id, status)) }
    catch (reason) { onUpdated?.(flag); setError(reason instanceof Error ? reason.message : 'Mise à jour impossible.') }
  }

  async function sendAgent() {
    setIsDispatching(true); setError(null)
    try {
      const result = await dispatchFlag(flag.id, message)
      onUpdated?.({ ...flag, status: 'agent_running', subtask_id: result.subtaskId, user_message: message })
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Envoi de l’agent impossible.') }
    finally { setIsDispatching(false) }
  }

  async function requestCounterOpinion() {
    setIsCountering(true); setError(null)
    try {
      const updated = await startFlagCounterOpinion(flag.id, 'gpt-5.6-sol', 'high', flag.code_provider)
      const current = updated.find((item) => item.id === flag.id)
      if (current) onUpdated?.(current)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Contre-avis impossible.') }
    finally { setIsCountering(false) }
  }

  return <article className={`diff-flag-card severity-${flag.severity}`} aria-label={`Signalement ${severityLabel(flag)}`}>
    <header><span className="diff-severity">{severityLabel(flag)}</span><span>{flag.file}:{flag.line_start}</span></header>
    <p>{flag.message}</p>
    {flag.test_gap ? <span className="diff-test-gap">Manque de test</span> : null}
    {flag.counter_text ? <div className="diff-counter-opinion"><strong>Contre-avis</strong><p>{flag.counter_text}</p></div> : null}
    {flag.status === 'agent_running' ? <p className="diff-flag-state" role="status">Agent en cours…</p> : null}
    {flag.subtask_id ? <SubtaskCard block={{ kind: 'subtask', id: flag.subtask_id, subtaskId: flag.subtask_id, provider: flag.code_provider, model: 'Agent', label: `Gardien · ${flag.file}:${flag.line_start}` }} onImageOpen={() => {}} onImageLoad={() => {}} /> : null}
    {flag.status === 'resolved' ? <p className="diff-flag-state">✓ Résolu par rescan</p> : null}
    {(flag.status === 'open' || flag.status === 'countered') ? <>
      <label className="diff-agent-message"><span>Consigne pour l’agent</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} /></label>
      <div className="diff-flag-actions">
        <button type="button" className="primary-button" onClick={() => void sendAgent()} disabled={isDispatching}>{isDispatching ? 'Envoi…' : 'Envoyer un agent'}</button>
        <button type="button" className="secondary-button" onClick={() => void requestCounterOpinion()} disabled={isCountering}>{isCountering ? 'Demande…' : 'Contre-avis'}</button>
        <button type="button" onClick={() => void setStatus('treated')}>OK, vu</button>
        <button type="button" onClick={() => void setStatus('ignored')}>Ignorer</button>
      </div>
    </> : null}
    {error ? <p className="diff-flag-error" role="alert">{error}</p> : null}
  </article>
}

export function DiffViewer({ diff, flags = [], label, selectedFlagId, onFlagUpdated }: DiffViewerProps) {
  const [expandedFlagId, setExpandedFlagId] = useState<string | null>(selectedFlagId ?? null)
  const selectedRef = useRef<HTMLDivElement | null>(null)
  const rows = useMemo(() => toRows(parseUnifiedDiff(diff, flags)), [diff, flags])
  const activeFlagId = selectedFlagId ?? expandedFlagId

  useEffect(() => {
    if (selectedFlagId !== null && selectedRef.current !== null) {
      selectedRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [selectedFlagId])

  return <div className="diff-table" role="table" aria-label={label}>
    {rows.map((row, index) => row.type === 'file' ? <div className="diff-file-header" role="row" key={`${index}-${row.file}`}><span role="cell">{row.file}</span></div> : <div key={`${index}-${row.line.text}`}>
      <div className={`diff-line is-${row.line.kind} ${row.line.severity ? `risk-${row.line.severity}` : ''}`} role="row" onClick={() => { if (row.line.flags[0]) setExpandedFlagId(row.line.flags[0].id) }}>
        <span className="diff-number" role="cell">{row.line.oldLine ?? ''}</span><span className="diff-number" role="cell">{row.line.newLine ?? ''}</span><code role="cell">{row.line.text || ' '}</code>
        <span className="diff-flags" role="cell">{row.line.flags.map((flag) => <button type="button" key={flag.id} className={`diff-flag-marker severity-${flag.severity}`} onClick={(event) => { event.stopPropagation(); setExpandedFlagId(activeFlagId === flag.id ? null : flag.id) }} aria-expanded={activeFlagId === flag.id}>{activeFlagId === flag.id ? flag.message : flag.category}</button>)}</span>
      </div>
      {row.line.cardFlags.filter((flag) => flag.id === activeFlagId).map((flag) => <div className="diff-flag-card-row" key={`card-${flag.id}`} ref={selectedFlagId === flag.id ? selectedRef : undefined}><FlagCard flag={flag} onUpdated={onFlagUpdated} /></div>)}
    </div>)}
  </div>
}

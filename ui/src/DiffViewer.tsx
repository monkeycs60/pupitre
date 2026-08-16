import { useEffect, useMemo, useRef, useState } from 'react'
import { SubtaskCard } from './SubtaskCard'
import { dispatchFlag, setReviewFlagStatus } from './api'
import { optimisticFlagStatus, parseUnifiedDiff } from './reviewDiff'
import type { DiffLine } from './reviewDiff'
import type { ReviewFlag } from './types'
import { modelLabel } from './modelOptions'

interface DiffViewerProps {
  diff: string
  flags?: ReviewFlag[]
  label: string
  selectedFlagId?: string | null
  onFlagUpdated?: (flag: ReviewFlag) => void
}

type DiffRow = { type: 'file'; file: string } | { type: 'line'; line: DiffLine }
const HIDDEN_META_PREFIXES = ['diff --git ', 'index ', '--- ', '+++ ']
const OPEN_STATUSES = new Set<ReviewFlag['status']>(['open', 'agent_running'])
const CLOSED_LABELS: Partial<Record<ReviewFlag['status'], string>> = {
  treated: 'traité',
  ignored: 'ignoré',
  resolved: 'résolu par relecture',
}

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
  return flag.severity === 'red' ? 'ROUGE' : flag.severity === 'orange' ? 'ORANGE' : 'GRIS'
}

function findingLabel(flag: ReviewFlag): string {
  return `${flag.message} · ${severityLabel(flag).toLowerCase()}`
}

function closedSummary(flag: ReviewFlag): string {
  const label = CLOSED_LABELS[flag.status] ?? flag.status
  const message = flag.message.length > 90 ? `${flag.message.slice(0, 90)}…` : flag.message
  return `✓ ${label} · ${message}`
}

function FlagCard({ flag, onUpdated }: { flag: ReviewFlag, onUpdated?: (flag: ReviewFlag) => void }) {
  const [message, setMessage] = useState(() => flag.user_message ?? '')
  const [agentNoteOpen, setAgentNoteOpen] = useState(() => Boolean(flag.user_message))
  const [isDispatching, setIsDispatching] = useState(false)
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
      const result = await dispatchFlag(flag.id, message.trim() || undefined)
      onUpdated?.({ ...flag, status: 'agent_running', subtask_id: result.subtaskId, user_message: message || null })
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Envoi de l’agent impossible.') }
    finally { setIsDispatching(false) }
  }

  return <article className={`diff-flag-card severity-${flag.severity}`} aria-label={`Signalement ${severityLabel(flag)}`}>
    <header>
      <span className="diff-severity"><i />{severityLabel(flag)}</span>
      <span className="diff-theme">{flag.category || 'signalement'}</span>
      <span className="diff-flag-meta">ligne {flag.line_start} · {modelLabel(flag.code_provider)}</span>
    </header>
    <p className="diff-flag-message">{flag.message}</p>
    {flag.test_gap ? <span className="diff-test-gap">Manque de test</span> : null}
    {flag.status === 'agent_running' ? <p className="diff-flag-state" role="status">Correction en cours…</p> : null}
    {flag.subtask_id ? <SubtaskCard block={{ kind: 'subtask', id: flag.subtask_id, subtaskId: flag.subtask_id, provider: flag.code_provider, model: '', label: `Correction · ${flag.category} · ${flag.file}:${flag.line_start}` }} onImageOpen={() => {}} onImageLoad={() => {}} /> : null}
    {flag.status === 'resolved' ? <p className="diff-flag-state">✓ Résolu par rescan</p> : null}
    {flag.status === 'open' ? <>
      {agentNoteOpen ? <label className="diff-agent-message"><span>Consigne pour l’agent</span><textarea rows={2} value={message} onChange={(event) => setMessage(event.target.value)} /></label> : null}
      <div className="diff-flag-actions">
        <button type="button" className="primary-button" onClick={() => void sendAgent()} disabled={isDispatching}>{isDispatching ? 'Envoi…' : 'Corriger'}</button>
        <button type="button" className="secondary-button" onClick={() => void setStatus('treated')}>OK, vu</button>
        <span className="diff-flag-actions-spacer" />
        <button type="button" className="diff-agent-note-toggle" onClick={() => setAgentNoteOpen((current) => !current)}>{agentNoteOpen ? 'Masquer la consigne' : '+ Consigne pour l’agent'}</button>
        <button type="button" className="diff-quiet-action" onClick={() => void setStatus('ignored')}>Ignorer</button>
      </div>
    </> : null}
    {error ? <p className="diff-flag-error" role="alert">{error}</p> : null}
  </article>
}

export function DiffViewer({ diff, flags = [], label, selectedFlagId, onFlagUpdated }: DiffViewerProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const selectedRef = useRef<HTMLDivElement | null>(null)
  const rows = useMemo(() => toRows(parseUnifiedDiff(diff, flags)), [diff, flags])

  useEffect(() => {
    if (selectedFlagId !== null && selectedRef.current !== null) {
      selectedRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [selectedFlagId])

  function toggleFold(flag: ReviewFlag) {
    const target = OPEN_STATUSES.has(flag.status) ? setCollapsed : setExpanded
    target((current) => {
      const next = new Set(current)
      if (next.has(flag.id)) next.delete(flag.id); else next.add(flag.id)
      return next
    })
  }

  function isCardVisible(flag: ReviewFlag): boolean {
    if (flag.id === selectedFlagId) return true
    if (OPEN_STATUSES.has(flag.status)) return !collapsed.has(flag.id)
    return expanded.has(flag.id)
  }

  return <div className="diff-table" role="table" aria-label={label}>
    {rows.map((row, index) => row.type === 'file' ? <div className="diff-file-header" role="row" key={`${index}-${row.file}`}><span role="cell">{row.file}</span></div> : <div key={`${index}-${row.line.text}`}>
      <div className={`diff-line is-${row.line.kind} ${row.line.severity ? `risk-${row.line.severity}` : ''}`} role="row" onClick={() => { const flag = row.line.cardFlags[0] ?? row.line.flags[0]; if (flag) toggleFold(flag) }}>
        <span className="diff-number" role="cell">{row.line.newLine ?? row.line.oldLine ?? ''}</span>
        <span className={`diff-rail${row.line.severity ? ` risk-${row.line.severity}` : ''}`} title={row.line.flags.length > 0 ? `${row.line.flags.length} signalement${row.line.flags.length > 1 ? 's' : ''}` : undefined} aria-label={row.line.flags.length > 0 ? findingLabel(row.line.flags[0]!) : undefined} />
        <span className={`diff-sign is-${row.line.kind}`} role="cell">{row.line.kind === 'addition' ? '+' : row.line.kind === 'deletion' ? '−' : ''}</span>
        <code role="cell">{row.line.text || ' '}</code>
      </div>
      {row.line.cardFlags.map((flag) => <div className={`diff-flag-card-row severity-${flag.severity}`} key={`card-${flag.id}`} ref={selectedFlagId === flag.id ? selectedRef : undefined}>
        <span className={`diff-card-rail risk-${flag.severity}`} aria-hidden="true" />
        <div className="diff-flag-card-content">{isCardVisible(flag)
          ? <FlagCard flag={flag} onUpdated={onFlagUpdated} />
          : <button type="button" className="diff-flag-closed" onClick={() => toggleFold(flag)}>{closedSummary(flag)}</button>}</div>
      </div>)}
    </div>)}
  </div>
}

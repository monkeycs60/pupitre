import { useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { closeConversationNudge, sendMessage } from './api'
import type { ConversationNudge } from './types'
import { SNOOZE_MINUTES, type ConversationNudges } from './useConversationNudges'

const DECK_LAYERS = 4
const SWIPE_DISTANCE = 110
const LEAVE_MS = 260

type CardState = { phase: 'idle' } | { phase: 'sending'; index: number } | { phase: 'sent'; label: string } | { phase: 'error'; message: string }
type Direction = 'left' | 'right'

export function NudgeStack({ nudges, hiddenConversationId, onOpen }: {
  nudges: ConversationNudges
  hiddenConversationId?: string | null
  onOpen: (projectId: string, conversationId: string) => void
}) {
  const [states, setStates] = useState<Record<string, CardState>>({})
  const [leaving, setLeaving] = useState<{ id: string; direction: Direction } | null>(null)
  const [drag, setDrag] = useState(0)
  const dragStart = useRef<number | null>(null)

  const visible = nudges.items.filter((nudge) => nudge.parked === null && nudge.conversation_id !== hiddenConversationId)
  const top = visible[0]
  if (!top) return null

  function leave(nudge: ConversationNudge, direction: Direction, then: () => void) {
    setLeaving({ id: nudge.id, direction })
    window.setTimeout(() => {
      then()
      setLeaving(null)
      setDrag(0)
    }, LEAVE_MS)
  }

  const open = (nudge: ConversationNudge) => leave(nudge, 'right', () => {
    onOpen(nudge.project_id, nudge.conversation_id)
    void nudges.dismiss(nudge.id)
  })
  const later = (nudge: ConversationNudge) => leave(nudge, 'left', () => void nudges.snooze(nudge.id))
  const dismiss = (nudge: ConversationNudge) => leave(nudge, 'left', () => void nudges.dismiss(nudge.id))

  async function act(nudge: ConversationNudge, index: number) {
    const action = nudge.actions[index]
    if (!action) return
    setStates((current) => ({ ...current, [nudge.id]: { phase: 'sending', index } }))
    try {
      await sendMessage(nudge.conversation_id, { message: action.message })
      await closeConversationNudge(nudge.id).catch(() => {})
      setStates((current) => ({ ...current, [nudge.id]: { phase: 'sent', label: action.label } }))
      window.setTimeout(() => leave(nudge, 'right', () => nudges.remove(nudge.id)), 700)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Envoi impossible'
      setStates((current) => ({ ...current, [nudge.id]: { phase: 'error', message } }))
    }
  }

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    if (leaving || (event.target as HTMLElement).closest('button')) return
    dragStart.current = event.clientX
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    if (dragStart.current !== null) setDrag(event.clientX - dragStart.current)
  }

  function onPointerUp() {
    if (dragStart.current === null) return
    dragStart.current = null
    if (drag <= -SWIPE_DISTANCE) later(top!)
    else if (drag >= SWIPE_DISTANCE) open(top!)
    else setDrag(0)
  }

  const state = states[top.id] ?? { phase: 'idle' }
  const busy = state.phase === 'sending' || state.phase === 'sent' || leaving !== null
  const layers = Math.min(visible.length - 1, DECK_LAYERS)
  const dragging = dragStart.current !== null
  const hint = drag <= -SWIPE_DISTANCE / 2 ? 'later' : drag >= SWIPE_DISTANCE / 2 ? 'open' : null

  return (
    <section className="nudge-deck" aria-label="Conversations qui attendent" style={{ '--deck-layers': layers } as CSSProperties}>
      {Array.from({ length: layers }, (_, index) => (
        <span key={index} className="nudge-layer" style={{ '--layer': index + 1 } as CSSProperties} aria-hidden="true" />
      ))}
      <article
        key={top.id}
        className={`nudge is-${top.kind}${leaving ? ` is-leaving-${leaving.direction}` : ''}${dragging ? ' is-dragging' : ''}`}
        data-id={top.id}
        style={drag && !leaving ? { transform: `translateX(${drag}px) rotate(${drag / 18}deg)` } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {hint ? <span className={`nudge-hint is-${hint}`} aria-hidden="true">{hint === 'later' ? 'Plus tard' : 'Ouvrir'}</span> : null}
        <header className="nudge-head">
          <button type="button" className="nudge-source" title="Ouvrir la conversation" disabled={busy} onClick={() => open(top)}>
            <span className="nudge-dot" aria-hidden="true" />
            <span>{top.project_name} · {top.conversation_title}</span>
          </button>
          {visible.length > 1 ? <span className="nudge-count" title={`${visible.length} décisions en attente`}>{visible.length}</span> : null}
          <button type="button" className="nudge-close" aria-label="Ignorer" title="Ignorer" disabled={busy} onClick={() => dismiss(top)}>×</button>
        </header>
        <strong className="nudge-title">{top.title}</strong>
        {top.body ? <p className="nudge-body">{top.body}</p> : null}
        {state.phase === 'sent' ? (
          <p className="nudge-feedback is-ok">Envoyé : {state.label}</p>
        ) : (
          <div className="nudge-actions">
            {top.actions.map((action, index) => (
              <button
                key={action.label}
                type="button"
                className={`nudge-action${index === 0 ? ' is-primary' : ''}`}
                title={action.message}
                disabled={busy}
                onClick={() => void act(top, index)}
              >
                {state.phase === 'sending' && state.index === index ? 'Envoi…' : action.label}
              </button>
            ))}
            <button type="button" className="nudge-action is-ghost" disabled={busy} onClick={() => open(top)}>Ouvrir</button>
            <button
              type="button"
              className="nudge-action is-ghost"
              disabled={busy}
              title={`La carte revient dans ${SNOOZE_MINUTES} minutes`}
              onClick={() => later(top)}
            >
              Dans {SNOOZE_MINUTES} min
            </button>
          </div>
        )}
        {state.phase === 'error' ? <p className="nudge-feedback is-danger">{state.message}</p> : null}
      </article>
    </section>
  )
}

import { useState } from 'react'
import { closeConversationNudge, sendMessage } from './api'
import type { ConversationNudge } from './types'
import { SNOOZE_MINUTES, type ConversationNudges } from './useConversationNudges'

const VISIBLE_LIMIT = 3

type CardState = { phase: 'idle' } | { phase: 'sending'; index: number } | { phase: 'sent'; label: string } | { phase: 'error'; message: string }

export function NudgeStack({ nudges, hiddenConversationId, onOpen }: {
  nudges: ConversationNudges
  hiddenConversationId?: string | null
  onOpen: (projectId: string, conversationId: string) => void
}) {
  const [states, setStates] = useState<Record<string, CardState>>({})
  const close = (nudge: ConversationNudge) => nudges.dismiss(nudge.id)

  async function act(nudge: ConversationNudge, index: number) {
    const action = nudge.actions[index]
    if (!action) return
    setStates((current) => ({ ...current, [nudge.id]: { phase: 'sending', index } }))
    try {
      await sendMessage(nudge.conversation_id, { message: action.message })
      await closeConversationNudge(nudge.id).catch(() => {})
      setStates((current) => ({ ...current, [nudge.id]: { phase: 'sent', label: action.label } }))
      window.setTimeout(() => nudges.remove(nudge.id), 1_600)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Envoi impossible'
      setStates((current) => ({ ...current, [nudge.id]: { phase: 'error', message } }))
    }
  }

  const visible = nudges.items.filter((nudge) => nudge.parked === null && nudge.conversation_id !== hiddenConversationId)
  if (visible.length === 0) return null
  const hidden = visible.length - VISIBLE_LIMIT

  return (
    <section className="nudge-stack" aria-label="Conversations qui attendent">
      {visible.slice(0, VISIBLE_LIMIT).map((nudge) => {
        const state = states[nudge.id] ?? { phase: 'idle' }
        const busy = state.phase === 'sending' || state.phase === 'sent'
        return (
          <article key={nudge.id} className={`nudge is-${nudge.kind}`} data-id={nudge.id}>
            <header className="nudge-head">
              <button
                type="button"
                className="nudge-source"
                title="Ouvrir la conversation"
                onClick={() => { onOpen(nudge.project_id, nudge.conversation_id); void close(nudge) }}
              >
                <span className="nudge-dot" aria-hidden="true" />
                <span>{nudge.project_name} · {nudge.conversation_title}</span>
              </button>
              <button type="button" className="nudge-close" aria-label="Ignorer" title="Ignorer (reste dans l’île de l’en-tête)" onClick={() => void close(nudge)}>×</button>
            </header>
            <strong className="nudge-title">{nudge.title}</strong>
            {nudge.body ? <p className="nudge-body">{nudge.body}</p> : null}
            {state.phase === 'sent' ? (
              <p className="nudge-feedback is-ok">Envoyé : {state.label}</p>
            ) : (
              <div className="nudge-actions">
                {nudge.actions.map((action, index) => (
                  <button
                    key={action.label}
                    type="button"
                    className={`nudge-action${index === 0 ? ' is-primary' : ''}`}
                    title={action.message}
                    disabled={busy}
                    onClick={() => void act(nudge, index)}
                  >
                    {state.phase === 'sending' && state.index === index ? 'Envoi…' : action.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="nudge-action is-ghost"
                  disabled={busy}
                  onClick={() => { onOpen(nudge.project_id, nudge.conversation_id); void close(nudge) }}
                >
                  Ouvrir
                </button>
                <button
                  type="button"
                  className="nudge-action is-ghost"
                  disabled={busy}
                  title={`La carte revient dans ${SNOOZE_MINUTES} minutes`}
                  onClick={() => void nudges.snooze(nudge.id)}
                >
                  Dans {SNOOZE_MINUTES} min
                </button>
              </div>
            )}
            {state.phase === 'error' ? <p className="nudge-feedback is-danger">{state.message}</p> : null}
          </article>
        )
      })}
      {hidden > 0 ? <p className="nudge-more">+{hidden} autre{hidden > 1 ? 's' : ''} en attente</p> : null}
    </section>
  )
}

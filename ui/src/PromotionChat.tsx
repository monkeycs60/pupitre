import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { sendMessage } from './api'
import { EventStream } from './EventStream'
import { useConversationEvents } from './useConversationEvents'
import { useGroupedEvents } from './useGroupedEvents'
import type { PromotionMission } from './types'

const STATE_LABELS: Record<PromotionMission['state'], string> = {
  running: 'Luna travaille',
  waiting_user: 'Luna attend ta réponse',
  succeeded: 'Version promue et vérifiée',
  failed: 'Tour interrompu',
}

export function PromotionChat({
  mission,
  onMissionChange,
  onError,
}: {
  mission: PromotionMission
  onMissionChange: (mission: PromotionMission) => void
  onError: (message: string) => void
}) {
  const { events, connection } = useConversationEvents(mission.conversationId)
  const blocks = useGroupedEvents(mission.conversationId, events)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = viewport.current
    if (node) node.scrollTop = node.scrollHeight
  }, [events])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const text = message.trim()
    if (!text || sending || mission.state === 'running' || mission.state === 'succeeded') return
    setSending(true)
    onError('')
    try {
      await sendMessage(mission.conversationId, { message: text, images: [], attachments: [] })
      setMessage('')
      onMissionChange({ ...mission, state: 'running', finishedAt: null })
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Impossible de répondre à Luna.')
    } finally {
      setSending(false)
    }
  }

  function openConversation() {
    window.dispatchEvent(new CustomEvent('pupitre:open-conversation', {
      detail: { conversationId: mission.conversationId },
    }))
  }

  return (
    <div className="promotion-chat">
      <header className={`promotion-chat-status is-${mission.state}`}>
        <div>
          <strong>{STATE_LABELS[mission.state]}</strong>
          <span>{connection === 'open' ? 'Conversation en direct' : 'Reconnexion au fil…'}</span>
        </div>
        <button type="button" className="text-button" onClick={openConversation}>Ouvrir dans Conversations</button>
      </header>
      <div className="promotion-chat-events" ref={viewport} aria-live="polite">
        <EventStream
          blocks={blocks}
          conversationId={mission.conversationId}
          onImageOpen={() => {}}
          onImageLoad={() => {}}
        />
      </div>
      {mission.state !== 'succeeded' ? (
        <form className="promotion-chat-composer" onSubmit={(event) => void submit(event)}>
          <textarea
            aria-label="Répondre à Luna"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={mission.state === 'running' ? 'Luna travaille…' : 'Répondre à Luna…'}
            disabled={mission.state === 'running' || sending}
            rows={3}
          />
          <button type="submit" className="primary-button" disabled={!message.trim() || mission.state === 'running' || sending}>
            {sending ? 'Envoi…' : 'Envoyer'}
          </button>
        </form>
      ) : null}
    </div>
  )
}

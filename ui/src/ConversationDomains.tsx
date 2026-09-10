import { useEffect, useRef, useState } from 'react'
import {
  associateConversationDomain,
  dissociateConversationDomain,
  listProjectDomains,
} from './api'
import type { Conversation, ProjectDomain } from './types'

interface ConversationDomainsProps {
  conversation: Conversation
  onChange: (conversation: Conversation) => void
}

export function ConversationDomains({ conversation, onChange }: ConversationDomainsProps) {
  const [domains, setDomains] = useState<ProjectDomain[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    void listProjectDomains(conversation.project_id, controller.signal)
      .then((items) => setDomains(items.filter((domain) => domain.status === 'actif')))
      .catch(() => {})
    return () => controller.abort()
  }, [conversation.project_id])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  async function toggle(domain: ProjectDomain) {
    const attached = (conversation.domains ?? []).some((item) => item.id === domain.id)
    setError(null)
    try {
      const updated = attached
        ? await dissociateConversationDomain(conversation.id, domain.id)
        : await associateConversationDomain(conversation.id, domain.id)
      onChange(updated)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Modification impossible')
    }
  }

  if (domains.length === 0 && (conversation.domains ?? []).length === 0) return null

  return (
    <div className="conversation-domains" ref={rootRef}>
      <div className="conversation-domain-badges" aria-label="Domaines de la conversation">
        {(conversation.domains ?? []).map((domain) => (
          <button
            key={domain.id}
            type="button"
            className={`conversation-domain-badge is-${domain.kind === 'métier' ? 'metier' : 'technique'}`}
            onClick={() => setOpen((current) => !current)}
            title="Modifier les domaines"
          >
            {domain.name}
          </button>
        ))}
        <button
          type="button"
          className="conversation-domain-add"
          aria-label="Modifier les domaines"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {(conversation.domains ?? []).length === 0 ? '+ Domaine' : '+'}
        </button>
      </div>
      {open ? (
        <div className="conversation-domain-picker" role="menu" aria-label="Choisir les domaines">
          {domains.map((domain) => {
            const attached = (conversation.domains ?? []).some((item) => item.id === domain.id)
            return (
              <button
                key={domain.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={attached}
                onClick={() => void toggle(domain)}
              >
                <span aria-hidden="true">{attached ? '✓' : ''}</span>
                {domain.name}
              </button>
            )
          })}
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

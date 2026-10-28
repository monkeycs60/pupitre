import { useEffect, useRef, useState, type ReactNode } from 'react'
import { track } from './analytics'
import type { ThreadTools } from './Chat'
import { branchOfWorktree } from './conversationBranch'
import { ConversationInstruction } from './ConversationInstruction'
import { Icon } from './Icon'
import { modelLabel } from './modelOptions'
import { OpenInEditorButton } from './OpenInEditorButton'
import { applicationsForConversation, PortChip } from './PortChip'
import { ProviderMark } from './ProviderMark'
import { useRunningApplications } from './runningApplicationsStore'
import { ticketTitleWithoutKey } from './Sidebar'
import { SentryLinkIcon, TicketLinkIcons } from './TicketLinkIcons'
import type { TicketLinks } from './ticketLinks'
import type { Conversation, Project } from './types'

interface ConversationHeaderProps {
  project: Project
  conversation: Conversation | null
  /** Contexte d'une conversation pas encore créée (« Pour le ticket … »). */
  pendingContext?: ReactNode
  ticketLinks: Map<string, TicketLinks>
  sentryLinks: Map<string, string>
  threadTools: ThreadTools | null
  onOpenAppearance: () => void
}

export function ConversationHeader({
  project,
  conversation,
  pendingContext,
  ticketLinks,
  sentryLinks,
  threadTools,
  onOpenAppearance,
}: ConversationHeaderProps) {
  const applications = useRunningApplications(15_000).items
  const ticketKey = conversation?.ticket_key ?? null
  const links = conversation === null
    ? undefined
    : (ticketKey !== null ? ticketLinks.get(ticketKey) : undefined)
      ?? (conversation.ticket_id !== null ? ticketLinks.get(conversation.ticket_id) : undefined)
  const shownTicketKey = ticketKey ?? links?.ticketKey ?? null
  const ticketTitle = shownTicketKey && links?.title ? ticketTitleWithoutKey(links.title, shownTicketKey) : null
  const sentryKey = conversation?.origin_type === 'sentry' ? conversation.origin_key ?? null : null
  const sentryUrl = sentryKey !== null ? sentryLinks.get(sentryKey) : undefined
  const branch = conversation ? branchOfWorktree(conversation.worktree_path) : null
  const extraWorktrees = (conversation?.worktree_paths?.length ?? 0) > 1 ? conversation!.worktree_paths!.length - 1 : 0
  const ports = conversation ? applicationsForConversation(applications, conversation) : []

  return (
    <header className="conversation-header">
      <div className="conversation-title-block">
        <h1>{conversation?.title ?? 'Nouvelle conversation'}</h1>
        <div className="conversation-meta">
          {pendingContext}
          {shownTicketKey && links ? (
            <span className="conversation-meta-ticket">
              <TicketLinkIcons links={links} ticketKey={shownTicketKey} />
              <strong>{shownTicketKey}</strong>
              {ticketTitle ? <span className="conversation-meta-ticket-title" title={ticketTitle}>{ticketTitle}</span> : null}
            </span>
          ) : null}
          {sentryKey !== null && sentryUrl !== undefined ? (
            <span className="conversation-meta-ticket">
              <SentryLinkIcon url={sentryUrl} issueKey={sentryKey} />
              <strong>{sentryKey}</strong>
            </span>
          ) : null}
          {branch !== null ? (
            <span
              className="conversation-meta-item"
              title={`Worktrees dédiés : ${(conversation!.worktree_paths?.length ? conversation!.worktree_paths : [conversation!.worktree_path]).join(', ')}`}
            >
              <Icon name="branch" size={13} />
              {branch}
              {extraWorktrees > 0 ? ` +${extraWorktrees}` : ''}
            </span>
          ) : null}
          {ports.map((application) => (
            <PortChip key={application.port} application={application} projectName={project.name} />
          ))}
          {conversation ? (
            <span className="conversation-meta-item">
              <ProviderMark provider={conversation.provider} className="conversation-meta-mark" />
              {modelLabel(conversation.model)}
            </span>
          ) : null}
        </div>
        {conversation?.ticket_instruction ? <ConversationInstruction instruction={conversation.ticket_instruction} /> : null}
      </div>
      <div className="header-actions">
        {conversation !== null ? <OpenInEditorButton conversationId={conversation.id} /> : null}
        {threadTools !== null ? <ConversationMenu threadTools={threadTools} onOpenAppearance={onOpenAppearance} /> : null}
      </div>
    </header>
  )
}

function ConversationMenu({ threadTools, onOpenAppearance }: { threadTools: ThreadTools; onOpenAppearance: () => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handlePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  function run(action: () => void) {
    setOpen(false)
    action()
  }

  return (
    <div className="conversation-menu" ref={rootRef}>
      <button
        type="button"
        className="header-icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Actions de la conversation"
        title="Rechercher dans le fil, pièces jointes, affichage"
        onClick={() => {
          if (!open) track('header.menu')
          setOpen((current) => !current)
        }}
      >
        <Icon name="more" />
      </button>
      {open ? (
        <div className="conversation-menu-list" role="menu">
          <button type="button" role="menuitem" onClick={() => { track('thread.search'); run(threadTools.openSearch) }}>
            <Icon name="search" size={15} />
            <span>Rechercher dans le fil</span>
            <kbd>Ctrl F</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={threadTools.assetCount === 0}
            onClick={() => { track('thread.attachments'); run(threadTools.openAssets) }}
          >
            <Icon name="attachment" size={15} />
            <span>Pièces jointes</span>
            <kbd>{threadTools.assetCount}</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => run(onOpenAppearance)}>
            <Icon name="text" size={15} />
            <span>Taille du texte</span>
            <kbd>Ctrl + / −</kbd>
          </button>
        </div>
      ) : null}
    </div>
  )
}

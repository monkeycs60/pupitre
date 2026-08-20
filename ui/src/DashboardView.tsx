import { Fragment, useMemo, useState } from 'react'
import { BranchIcon } from './BranchIcon'
import { createTicketNote, listTicketNotes, refreshProjectDashboard } from './api'
import type {
  DashboardIntegration,
  Project,
  ReviewRequest,
  TicketConversationSummary,
  TicketNote,
  TicketRef,
  TicketRow,
} from './types'
import { useDashboard } from './useDashboard'

interface DashboardViewProps {
  project: Project
  onConversationSelect: (conversationId: string) => void
  onStartConversation: (seed: { ticketId: string; branch: string | null; ticketKey: string }) => void
  onOpenSettings?: () => void
}

const INTEGRATION_LABEL: Record<string, string> = {
  clickup: 'ClickUp',
  gitlab: 'GitLab',
  github: 'GitHub',
  notion: 'Notion',
  sentry: 'Sentry',
}

function refOf(ticket: TicketRow, kind: TicketRef['kind']): TicketRef | undefined {
  return ticket.refs.find((ref) => ref.kind === kind)
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function pipelineTone(status: string | null): string {
  if (status === null) return ''
  if (status === 'success') return 'is-ok'
  if (status === 'failed' || status === 'canceled') return 'is-danger'
  if (status === 'running' || status === 'manual' || status === 'pending') return 'is-warn'
  return ''
}

function relative(value: string | null | undefined): string {
  if (!value) return '—'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return '—'
  const deltaMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (deltaMinutes < 60) return `${deltaMinutes} min`
  const deltaHours = Math.round(deltaMinutes / 60)
  if (deltaHours < 48) return `${deltaHours} h`
  return `${Math.round(deltaHours / 24)} j`
}

function deploymentLabel(ref: TicketRef | undefined): string {
  if (!ref) return '—'
  const environment = textValue(ref.payload.environment)
  const user = textValue(ref.payload.user)
  if (environment && user) return `${environment} · ${user}`
  return environment ?? user ?? ref.ref
}

function mrLabel(ref: TicketRef | undefined): string {
  if (!ref) return '—'
  const mergeStatus = textValue(ref.payload.mergeStatus)
  const state = textValue(ref.payload.state)
  return mergeStatus ?? state ?? ref.ref
}

function pipelineStatus(ref: TicketRef | undefined): string | null {
  if (!ref) return null
  const status = textValue(ref.payload.status)
  return status ?? ref.ref
}

function reviewLabel(review: ReviewRequest): string {
  return `${review.project}!${review.iid}`
}

function conversationSummary(conversation: TicketConversationSummary): string {
  const branch = conversation.worktree_path?.split(/[\\/]/).pop() ?? null
  return branch ? `${conversation.provider} · ${branch}` : conversation.provider
}

function bannerTone(integration: DashboardIntegration): string {
  if (integration.status === 'ok') return ''
  if (integration.status === 'hors ligne' || integration.status === 'à reconfigurer') return ' is-danger'
  return ' is-warn'
}

export function DashboardView({
  project,
  onConversationSelect,
  onStartConversation,
  onOpenSettings,
}: DashboardViewProps) {
  const { data, connected, error } = useDashboard(project.id)
  const [openConversations, setOpenConversations] = useState<Record<string, boolean>>({})
  const [openNotesTicketId, setOpenNotesTicketId] = useState<string | null>(null)
  const [notesByTicket, setNotesByTicket] = useState<Record<string, TicketNote[]>>({})
  const [draftNote, setDraftNote] = useState('')
  const hasGitlab = data?.integrations.some((integration) => integration.type === 'gitlab') ?? false
  const degradedIntegrations = data?.integrations.filter((integration) => integration.status !== 'ok') ?? []
  const tableClassName = useMemo(
    () => `dashboard-table${hasGitlab ? ' dashboard-table--with-gitlab' : ''}`,
    [hasGitlab],
  )

  async function handleRefresh() {
    try {
      await refreshProjectDashboard(project.id)
    } catch {}
  }

  async function handleToggleNotes(ticket: TicketRow) {
    if (openNotesTicketId === ticket.id) {
      setOpenNotesTicketId(null)
      setDraftNote('')
      return
    }
    setOpenNotesTicketId(ticket.id)
    setDraftNote('')
    try {
      const notes = await listTicketNotes(ticket.id)
      setNotesByTicket((current) => ({ ...current, [ticket.id]: notes }))
    } catch {}
  }

  async function handleAddNote(ticket: TicketRow) {
    const body = draftNote.trim()
    if (!body) return
    try {
      const note = await createTicketNote(ticket.id, body)
      setNotesByTicket((current) => ({ ...current, [ticket.id]: [...(current[ticket.id] ?? []), note] }))
      setDraftNote('')
    } catch {}
  }

  return (
    <section className="dashboard-view" aria-labelledby="dashboard-title">
      <div className="dashboard-scroll">
        <header className="dashboard-header">
          <div className="dashboard-heading">
            <h1 id="dashboard-title">Tableau de bord</h1>
            <p className="dashboard-baseline">{project.name}</p>
          </div>
          <div className="dashboard-header-actions">
            <span className={`dashboard-connection ${connected ? 'is-live' : ''}`}>
              <i aria-hidden="true" /> {connected ? 'temps réel' : 'reconnexion'}
            </span>
            <button type="button" className="secondary-button" onClick={() => void handleRefresh()}>
              Rafraîchir
            </button>
          </div>
        </header>

        {error ? <p className="dashboard-banner is-danger">Tableau indisponible : {error}</p> : null}

        {degradedIntegrations.map((integration) => (
          <p key={integration.id} className={`dashboard-banner${bannerTone(integration)}`}>
            {INTEGRATION_LABEL[integration.type] ?? integration.type}
            {` : ${integration.status}`}
            {integration.last_error ? ` — ${integration.last_error}` : ''}
            {integration.status === 'non configurée' && onOpenSettings ? (
              <>
                {' '}
                <button type="button" className="text-button" onClick={onOpenSettings}>Configurer</button>
              </>
            ) : null}
          </p>
        ))}

        <section className="dashboard-section">
          <div className="dashboard-section-head">
            <h2 className="dashboard-section-title">Mes tickets</h2>
          </div>

          {data === null ? null : data.tickets.length === 0 ? (
            <div className="dashboard-empty">
              <strong>Aucun ticket pour ce projet</strong>
              <p>Configure ClickUp ou GitLab, ou démarre une conversation sur une branche.</p>
            </div>
          ) : (
            <div className={tableClassName} role="region" aria-label="Mes tickets">
              <div className="dashboard-row dashboard-head">
                <span>Ticket</span>
                <span>Statut</span>
                <span>Branche</span>
                <span>MR</span>
                <span>Pipeline</span>
                {hasGitlab ? <span>Déployé</span> : null}
                <span>Conversations</span>
                <span>Actions</span>
              </div>

              {data.tickets.map((ticket) => {
                const branch = refOf(ticket, 'branch')
                const mergeRequest = refOf(ticket, 'mr')
                const pipeline = refOf(ticket, 'pipeline')
                const deployment = refOf(ticket, 'deployment')
                const notes = notesByTicket[ticket.id] ?? []
                const notesCount = notesByTicket[ticket.id] ? notes.length : ticket.notes_count
                const pipelineLabel = pipelineStatus(pipeline)
                const pipelineUrl = textValue(pipeline?.payload.url)
                const mergeRequestUrl = textValue(mergeRequest?.payload.url)
                const externalUrl = ticket.external_url

                return (
                  <Fragment key={ticket.id}>
                    <div className="dashboard-row">
                      <span className="dashboard-ticket">
                        <strong className="dashboard-key">{ticket.key}</strong>
                        <small>{ticket.title}</small>
                        {externalUrl ? (
                          <a
                            className="dashboard-ticket-link"
                            href={externalUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            ClickUp ↗
                          </a>
                        ) : null}
                      </span>

                      <span className="dashboard-status">
                        <i
                          className="dashboard-status-dot"
                          aria-hidden="true"
                          style={{ background: textValue(ticket.payload.statusColor) ?? 'var(--text-faint)' }}
                        />
                        {ticket.status || '—'}
                      </span>

                      <span className="dashboard-branch">
                        {branch ? (
                          <>
                            <BranchIcon />
                            <span>{branch.ref}</span>
                          </>
                        ) : '—'}
                      </span>

                      <span className="dashboard-link">
                        {mergeRequest && mergeRequestUrl ? (
                          <a
                            href={mergeRequestUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`MR ${mergeRequest.ref}`}
                          >
                            <span>{mergeRequest.ref}</span>
                            <small>{mrLabel(mergeRequest)}</small>
                          </a>
                        ) : '—'}
                      </span>

                      <span className={`dashboard-pipeline ${pipelineTone(pipelineLabel)}`}>
                        {pipeline && pipelineUrl && pipelineLabel ? (
                          <a href={pipelineUrl} target="_blank" rel="noreferrer">{pipelineLabel}</a>
                        ) : (
                          pipelineLabel ?? '—'
                        )}
                      </span>

                      {hasGitlab ? <span>{deploymentLabel(deployment)}</span> : null}

                      <span>
                        {ticket.conversations.length === 0 ? (
                          <span className="dashboard-conversation-count">0</span>
                        ) : (
                          <div className="dashboard-conversations">
                            <button
                              type="button"
                              className="text-button"
                              aria-label={`Conversations (${ticket.conversations.length})`}
                              aria-expanded={Boolean(openConversations[ticket.id])}
                              aria-controls={`ticket-${ticket.id}-conversations`}
                              onClick={() => setOpenConversations((current) => ({
                                ...current,
                                [ticket.id]: !current[ticket.id],
                              }))}
                            >
                              {ticket.conversations.length}
                            </button>
                            {openConversations[ticket.id] ? (
                              <ul id={`ticket-${ticket.id}-conversations`} className="dashboard-conversation-list">
                                {ticket.conversations.map((conversation) => (
                                  <li key={conversation.id}>
                                    <button
                                      type="button"
                                      className="text-button"
                                      onClick={() => onConversationSelect(conversation.id)}
                                    >
                                      <span>{conversation.title}</span>
                                      <small>{conversationSummary(conversation)}</small>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        )}
                      </span>

                      <span className="dashboard-actions">
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => onStartConversation({
                            ticketId: ticket.id,
                            branch: branch?.ref ?? null,
                            ticketKey: ticket.key,
                          })}
                        >
                          {ticket.conversations.length === 0 ? 'Démarrer' : 'Reprendre'}
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          aria-label={`Notes pour ${ticket.key} (${notesCount})`}
                          aria-expanded={openNotesTicketId === ticket.id}
                          aria-controls={`ticket-${ticket.id}-notes`}
                          onClick={() => void handleToggleNotes(ticket)}
                        >
                          Notes ({notesCount})
                        </button>
                      </span>
                    </div>

                    {openNotesTicketId === ticket.id ? (
                      <div id={`ticket-${ticket.id}-notes`} className="dashboard-notes">
                        <div className="dashboard-notes-list">
                          {notes.length === 0 ? (
                            <p className="dashboard-notes-empty">Aucune note pour ce ticket.</p>
                          ) : (
                            <ul>
                              {notes.map((note) => <li key={note.id}>{note.body}</li>)}
                            </ul>
                          )}
                        </div>
                        <form
                          className="dashboard-note-form"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void handleAddNote(ticket)
                          }}
                        >
                          <input
                            type="text"
                            value={draftNote}
                            onChange={(event) => setDraftNote(event.target.value)}
                            placeholder="Ajouter une note"
                            aria-label="Nouvelle note"
                          />
                          <button type="submit" className="secondary-button">Ajouter</button>
                        </form>
                      </div>
                    ) : null}
                  </Fragment>
                )
              })}
            </div>
          )}
        </section>

        {data && data.environments.length > 0 ? (
          <section className="dashboard-section">
            <div className="dashboard-section-head">
              <h2 className="dashboard-section-title">Environnements</h2>
            </div>
            <div className="dashboard-envs" role="region" aria-label="Environnements">
              <div className="dashboard-env-row dashboard-head">
                <span>Environnement</span>
                <span>Branche</span>
                <span>Par</span>
                <span>Depuis</span>
              </div>
              {data.environments.map((environment) => (
                <div className="dashboard-env-row" key={`${environment.project}:${environment.name}`}>
                  <span>
                    <small>{environment.project}</small>
                    {' '}
                    <strong>{environment.name}</strong>
                  </span>
                  <span className="dashboard-branch">
                    {environment.missing ? (
                      'introuvable'
                    ) : environment.branch ? (
                      <>
                        <BranchIcon />
                        <span>{environment.branch}</span>
                        {environment.key ? <small> · {environment.key}</small> : null}
                      </>
                    ) : (
                      '—'
                    )}
                  </span>
                  <span>{environment.user ?? '—'}</span>
                  <span>{relative(environment.deployedAt)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {data && data.toReview.length > 0 ? (
          <section className="dashboard-section">
            <div className="dashboard-section-head">
              <h2 className="dashboard-section-title">À relire</h2>
            </div>
            <ul className="dashboard-review">
              {data.toReview.map((review) => (
                <li key={`${review.project}!${review.iid}`}>
                  <div className="dashboard-review-main">
                    <a className="dashboard-card-link" href={review.url} target="_blank" rel="noreferrer">
                      <strong>{reviewLabel(review)}</strong>
                      <span>{review.title}</span>
                    </a>
                    {review.draft ? <span className="dashboard-pill is-warn">draft</span> : null}
                  </div>
                  <small>{review.author} · {relative(review.updatedAt)}</small>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </section>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { BranchIcon } from './BranchIcon'
import { listProjectChangelog, refreshProjectChangelog, refreshProjectDashboard, updateTicketInstruction } from './api'
import type {
  DashboardIntegration,
  Project,
  ProjectChangelogEntry,
  ProjectChangelogState,
  ReviewRequest,
  TicketConversationSummary,
  TicketRef,
  TicketRow,
} from './types'
import { useDashboard } from './useDashboard'
import { SentryInbox } from './SentryInbox'
import { ExternalLink } from './externalLink'
import { useNow } from './useNow'

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

function ClickUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#ff02f0" d="M2.4 8.3 12.1 0l9.5 8.3-3.1 3.5-6.5-5.7-6.6 5.7Z" />
      <path fill="#7b68ee" d="m2 18.4 3.7-2.8c2 2.6 4 3.8 6.4 3.8 2.3 0 4.3-1.2 6.2-3.7l3.7 2.7c-2.7 3.7-6.1 5.6-10 5.6-3.8 0-7.2-1.9-10-5.6Z" />
    </svg>
  )
}

function refOf(ticket: TicketRow, kind: TicketRef['kind']): TicketRef | undefined {
  return ticket.refs.find((ref) => ref.kind === kind)
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

interface StatusPresentation {
  label: string
  tone: 'is-ok' | 'is-danger' | 'is-warn' | 'is-info' | 'is-neutral'
  explanation: string
}

function pipelinePresentation(ref: TicketRef | undefined): StatusPresentation | null {
  const status = textValue(ref?.payload.status)
  if (!status) return null
  if (status === 'success') return { label: 'Réussi', tone: 'is-ok', explanation: 'Le pipeline s’est terminé avec succès.' }
  if (status === 'failed') return { label: 'Échec', tone: 'is-danger', explanation: 'Le pipeline a échoué.' }
  if (status === 'running') return { label: 'En cours', tone: 'is-info', explanation: 'Le pipeline est en cours d’exécution.' }
  if (status === 'manual') return { label: 'Action requise', tone: 'is-warn', explanation: 'Une action manuelle est nécessaire pour poursuivre le pipeline.' }
  if (status === 'pending' || status === 'created' || status === 'preparing') return { label: 'En attente', tone: 'is-warn', explanation: 'Le pipeline attend son exécution.' }
  if (status === 'canceled' || status === 'skipped') return { label: status === 'canceled' ? 'Annulé' : 'Ignoré', tone: 'is-neutral', explanation: `Pipeline ${status === 'canceled' ? 'annulé' : 'ignoré'}.` }
  return { label: status, tone: 'is-neutral', explanation: `État GitLab : ${status}.` }
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

function mrPresentation(ref: TicketRef | undefined): StatusPresentation | null {
  if (!ref) return null
  const mergeStatus = textValue(ref.payload.mergeStatus)
  if (ref.payload.hasConflicts === true || mergeStatus === 'conflict') {
    return { label: 'Conflits', tone: 'is-danger', explanation: 'La branche contient des conflits à résoudre avant la fusion.' }
  }
  if (mergeStatus === 'mergeable') return { label: 'Fusionnable', tone: 'is-ok', explanation: 'GitLab autorise la fusion de cette MR.' }
  if (mergeStatus === 'unchecked' || mergeStatus === 'checking') {
    return { label: 'Vérification en attente', tone: 'is-neutral', explanation: 'GitLab n’a pas encore calculé si cette MR peut être fusionnée.' }
  }
  if (mergeStatus === 'ci_still_running') return { label: 'CI en cours', tone: 'is-info', explanation: 'La fusion attend la fin de la CI.' }
  if (mergeStatus === 'not_approved' || mergeStatus === 'approvals_syncing') return { label: 'Approbation requise', tone: 'is-warn', explanation: 'La MR attend une approbation.' }
  const state = textValue(ref.payload.state)
  return { label: mergeStatus ?? state ?? ref.ref, tone: 'is-neutral', explanation: `État GitLab : ${mergeStatus ?? state ?? ref.ref}.` }
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

function changelogTiming(state: ProjectChangelogState | null, now: number): string {
  if (state?.status === 'running') return 'Actualisation en cours'
  if (!state?.next_refresh_at) return 'Jamais actualisé'
  const remaining = Date.parse(state.next_refresh_at) - now
  if (remaining <= 0) return 'Actualisation imminente'
  const minutes = Math.ceil(remaining / 60_000)
  const delay = minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
  return state.status === 'error'
    ? `Dernière actualisation en échec · prochain essai dans ${delay}`
    : `Prochaine actualisation dans ${delay}`
}

export function DashboardView({
  project,
  onConversationSelect,
  onStartConversation,
  onOpenSettings,
}: DashboardViewProps) {
  const { data, connected, error } = useDashboard(project.id)
  const [openConversations, setOpenConversations] = useState<Record<string, boolean>>({})
  const [instructionTicket, setInstructionTicket] = useState<TicketRow | null>(null)
  const [instructionDraft, setInstructionDraft] = useState('')
  const [instructionSaving, setInstructionSaving] = useState(false)
  const [instructionError, setInstructionError] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: 'ticket' | 'status'; direction: 'asc' | 'desc' }>({ key: 'ticket', direction: 'asc' })
  const [changelog, setChangelog] = useState<ProjectChangelogEntry[]>([])
  const [changelogState, setChangelogState] = useState<ProjectChangelogState | null>(null)
  const [changelogDomain, setChangelogDomain] = useState('')
  const [changelogMenuOpen, setChangelogMenuOpen] = useState(false)
  const now = useNow(30_000)
  const hasGitlab = data?.integrations.some((integration) => integration.type === 'gitlab') ?? false
  const degradedIntegrations = data?.integrations.filter((integration) => integration.status !== 'ok') ?? []
  const tableClassName = useMemo(
    () => `dashboard-table${hasGitlab ? ' dashboard-table--with-gitlab' : ''}`,
    [hasGitlab],
  )
  const changelogDomains = useMemo(() => [...new Map(changelog
    .filter((item): item is ProjectChangelogEntry & { domain_id: string; domain_name: string } => Boolean(item.domain_id && item.domain_name))
    .map((item) => [item.domain_id, item.domain_name])).entries()], [changelog])
  const visibleChangelog = changelogDomain ? changelog.filter((item) => item.domain_id === changelogDomain) : changelog
  const changelogHasMultipleRepositories = new Set(changelog.map((item) => item.repository_path)).size > 1
  const sortedTickets = useMemo(() => [...(data?.tickets ?? [])].sort((left, right) => {
    const comparison = sort.key === 'ticket'
      ? left.key.localeCompare(right.key, 'fr', { numeric: true })
      : left.status.localeCompare(right.status, 'fr', { sensitivity: 'base' }) || left.key.localeCompare(right.key, 'fr', { numeric: true })
    return sort.direction === 'asc' ? comparison : -comparison
  }), [data?.tickets, sort])

  useEffect(() => {
    let cancelled = false
    void listProjectChangelog(project.id).then((payload) => {
      if (!cancelled && Array.isArray(payload.entries)) {
        setChangelog(payload.entries)
        setChangelogState(payload.state)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [project.id])

  useEffect(() => {
    let cancelled = false
    const delay = changelogState?.status === 'running' ? 2_000 : 30_000
    const timer = setInterval(() => {
      void listProjectChangelog(project.id).then((payload) => {
        if (!cancelled && Array.isArray(payload.entries)) {
          setChangelog(payload.entries)
          setChangelogState(payload.state)
        }
      }).catch(() => {})
    }, delay)
    return () => { cancelled = true; clearInterval(timer) }
  }, [project.id, changelogState?.status])

  async function handleRefresh() {
    try {
      await refreshProjectDashboard(project.id)
    } catch {}
  }

  async function handleChangelogRefresh() {
    setChangelogMenuOpen(false)
    try {
      setChangelogState(await refreshProjectChangelog(project.id))
    } catch {}
  }

  function showChangelog() {
    setChangelogMenuOpen(false)
    document.getElementById('project-changelog')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function handleSort(key: 'ticket' | 'status') {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' })
  }

  function openInstruction(ticket: TicketRow) {
    setInstructionTicket(ticket)
    setInstructionDraft(ticket.instruction)
    setInstructionError(null)
  }

  async function handleSaveInstruction() {
    if (!instructionTicket || instructionSaving) return
    setInstructionSaving(true)
    setInstructionError(null)
    try {
      await updateTicketInstruction(instructionTicket.id, instructionDraft)
      setInstructionTicket(null)
    } catch (saveError) {
      setInstructionError(saveError instanceof Error ? saveError.message : 'Impossible d’enregistrer l’instruction.')
    } finally {
      setInstructionSaving(false)
    }
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
            <div
              className="dashboard-changelog-menu"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setChangelogMenuOpen(false)
              }}
            >
              <button
                type="button"
                className="secondary-button"
                aria-haspopup="menu"
                aria-expanded={changelogMenuOpen}
                title={changelogTiming(changelogState, now)}
                onClick={() => setChangelogMenuOpen((open) => !open)}
              >
                Changelog <span aria-hidden="true">⌄</span>
              </button>
              {changelogMenuOpen ? (
                <div className="dashboard-changelog-dropdown" role="menu">
                  <button type="button" role="menuitem" onClick={showChangelog}>Voir le changelog</button>
                  <button type="button" role="menuitem" disabled={changelogState?.status === 'running'} onClick={() => void handleChangelogRefresh()}>
                    {changelogState?.status === 'running' ? 'Actualisation en cours…' : 'Actualiser le changelog'}
                  </button>
                  <small>{changelogTiming(changelogState, now)}</small>
                </div>
              ) : null}
            </div>
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
                <span aria-sort={sort.key === 'ticket' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="dashboard-sort-button" onClick={() => handleSort('ticket')}>Ticket <i aria-hidden="true">{sort.key === 'ticket' ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}</i></button>
                </span>
                <span aria-sort={sort.key === 'status' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="dashboard-sort-button" onClick={() => handleSort('status')}>Statut <i aria-hidden="true">{sort.key === 'status' ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}</i></button>
                </span>
                <span>Branche</span>
                <span>MR</span>
                <span>Pipeline</span>
                {hasGitlab ? <span>Déployé</span> : null}
                <span>Conversations</span>
                <span>Actions</span>
              </div>

              {sortedTickets.map((ticket) => {
                const branch = refOf(ticket, 'branch')
                const mergeRequest = refOf(ticket, 'mr')
                const pipeline = refOf(ticket, 'pipeline')
                const deployment = refOf(ticket, 'deployment')
                const pipelineStatus = pipelinePresentation(pipeline)
                const mergeRequestStatus = mrPresentation(mergeRequest)
                const pipelineUrl = textValue(pipeline?.payload.url)
                const mergeRequestUrl = textValue(mergeRequest?.payload.url)
                const externalUrl = ticket.external_url

                return (
                  <div className="dashboard-row" key={ticket.id}>
                      <span className="dashboard-ticket">
                        <span className="dashboard-ticket-heading">
                          <strong className="dashboard-key">{ticket.key}</strong>
                          {externalUrl ? (
                            <ExternalLink className="dashboard-ticket-link" href={externalUrl} ariaLabel={`Ouvrir ${ticket.key} dans ClickUp`} title="Ouvrir dans ClickUp"><ClickUpIcon /></ExternalLink>
                          ) : null}
                        </span>
                        <small>{ticket.title}</small>
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
                          <ExternalLink
                            href={mergeRequestUrl}
                            ariaLabel={`MR ${mergeRequest.ref}`}
                          >
                            <span>{mergeRequest.ref}</span>
                            {mergeRequestStatus ? <small className={`dashboard-state ${mergeRequestStatus.tone}`} title={mergeRequestStatus.explanation}>{mergeRequestStatus.label}</small> : null}
                          </ExternalLink>
                        ) : '—'}
                      </span>

                      <span className="dashboard-pipeline">
                        {pipeline && pipelineUrl && pipelineStatus ? (
                          <ExternalLink className={`dashboard-state ${pipelineStatus.tone}`} href={pipelineUrl} title={pipelineStatus.explanation}>{pipelineStatus.label}</ExternalLink>
                        ) : (
                          pipelineStatus ? <span className={`dashboard-state ${pipelineStatus.tone}`} title={pipelineStatus.explanation}>{pipelineStatus.label}</span> : '—'
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
                          Nouvelle conv.
                        </button>
                        <button
                          type="button"
                          className={`text-button dashboard-instruction-button${ticket.instruction ? ' is-active' : ''}`}
                          onClick={() => openInstruction(ticket)}
                        >
                          {ticket.instruction ? 'Instruction' : '+ Instruction'}
                        </button>
                      </span>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <SentryInbox projectId={project.id} onConfigure={onOpenSettings} onConversationSelect={onConversationSelect} />

        <section id="project-changelog" className="dashboard-section dashboard-changelog">
          <div className="dashboard-section-head">
            <div><h2 className="dashboard-section-title">Changelog</h2><p>{changelogTiming(changelogState, now)}</p></div>
            {changelogDomains.length > 1 ? <select aria-label="Filtrer le changelog par domaine" value={changelogDomain} onChange={(event) => setChangelogDomain(event.target.value)}><option value="">Tous les domaines</option>{changelogDomains.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select> : null}
          </div>
          {visibleChangelog.length === 0 ? <div className="dashboard-empty"><strong>Aucun commit importé</strong><p>Le premier passage reprendra automatiquement l’historique depuis le 1er janvier 2026.</p></div> : <ol className="dashboard-changelog-list">{visibleChangelog.slice(0, 100).map((item) => <li key={`${item.repository_path}:${item.commit_sha}`}><div><span className="dashboard-pill">{item.domain_name ?? 'À enrichir'}</span>{changelogHasMultipleRepositories ? <span className="dashboard-repository-label">{item.repository_path === '.' ? project.name : item.repository_path.split('/').at(-1)}</span> : null}<span className="dashboard-branch-label"><BranchIcon />{item.branch}</span><code>{item.commit_sha.slice(0, 7)}</code><time>{new Date(item.committed_at).toLocaleDateString('fr-FR')}</time></div><strong>{item.product_message ?? item.subject}</strong>{item.product_message ? <small>{item.subject}</small> : <small>Enrichissement en attente</small>}</li>)}</ol>}
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
                    <ExternalLink className="dashboard-card-link" href={review.url}>
                      <strong>{reviewLabel(review)}</strong>
                      <span>{review.title}</span>
                    </ExternalLink>
                    {review.draft ? <span className="dashboard-pill is-warn">draft</span> : null}
                  </div>
                  <small>{review.author} · {relative(review.updatedAt)}</small>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      {instructionTicket ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setInstructionTicket(null)} onKeyDown={(event) => { if (event.key === 'Escape') setInstructionTicket(null) }}>
          <section className="modal review-dialog dashboard-instruction-dialog" role="dialog" aria-modal="true" aria-labelledby="ticket-instruction-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header">
              <div><h2 id="ticket-instruction-title">Instruction · {instructionTicket.key}</h2><p>Injectée dans chaque nouvelle conversation reliée à ce ticket.</p></div>
              <button type="button" className="modal-close" onClick={() => setInstructionTicket(null)} aria-label="Fermer">×</button>
            </header>
            <form className="review-dialog-form dashboard-instruction-form" onSubmit={(event) => { event.preventDefault(); void handleSaveInstruction() }}>
              <label htmlFor="ticket-instruction">Instruction</label>
              <textarea id="ticket-instruction" autoFocus rows={8} value={instructionDraft} onChange={(event) => setInstructionDraft(event.target.value)} placeholder="Ex. Vérifier la rétrocompatibilité de l’API avant toute modification…" />
              {instructionError ? <p className="modal-error" role="alert">{instructionError}</p> : null}
              <footer className="modal-actions"><button type="button" className="secondary-button" onClick={() => setInstructionTicket(null)}>Annuler</button><button type="submit" className="primary-button" disabled={instructionSaving}>{instructionSaving ? 'Enregistrement…' : 'Enregistrer'}</button></footer>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  )
}

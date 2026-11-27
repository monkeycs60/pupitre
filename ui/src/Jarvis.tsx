import { track } from './analytics'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { dollars } from './dollars'
import { Icon, type IconName } from './Icon'
import {
  actionEffect,
  actionIsHarmless,
  askJarvis,
  cancelJarvisJob,
  executeJarvisAction,
  getJarvisJob,
  warmJarvis,
  type JarvisActionContext,
} from './jarvisActions'
import type { JarvisAction, JarvisCost, JarvisJob, JarvisMode, JarvisPreview, JarvisResult } from './types'

const POLL_MS = 500

const MODES: Array<{ id: JarvisMode; label: string; hint: string }> = [
  { id: 'auto', label: 'Auto', hint: 'Qwen 3.8 sur Cerebras répond en deux secondes ; Opus 5.5 prend la main dès qu’un plan s’impose.' },
  { id: 'fast', label: 'Rapide', hint: 'Qwen 3.8 seul, sans passage à Opus : pour retrouver ou faire le point.' },
  { id: 'orchestrate', label: 'Orchestrer', hint: 'Opus 5.5 directement : pour préparer plusieurs actions sur tes agents.' },
]

const SUGGESTIONS = [
  'Qui m’attend ?',
  'Qu’est-ce qui tourne en ce moment ?',
  'Où est l’agent qui travaille sur ',
]

const ACTION_ICONS: Record<JarvisAction['kind'], IconName> = {
  open: 'arrow-right',
  'send-message': 'send',
  'new-conversation': 'plus',
  archive: 'archive',
  pin: 'pin',
  stop: 'stop',
  'open-url': 'external',
}

const STATUS_LABELS: Record<JarvisResult['status'], string> = {
  waiting: 't’attend',
  running: 'en cours',
  unread: 'à lire',
  idle: 'au repos',
  archived: 'archivée',
}

type ActionState = { status: 'idle' | 'confirm' | 'running' | 'done' | 'error' | 'skipped'; message?: string }

interface Exchange {
  id: string
  question: string
  mode: JarvisMode
  jobId: string | null
  job: JarvisJob | null
  error: string | null
  actions: Record<string, ActionState>
  edits: Record<string, { message?: string; prompt?: string }>
}

interface JarvisProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
  conversationId: string | null
  context: JarvisActionContext
}

type Phase = 'closed' | 'open' | 'closing'

const MORPH_IN = { duration: 460, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
const MORPH_OUT = { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)' }

/** Le clip-path ramène le panneau à la taille de la bulle sans le déformer : son contenu garde sa mise en page pendant l'ouverture. */
function morph(panel: HTMLElement, bubble: HTMLElement, direction: 'in' | 'out'): Animation | null {
  if (typeof panel.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null
  const from = bubble.getBoundingClientRect()
  const to = panel.getBoundingClientRect()
  const bubbleFrame = {
    transform: `translate(${Math.round(from.right - to.right)}px, ${Math.round(from.top - to.top)}px)`,
    clipPath: `inset(0px 0px ${Math.max(0, Math.round(to.height - from.height))}px ${Math.max(0, Math.round(to.width - from.width))}px round ${from.height / 2}px)`,
    opacity: 0.4,
  }
  const panelFrame = { transform: 'translate(0px, 0px)', clipPath: 'inset(-60px -60px -60px -60px round 14px)', opacity: 1 }
  const content = [...panel.children].map((child) => child.animate(
    direction === 'in' ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }],
    direction === 'in' ? { duration: 220, delay: 120, fill: 'backwards' } : { duration: 120, fill: 'forwards' },
  ))
  const frame = direction === 'in'
    ? panel.animate([bubbleFrame, panelFrame], MORPH_IN)
    : panel.animate([panelFrame, bubbleFrame], { ...MORPH_OUT, fill: 'forwards' })
  frame.addEventListener('cancel', () => content.forEach((animation) => animation.cancel()))
  return frame
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

function seconds(ms: number): string {
  return `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`
}

function billed(costs: JarvisCost[]): number {
  return costs.reduce((total, cost) => cost.billing === 'api' ? total + cost.usd : total, 0)
}

function CostList({ costs }: { costs: JarvisCost[] }) {
  return (
    <div className="jarvis-costs" aria-label="Coût de la demande">
      <p className="jarvis-costs-head">Coût · {dollars(billed(costs))} facturés</p>
      <ul>
        {costs.map((cost, index) => (
          <li key={index} className={`is-${cost.billing}`}>
            <span className="jarvis-cost-label">{cost.label}</span>
            <span className="jarvis-cost-usd">
              {cost.billing === 'subscription' ? `≈ ${dollars(cost.usd)} · abonnement` : dollars(cost.usd)}
            </span>
            <span className="jarvis-cost-tokens">
              {cost.inputTokens.toLocaleString('fr-FR')} jetons lus · {cost.outputTokens.toLocaleString('fr-FR')} écrits
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Jarvis({ open, onOpenChange, projectId, conversationId, context }: JarvisProps) {
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<JarvisMode>('auto')
  const [unseen, setUnseen] = useState(false)
  const [phase, setPhase] = useState<Phase>(open ? 'open' : 'closed')
  if (open && phase !== 'open') setPhase('open')
  if (!open && phase === 'open') setPhase('closing')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const running = exchanges.some((exchange) => exchange.job === null ? exchange.error === null : exchange.job.status === 'running')

  function patch(id: string, update: (exchange: Exchange) => Exchange) {
    setExchanges((current) => current.map((exchange) => exchange.id === id ? update(exchange) : exchange))
  }

  useEffect(() => {
    if (!open) return
    setUnseen(false)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  useLayoutEffect(() => {
    const panel = panelRef.current
    const bubble = bubbleRef.current
    if (phase === 'closed' || !panel || !bubble) return
    const animation = morph(panel, bubble, phase === 'open' ? 'in' : 'out')
    if (phase === 'closing') {
      if (animation) animation.addEventListener('finish', () => setPhase('closed'))
      else setPhase('closed')
    }
    return () => animation?.cancel()
  }, [phase])

  const lastExchange = exchanges.at(-1)
  const lastSettled = lastExchange?.job?.status !== undefined && lastExchange.job.status !== 'running'
  useEffect(() => {
    if (open && (exchanges.length === 0 || lastSettled)) void warmJarvis(projectId, mode).catch(() => {})
  }, [open, projectId, mode, lastSettled, exchanges.length])
  useEffect(() => {
    const container = scrollRef.current
    const last = container?.querySelector<HTMLElement>('.jarvis-exchange:last-of-type')
    if (!container || !last) return
    container.scrollTo({ top: last.offsetTop - container.offsetTop - 8, behavior: 'smooth' })
  }, [exchanges.length, lastSettled])

  useEffect(() => {
    const pending = exchanges.filter((exchange) => exchange.jobId !== null && (exchange.job === null || exchange.job.status === 'running'))
    if (pending.length === 0) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      for (const exchange of pending) {
        void getJarvisJob(exchange.jobId!, controller.signal)
          .then((job) => {
            patch(exchange.id, (current) => ({ ...current, job }))
            if (job.status !== 'running') {
              track('jarvis.ask', {
                mode: exchange.mode,
                model: job.route?.model ?? 'aucun',
                by: job.route?.by ?? 'aucun',
                escalated: job.route?.escalated ?? false,
                status: job.status,
                seconds: job.finishedAt ? Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 100) / 10 : 0,
                results: job.answer?.results.length ?? 0,
                proposed: job.answer?.actions.map((action) => action.kind).join(',') ?? '',
              }, projectId)
              if (!open) setUnseen(true)
            }
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return
            patch(exchange.id, (current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }))
          })
      }
    }, POLL_MS)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [exchanges, open])

  async function ask(question: string) {
    const text = question.trim()
    if (text === '' || running) return
    const id = `${Date.now()}`
    const history = exchanges.slice(-3).flatMap((exchange) => [
      { role: 'user' as const, text: exchange.question },
      ...(exchange.job?.answer ? [{ role: 'jarvis' as const, text: exchange.job.answer.text }] : []),
    ])
    setExchanges((current) => [...current, { id, question: text, mode, jobId: null, job: null, error: null, actions: {}, edits: {} }])
    setDraft('')
    try {
      const { jobId } = await askJarvis({ question: text, projectId, conversationId, history, mode })
      patch(id, (current) => ({ ...current, jobId }))
    } catch (error) {
      patch(id, (current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  async function cancel(exchange: Exchange) {
    if (exchange.jobId === null) return
    await cancelJarvisJob(exchange.jobId).catch(() => {})
  }

  async function run(exchange: Exchange, action: JarvisAction) {
    patch(exchange.id, (current) => ({ ...current, actions: { ...current.actions, [action.id]: { status: 'running' } } }))
    try {
      if (action.kind === 'open') onOpenChange(false)
      const message = await executeJarvisAction(action, exchange.edits[action.id] ?? {}, context)
      track('jarvis.action', { kind: action.kind, result: 'fait' }, projectId)
      patch(exchange.id, (current) => ({ ...current, actions: { ...current.actions, [action.id]: { status: 'done', message } } }))
    } catch (error) {
      track('jarvis.action', { kind: action.kind, result: 'échec' }, projectId)
      patch(exchange.id, (current) => ({
        ...current,
        actions: { ...current.actions, [action.id]: { status: 'error', message: error instanceof Error ? error.message : String(error) } },
      }))
    }
  }

  function setActionState(exchange: Exchange, actionId: string, state: ActionState) {
    const kind = exchange.job?.answer?.actions.find((action) => action.id === actionId)?.kind
    if (state.status === 'skipped' && kind) track('jarvis.action', { kind, result: 'ignorée' }, projectId)
    patch(exchange.id, (current) => ({ ...current, actions: { ...current.actions, [actionId]: state } }))
  }

  function editAction(exchange: Exchange, actionId: string, edit: { message?: string; prompt?: string }) {
    patch(exchange.id, (current) => ({ ...current, edits: { ...current.edits, [actionId]: { ...current.edits[actionId], ...edit } } }))
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void ask(draft)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onOpenChange(false)
    }
  }

  const bubble = (
    <button
      ref={bubbleRef}
      type="button"
      className={`jarvis-bubble${running ? ' is-running' : ''}${unseen ? ' has-answer' : ''}${open ? ' is-open' : ''}`}
      onClick={() => onOpenChange(!open)}
      aria-expanded={open}
      aria-label={running ? 'Jarvis cherche' : unseen ? 'Jarvis a répondu' : 'Jarvis'}
      title={`${running ? 'Jarvis cherche…' : 'Demander à Jarvis'} · Ctrl J`}
    >
      <Icon name="spark" size={15} className="jarvis-spark" />
      {unseen && !open ? <span className="jarvis-bubble-note">Réponse prête</span> : null}
    </button>
  )

  if (phase === 'closed') return bubble

  return (
    <>
    {bubble}
    <section ref={panelRef} className={`jarvis-panel${exchanges.length > 0 ? ' has-exchanges' : ''}${phase === 'closing' ? ' is-closing' : ''}`} aria-label="Jarvis" role="dialog">
      <header className="jarvis-top">
        <Icon name="spark" size={15} className="jarvis-spark" />
        <strong>Jarvis</strong>
        <div className="jarvis-modes" role="radiogroup" aria-label="Modèle utilisé">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={mode === item.id}
              className={mode === item.id ? 'is-on' : ''}
              title={item.hint}
              onClick={() => setMode(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" className="jarvis-close" onClick={() => onOpenChange(false)} aria-label="Fermer Jarvis" title="Fermer · Échap">
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="jarvis-scroll" ref={scrollRef}>
        {exchanges.length === 0 ? (
          <div className="jarvis-empty">
            <p>Demande où est un agent, qui t’attend ou ce qui tourne. Jarvis cherche dans tous les projets, explique ce qu’il a trouvé et te propose des actions : <strong>rien ne part sans ton clic.</strong></p>
            <div className="jarvis-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => suggestion.endsWith(' ') ? (setDraft(suggestion), inputRef.current?.focus()) : void ask(suggestion)}>
                  {suggestion.trim()}{suggestion.endsWith(' ') ? '…' : ''}
                </button>
              ))}
            </div>
          </div>
        ) : exchanges.map((exchange) => (
          <ExchangeView
            key={exchange.id}
            exchange={exchange}
            onCancel={() => void cancel(exchange)}
            onOpenResult={(result) => {
              track('jarvis.action', { kind: 'open', result: 'fait' }, result.projectId)
              onOpenChange(false)
              void context.openConversation(result.projectId, result.conversationId, 'events' in result ? result.events.map((event) => event.id) : [])
            }}
            onRun={(action) => void run(exchange, action)}
            onState={(actionId, state) => setActionState(exchange, actionId, state)}
            onEdit={(actionId, edit) => editAction(exchange, actionId, edit)}
          />
        ))}
      </div>

      <footer className="jarvis-input">
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          placeholder={running ? 'Jarvis cherche…' : 'Demander à Jarvis…'}
          aria-label="Question pour Jarvis"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={running}
        />
        <button type="button" className="jarvis-send" onClick={() => void ask(draft)} disabled={running || draft.trim() === ''} aria-label="Envoyer à Jarvis" title="Envoyer · Entrée">
          <Icon name="arrow-up" size={15} />
        </button>
      </footer>
    </section>
    </>
  )
}

function Certainty({ score }: { score: number | null }) {
  if (score === null) return null
  return (
    <span className={`jarvis-certainty is-${score >= 80 ? 'high' : score >= 60 ? 'mid' : 'low'}`} title="Certitude de la recherche sémantique">
      {score} %
    </span>
  )
}

function ExchangeView({ exchange, onCancel, onOpenResult, onRun, onState, onEdit }: {
  exchange: Exchange
  onCancel: () => void
  onOpenResult: (result: JarvisResult | JarvisPreview) => void
  onRun: (action: JarvisAction) => void
  onState: (actionId: string, state: ActionState) => void
  onEdit: (actionId: string, edit: { message?: string; prompt?: string }) => void
}) {
  const job = exchange.job
  const isRunning = exchange.error === null && (job === null || job.status === 'running')
  const answer = job?.answer ?? null
  const costs = job?.costs ?? []
  const [traceOpen, setTraceOpen] = useState(false)
  const previewing = isRunning && (job?.preview.length ?? 0) > 0
  const stepsShown = traceOpen || (isRunning && !previewing)
  const pending = (answer?.actions ?? []).filter((action) => !actionIsHarmless(action)
    && (exchange.actions[action.id]?.status ?? 'idle') === 'idle')

  return (
    <article className="jarvis-exchange">
      <p className="jarvis-question">{exchange.question}</p>

      {job?.route ? (
        <div className={`jarvis-route is-${job.route.model === 'opus-5.5' ? 'opus' : 'fast'}`} title={job.route.reason}>
          <Icon name={job.route.model === 'opus-5.5' ? 'orchestrate' : 'bolt'} size={13} />
          <strong>{job.route.label}</strong>
          <span>{job.route.escalated && job.route.by === 'fast' ? `Le modèle rapide a passé la main : ${job.route.reason}` : job.route.reason}</span>
        </div>
      ) : null}

      {job && job.steps.length > 0 ? (
        <div className={`jarvis-trace${stepsShown ? ' is-open' : ''}`}>
          {!isRunning || previewing ? (
            <button type="button" className="jarvis-trace-toggle" aria-expanded={traceOpen} onClick={() => setTraceOpen(!traceOpen)}>
              <Icon name={traceOpen ? 'chevron-down' : 'chevron-right'} size={12} />
              {isRunning
                ? <>{job.steps.at(-1)!.label}<span className="conv-row-dots" aria-hidden="true"><i /><i /><i /></span></>
                : <>Ce que j’ai fait · {job.steps.length} étape{job.steps.length > 1 ? 's' : ''}{answer ? ` · ${seconds(answer.durationMs)}` : ''}{costs.length > 0 ? ` · ${dollars(billed(costs))}` : ''}</>}
            </button>
          ) : null}
          {stepsShown ? (
            <ol className="jarvis-steps">
              {job.steps.map((step) => (
                <li key={step.id} className={`is-${step.state}`}>
                  <span className="jarvis-step-mark" aria-hidden="true">
                    {step.state === 'running' ? <span className="jarvis-spinner" /> : <Icon name={step.state === 'error' ? 'close' : step.state === 'skipped' ? 'minimize' : 'check'} size={12} />}
                  </span>
                  <span className="jarvis-step-label">{step.label}</span>
                  {step.detail ? <span className="jarvis-step-detail">{step.detail}</span> : null}
                </li>
              ))}
            </ol>
          ) : null}
          {traceOpen && !isRunning && costs.length > 0 ? <CostList costs={costs} /> : null}
        </div>
      ) : isRunning ? (
        <p className="jarvis-waiting"><span className="jarvis-spinner" aria-hidden="true" />Jarvis prépare la recherche…</p>
      ) : null}

      {isRunning && job && job.preview.length > 0 ? (
        <div className="jarvis-preview" aria-label="Conversations proches">
          <p className="jarvis-preview-head">Conversations proches, par certitude · la réponse arrive</p>
          {job.preview.map((hit) => (
            <button key={hit.conversationId} type="button" className="jarvis-result is-preview" onClick={() => onOpenResult(hit)}>
              <span className="jarvis-result-head">
                <strong>{hit.title}</strong>
                <Certainty score={hit.score} />
              </span>
              <span className="jarvis-result-meta">{hit.projectName}</span>
              {hit.reason ? <span className="jarvis-result-reason">{hit.reason}</span> : null}
              <span className="jarvis-result-go">Ouvrir la conversation<Icon name="arrow-right" size={13} /></span>
            </button>
          ))}
        </div>
      ) : null}

      {isRunning && exchange.jobId !== null ? (
        <button type="button" className="jarvis-ghost" onClick={onCancel}>Arrêter</button>
      ) : null}

      {exchange.error !== null || job?.status === 'error' ? (
        <p className="jarvis-error" role="alert">{exchange.error ?? job?.error ?? 'Jarvis n’a pas pu répondre.'}</p>
      ) : null}
      {job?.status === 'cancelled' ? <p className="jarvis-note">Recherche arrêtée.</p> : null}

      {answer ? (
        <>
          <p className="jarvis-answer">{answer.text}</p>
          {answer.results.map((result) => (
            <button key={result.conversationId} type="button" className="jarvis-result" onClick={() => onOpenResult(result)}>
              <span className="jarvis-result-head">
                <strong>{result.title}</strong>
                <Certainty score={result.score} />
                <span className={`jarvis-status is-${result.status}`}>{STATUS_LABELS[result.status]}</span>
              </span>
              <span className="jarvis-result-meta">
                {[result.projectName, result.ticketKey, result.branch].filter(Boolean).join(' · ')}
              </span>
              {result.reason ? <span className="jarvis-result-reason">{result.reason}</span> : null}
              {result.events.slice(0, 3).map((event) => (
                <span className="jarvis-hit" key={event.id}>
                  <time>{formatTime(event.at)}</time>
                  <span>{event.excerpt}</span>
                </span>
              ))}
              <span className="jarvis-result-go">
                {result.events.length > 0 ? `Ouvrir et surligner ${result.events.length} passage${result.events.length > 1 ? 's' : ''}` : 'Ouvrir la conversation'}
                <Icon name="arrow-right" size={13} />
              </span>
            </button>
          ))}

          {answer.actions.length > 0 ? (
            <div className="jarvis-actions">
              <div className="jarvis-actions-head">
                <span>Je te propose</span>
                {pending.length > 1 ? (
                  <RunAll count={pending.length} onConfirm={() => pending.forEach((action) => onRun(action))} />
                ) : null}
              </div>
              {answer.actions.map((action) => (
                <ActionCard
                  key={action.id}
                  action={action}
                  state={exchange.actions[action.id] ?? { status: 'idle' }}
                  edit={exchange.edits[action.id] ?? {}}
                  onRun={() => onRun(action)}
                  onState={(state) => onState(action.id, state)}
                  onEdit={(edit) => onEdit(action.id, edit)}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </article>
  )
}

function RunAll({ count, onConfirm }: { count: number; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(timer)
  }, [armed])
  return armed ? (
    <button type="button" className="jarvis-runall is-armed" onClick={() => { setArmed(false); onConfirm() }}>Confirmer les {count}</button>
  ) : (
    <button type="button" className="jarvis-runall" onClick={() => setArmed(true)}>Tout exécuter</button>
  )
}

function ActionCard({ action, state, edit, onRun, onState, onEdit }: {
  action: JarvisAction
  state: ActionState
  edit: { message?: string; prompt?: string }
  onRun: () => void
  onState: (state: ActionState) => void
  onEdit: (edit: { message?: string; prompt?: string }) => void
}) {
  const harmless = actionIsHarmless(action)
  const finished = state.status === 'done' || state.status === 'skipped'
  return (
    <div className={`jarvis-action is-${state.status}`}>
      <div className="jarvis-action-head">
        <span className="jarvis-action-icon" aria-hidden="true"><Icon name={ACTION_ICONS[action.kind]} size={14} /></span>
        <strong>{action.label}</strong>
      </div>
      <p className="jarvis-action-why">{action.why}</p>
      {action.kind === 'send-message' && !finished ? (
        <textarea
          className="jarvis-action-text"
          value={edit.message ?? action.message}
          aria-label="Message envoyé à l’agent"
          onChange={(event) => onEdit({ message: event.target.value })}
          rows={3}
        />
      ) : null}
      {action.kind === 'new-conversation' && !finished ? (
        <textarea
          className="jarvis-action-text"
          value={edit.prompt ?? action.prompt}
          aria-label="Premier message de la nouvelle conversation"
          onChange={(event) => onEdit({ prompt: event.target.value })}
          rows={4}
        />
      ) : null}
      <p className="jarvis-action-effect"><Icon name="hand" size={12} />{actionEffect(action)}</p>
      <div className="jarvis-action-buttons">
        {state.status === 'done' ? <span className="jarvis-action-done"><Icon name="check" size={13} />{state.message}</span>
          : state.status === 'skipped' ? <span className="jarvis-action-skipped">Ignorée</span>
          : state.status === 'running' ? <span className="jarvis-action-running"><span className="jarvis-spinner" aria-hidden="true" />En cours…</span>
          : (
            <>
              {state.status === 'error' ? <span className="jarvis-action-error" role="alert">{state.message}</span> : null}
              {harmless || state.status === 'confirm' ? (
                <button type="button" className="jarvis-primary" onClick={onRun}>{harmless ? 'Ouvrir' : 'Confirmer'}</button>
              ) : (
                <button type="button" className="jarvis-primary" onClick={() => onState({ status: 'confirm' })}>Exécuter</button>
              )}
              <button type="button" className="jarvis-ghost" onClick={() => onState({ status: state.status === 'confirm' ? 'idle' : 'skipped' })}>
                {state.status === 'confirm' ? 'Annuler' : 'Ignorer'}
              </button>
            </>
          )}
      </div>
    </div>
  )
}

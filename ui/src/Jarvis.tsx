import { track } from './analytics'
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { Icon, type IconName } from './Icon'
import {
  actionEffect,
  actionIsHarmless,
  askJarvis,
  cancelJarvisJob,
  executeJarvisAction,
  getJarvisJob,
  pillClearance,
  warmJarvis,
  type JarvisActionContext,
} from './jarvis'
import type { JarvisAction, JarvisJob, JarvisMode, JarvisResult } from './types'

const POLL_MS = 500

const MODES: Array<{ id: JarvisMode; label: string; hint: string }> = [
  { id: 'auto', label: 'Auto', hint: 'Un routeur rapide lit ta demande : Haiku 5.5 répond, Opus 5.5 prend la main dès qu’un plan s’impose.' },
  { id: 'fast', label: 'Rapide', hint: 'Haiku 5.5 seul : quelques secondes, pour retrouver ou faire le point.' },
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

function usePillClearance(pillRef: RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    const root = document.documentElement
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place())
    let composer: Element | null = null
    let applied: number | null = null
    function place() {
      const pill = pillRef.current
      if (!pill) return
      const current = document.querySelector('.composer-area .composer')
      if (current !== composer) {
        if (composer) resize?.unobserve(composer)
        if (current) resize?.observe(current)
        composer = current
      }
      const boxes = composer ? [composer, ...composer.querySelectorAll('.context-gauge')].map((element) => element.getBoundingClientRect()) : []
      const bottom = pillClearance(boxes, pill.getBoundingClientRect(), window.innerHeight)
      if (bottom === applied) return
      applied = bottom
      if (bottom === null) root.style.removeProperty('--jarvis-pill-bottom')
      else root.style.setProperty('--jarvis-pill-bottom', `${bottom}px`)
    }
    place()
    const timer = window.setInterval(place, 1000)
    window.addEventListener('resize', place)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', place)
      resize?.disconnect()
      root.style.removeProperty('--jarvis-pill-bottom')
    }
  }, [pillRef])
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

function seconds(ms: number): string {
  return `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`
}

export function Jarvis({ open, onOpenChange, projectId, conversationId, context }: JarvisProps) {
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<JarvisMode>('auto')
  const [unseen, setUnseen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  usePillClearance(pillRef)
  const running = exchanges.some((exchange) => exchange.job === null ? exchange.error === null : exchange.job.status === 'running')

  function patch(id: string, update: (exchange: Exchange) => Exchange) {
    setExchanges((current) => current.map((exchange) => exchange.id === id ? update(exchange) : exchange))
  }

  useEffect(() => {
    if (open) {
      setUnseen(false)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
    document.documentElement.classList.toggle('jarvis-open', open)
    return () => document.documentElement.classList.remove('jarvis-open')
  }, [open])

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

  if (!open) {
    return (
      <button ref={pillRef} type="button" className={`jarvis-pill${running ? ' is-running' : ''}`} onClick={() => onOpenChange(true)} title="Demander à Jarvis · Ctrl J">
        <Icon name="spark" size={14} className="jarvis-spark" />
        {running ? <>Jarvis cherche<span className="conv-row-dots" aria-hidden="true"><i /><i /><i /></span></> : 'Jarvis'}
        {unseen ? <span className="jarvis-pill-dot" aria-label="Réponse prête" /> : <kbd>Ctrl J</kbd>}
      </button>
    )
  }

  return (
    <section className="jarvis-panel" aria-label="Jarvis" role="dialog">
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
              void context.openConversation(result.projectId, result.conversationId, result.events.map((event) => event.id))
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
  )
}

function ExchangeView({ exchange, onCancel, onOpenResult, onRun, onState, onEdit }: {
  exchange: Exchange
  onCancel: () => void
  onOpenResult: (result: JarvisResult) => void
  onRun: (action: JarvisAction) => void
  onState: (actionId: string, state: ActionState) => void
  onEdit: (actionId: string, edit: { message?: string; prompt?: string }) => void
}) {
  const job = exchange.job
  const isRunning = exchange.error === null && (job === null || job.status === 'running')
  const answer = job?.answer ?? null
  const [traceOpen, setTraceOpen] = useState(false)
  const pending = (answer?.actions ?? []).filter((action) => !actionIsHarmless(action)
    && (exchange.actions[action.id]?.status ?? 'idle') === 'idle')

  return (
    <article className="jarvis-exchange">
      <p className="jarvis-question">{exchange.question}</p>

      {job?.route ? (
        <div className={`jarvis-route is-${job.route.model === 'opus-5.5' ? 'opus' : 'haiku'}`} title={job.route.reason}>
          <Icon name={job.route.model === 'opus-5.5' ? 'orchestrate' : 'bolt'} size={13} />
          <strong>{job.route.label}</strong>
          <span>{job.route.escalated ? `${job.route.by === 'router' ? 'Le routeur a passé la main' : 'Haiku a passé la main'} : ${job.route.reason}` : job.route.reason}</span>
        </div>
      ) : null}

      {job && job.steps.length > 0 ? (
        <div className={`jarvis-trace${isRunning || traceOpen ? ' is-open' : ''}`}>
          {!isRunning ? (
            <button type="button" className="jarvis-trace-toggle" aria-expanded={traceOpen} onClick={() => setTraceOpen(!traceOpen)}>
              <Icon name={traceOpen ? 'chevron-down' : 'chevron-right'} size={12} />
              Ce que j’ai fait · {job.steps.length} étape{job.steps.length > 1 ? 's' : ''}{answer ? ` · ${seconds(answer.durationMs)}` : ''}
            </button>
          ) : null}
          {isRunning || traceOpen ? (
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
        </div>
      ) : isRunning ? (
        <p className="jarvis-waiting"><span className="jarvis-spinner" aria-hidden="true" />Jarvis prépare la recherche…</p>
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

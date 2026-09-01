import { useEffect, useMemo, useState } from 'react'
import { getProjectCosts } from './api'
import type { Project, ProjectCostReport, Provider, QuotaState } from './types'
import { HelpLink } from './HelpLink'
import { modelLabel } from './modelOptions'
import { useQuotas } from './useQuotas'
import { useNow } from './useNow'
import {
  formatCountdown,
  formatResetClock,
  msUntilReset,
  quotaSummary,
  windowTitle,
} from './quotaSignals'

/** La palette validée compte huit teintes : au-delà, on replie sur « Autres ». */
const MAX_MODEL_SLICES = 5
const VIZ_COLORS = [
  'var(--accent)', 'var(--ok)', 'var(--warn)', 'var(--viz-5)', 'var(--viz-1)',
  'var(--viz-2)', 'var(--viz-3)', 'var(--viz-6)',
]

/* Au-delà, la couleur passe à l'alerte — même seuil que QuotaBar/QuotaMeter. */
const CRITICAL_PERCENT = 90

const PROVIDER_NAMES: Record<Provider, string> = { claude: 'CLAUDE', codex: 'CODEX', grok: 'GROK' }
const PROVIDER_COLORS: Record<Provider, string> = { claude: 'var(--accent)', codex: 'var(--warn)', grok: 'var(--prov-grok)' }
const PROVIDER_CHIP_BG: Record<Provider, string> = { claude: 'var(--accent-soft)', codex: 'var(--warn-soft)', grok: 'var(--prov-grok-soft)' }

/** Une part du classement, avec les modèles qu'elle recouvre (pour le filtre). */
interface ModelSlice { label: string; value: number; models: string[] }

/** Tokens cumulés par modèle sur tout le mois, tous fils confondus. */
function modelBreakdown(report: ProjectCostReport | null): ModelSlice[] {
  if (report === null) return []
  const totals = new Map<string, number>()
  for (const conversation of report.conversations) {
    for (const model of conversation.models) {
      totals.set(model.model, (totals.get(model.model) ?? 0) + model.tokens)
    }
  }
  const sorted = [...totals.entries()]
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1])
  const head = sorted.slice(0, MAX_MODEL_SLICES - 1)
  const tail = sorted.slice(MAX_MODEL_SLICES - 1)
  const slices: ModelSlice[] = head.map(([model, value]) => ({
    label: modelLabel(model),
    value,
    models: [model],
  }))
  if (tail.length > 0) {
    slices.push({
      label: `Autres (${tail.length})`,
      value: tail.reduce((sum, [, value]) => sum + value, 0),
      models: tail.map(([model]) => model),
    })
  }
  return slices
}

interface CostsViewProps {
  project: Project
  onConversationSelect: (conversationId: string) => void
}

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function previousMonth(value: string): string {
  const [year, month] = value.split('-').map(Number)
  const date = new Date(year, month - 2, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function tokens(value: number): string {
  return value.toLocaleString('fr-FR')
}

function hasTokenUsage(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function displayTokens(value: number | null | undefined): string {
  return value == null ? '—' : tokens(value)
}

const PARENT_TOKENS_AVOIDED_LABEL = 'Tokens du modèle parent évités — estimation'

/** Une fenêtre de quota : libellé, jauge fine colorée, légende de reset. */
function QuotaWindowRow({ provider, window, now }: {
  provider: Provider
  window: QuotaState['windows'][number]
  now: number
}) {
  const isCritical = (window.usedPercent ?? 0) >= CRITICAL_PERCENT
  const color = isCritical ? 'var(--danger)' : PROVIDER_COLORS[provider]
  const remaining = msUntilReset(window, now)
  const countdown = remaining === null ? null : formatCountdown(remaining)
  const clock = formatResetClock(window.resetsAt)
  const resetLabel = countdown === null
    ? 'reset non publié'
    : [clock !== null ? `reset à ${clock}` : 'reset', countdown === 'imminent' ? 'imminent' : `dans ${countdown}`]
      .join(' · ')

  return (
    <div className="quota-card-window">
      <div className="quota-card-window-head">
        <span>{windowTitle(window)}</span>
        <span style={{ color }}>
          {window.usedPercent === null ? 'usage non publié' : `${Math.round(window.usedPercent)} % utilisé`}
        </span>
      </div>
      <div className="quota-card-gauge">
        <span
          className="quota-card-gauge-fill"
          style={{ width: `${Math.min(100, Math.max(0, window.usedPercent ?? 0))}%`, background: color }}
        />
      </div>
      <div className="quota-card-reset">{resetLabel}</div>
    </div>
  )
}

/** Une carte de quota par provider : badge, pourcentage phare, fenêtres, note. */
function QuotaCard({ provider, state, now }: { provider: Provider; state: QuotaState | null; now: number }) {
  const summary = quotaSummary(provider, state, now)
  const color = (summary.usedPercent ?? 0) >= CRITICAL_PERCENT ? 'var(--danger)' : PROVIDER_COLORS[provider]
  const hasWindows = state !== null && state.windows.length > 0

  return (
    <div className="quota-card" style={{ borderColor: (summary.usedPercent ?? 0) >= CRITICAL_PERCENT ? 'var(--danger)' : undefined }}>
      <div className="quota-card-head">
        <span className="quota-card-badge" style={{ color: PROVIDER_COLORS[provider], background: PROVIDER_CHIP_BG[provider] }}>
          {PROVIDER_NAMES[provider]}
        </span>
        <span className="quota-card-headline" style={{ color }}>
          {summary.usedPercent === null ? summary.headline : `${Math.round(summary.usedPercent)} %`}
        </span>
      </div>
      {hasWindows ? (
        <div className="quota-card-windows">
          {state.windows.map((window) => (
            <QuotaWindowRow key={window.label} provider={provider} window={window} now={now} />
          ))}
        </div>
      ) : null}
      {summary.note !== null ? <p className="quota-card-note">{summary.note}</p> : null}
    </div>
  )
}

export function CostsView({ project, onConversationSelect }: CostsViewProps) {
  const [month, setMonth] = useState(currentMonth)
  const [report, setReport] = useState<ProjectCostReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Modèle sélectionné dans le classement : filtre le tableau en dessous. */
  const [modelFilter, setModelFilter] = useState<string | null>(null)
  const quotas = useQuotas()
  const now = useNow()

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    void getProjectCosts(project.id, month, controller.signal)
      .then((nextReport) => {
        if (month === currentMonth() && nextReport.totalTokens === 0) {
          setMonth(previousMonth(month))
          return
        }
        setReport(nextReport)
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : 'Coûts indisponibles')
      })
    return () => controller.abort()
  }, [month, project.id])

  const hasDelegatedTokens = report?.conversations.some((conversation) => hasTokenUsage(conversation.subtaskTokens)) ?? false
  const hasDelegationSavings = report?.conversations.some((conversation) => hasTokenUsage(conversation.delegationSavingsTokens)) ?? false
  const tableClassName = [
    'cost-table',
    hasDelegatedTokens ? 'cost-table--with-delegated' : '',
    hasDelegationSavings ? 'cost-table--with-savings' : '',
  ].filter(Boolean).join(' ')
  const modelSlices = useMemo(() => modelBreakdown(report), [report])
  const modelTotal = useMemo(() => modelSlices.reduce((sum, slice) => sum + slice.value, 0), [modelSlices])
  const filteredConversations = useMemo(() => {
    const conversations = report?.conversations ?? []
    const slice = modelSlices.find((item) => item.label === modelFilter)
    if (!slice) return conversations
    return conversations.filter((conversation) =>
      conversation.models.some((model) => slice.models.includes(model.model)),
    )
  }, [report, modelSlices, modelFilter])

  return (
    <section className="costs-view" aria-labelledby="costs-title">
      <div className="costs-scroll">
        <header className="costs-header">
          <div>
            <h1 id="costs-title">Coûts &amp; quotas</h1>
            <p>{project.name} · usage réel en tokens, mesuré localement, aucun prix inventé.</p>
            <HelpLink slug="couts" />
          </div>
          <label><span>Mois</span><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
        </header>
        {error ? <p className="costs-error" role="alert">{error}</p> : null}

        <div className="quota-card-grid">
          <QuotaCard provider="claude" state={quotas.snapshot.claude} now={now} />
          <QuotaCard provider="codex" state={quotas.snapshot.codex} now={now} />
          <QuotaCard provider="grok" state={quotas.snapshot.grok ?? null} now={now} />
        </div>

        {report ? (
          <>
            {report.totalTokens > 0 ? (
              <dl className="cost-totals" aria-label="Répartition des tokens">
                <div><dt>Total</dt><dd>{tokens(report.totalTokens)}</dd></div>
                <div><dt>Direct</dt><dd>{tokens(report.directTokens)}</dd></div>
                {hasDelegatedTokens ? <div><dt>Délégué</dt><dd>{tokens(report.subtaskTokens)}</dd></div> : null}
                {hasDelegationSavings ? <div title="Estimation des tokens qui auraient été consommés par le modèle parent."><dt>{PARENT_TOKENS_AVOIDED_LABEL}</dt><dd>{tokens(report.delegationSavingsTokens)}</dd></div> : null}
              </dl>
            ) : null}

            {modelSlices.length > 0 ? (
              <div className="costs-breakdown">
                <div className="costs-breakdown-head">
                  <h2>Tokens par modèle</h2>
                  <div className="costs-breakdown-head-right">
                    <span className="costs-breakdown-total">{tokens(modelTotal)} au total</span>
                    {modelFilter ? (
                      <button type="button" className="costs-filter-clear" onClick={() => setModelFilter(null)}>
                        Filtré sur {modelFilter} · tout afficher
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="model-cost-list">
                  {modelSlices.map((slice, index) => {
                    const share = modelTotal > 0 ? (slice.value / modelTotal) * 100 : 0
                    const color = VIZ_COLORS[index % VIZ_COLORS.length]
                    const isSelected = modelFilter === slice.label
                    return (
                      <button
                        type="button"
                        key={slice.label}
                        className={`model-cost-row${isSelected ? ' is-selected' : ''}`}
                        onClick={() => setModelFilter(isSelected ? null : slice.label)}
                        aria-pressed={isSelected}
                      >
                        <span className="model-cost-name">
                          <span className="model-cost-swatch" style={{ background: color }} />
                          <span>{slice.label}</span>
                        </span>
                        <span className="model-cost-bar">
                          <span className="model-cost-bar-fill" style={{ width: `${share}%`, background: color }} />
                        </span>
                        <span className="model-cost-tokens">{tokens(slice.value)}</span>
                        <span className="model-cost-share">{share.toFixed(0)} %</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : null}

            <div className="costs-conversations">
              <h2>Conversations</h2>
              {filteredConversations.length === 0 ? (
                <div className="costs-empty"><strong>{modelFilter ? `Aucune conversation avec ${modelFilter}` : 'Aucun usage ce mois-ci'}</strong><p>Les événements d’usage des conversations et sous-tâches apparaîtront ici.</p></div>
              ) : (
                <div className={tableClassName} role="region" aria-label="Coûts par conversation">
                  <div className="cost-row cost-head"><span>Conversation</span><span>Modèles</span><span>Direct</span>{hasDelegatedTokens ? <span>Délégué</span> : null}{hasDelegationSavings ? <span className="cost-savings-heading" title={PARENT_TOKENS_AVOIDED_LABEL} aria-label={PARENT_TOKENS_AVOIDED_LABEL}>Parent évités</span> : null}<span>Total</span></div>
                  {filteredConversations.map((conversation) => (
                    <button type="button" className="cost-row" key={conversation.conversationId} onClick={() => onConversationSelect(conversation.conversationId)}>
                      <span><strong>{conversation.title}</strong><small>parent · {conversation.parentModel}</small></span>
                      <span className="model-breakdown">{conversation.models.map((model) => <small key={model.model}>{modelLabel(model.model)} · {tokens(model.tokens)}</small>)}</span>
                      <span>{tokens(conversation.directTokens)}</span>
                      {hasDelegatedTokens ? <span>{displayTokens(conversation.subtaskTokens)}</span> : null}
                      {hasDelegationSavings ? <span>{displayTokens(conversation.delegationSavingsTokens)}</span> : null}
                      <span><strong>{tokens(conversation.totalTokens)}</strong></span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : <div className="costs-empty">Calcul en cours…</div>}
      </div>
    </section>
  )
}

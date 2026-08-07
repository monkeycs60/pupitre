import { useEffect, useMemo, useState } from 'react'
import { getProjectCosts } from './api'
import type { Project, ProjectCostReport } from './types'
import { HelpLink } from './HelpLink'
import { DonutChart } from './DonutChart'
import type { DonutSlice } from './DonutChart'
import { modelLabel } from './modelOptions'

/** La palette validée compte cinq créneaux : au-delà, on replie sur « Autres ». */
const MAX_MODEL_SLICES = 5

/** Une part de l'anneau, avec les modèles qu'elle recouvre (pour le filtre). */
type ModelSlice = DonutSlice & { models: string[] }

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

export function CostsView({ project, onConversationSelect }: CostsViewProps) {
  const [month, setMonth] = useState(currentMonth)
  const [report, setReport] = useState<ProjectCostReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Part de l'anneau sélectionnée : filtre le tableau en dessous. */
  const [modelFilter, setModelFilter] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    void getProjectCosts(project.id, month, controller.signal)
      .then(setReport)
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : 'Coûts indisponibles')
      })
    return () => controller.abort()
  }, [month, project.id])

  const hasDelegatedTokens = report?.conversations.some((conversation) => hasTokenUsage(conversation.subtaskTokens)) ?? false
  const hasDelegationSavings = report?.conversations.some((conversation) => hasTokenUsage(conversation.delegationSavingsTokens)) ?? false
  const totalsClassName = [
    'cost-totals',
    hasDelegatedTokens ? 'cost-totals--with-delegated' : '',
    hasDelegationSavings ? 'cost-totals--with-savings' : '',
  ].filter(Boolean).join(' ')
  const tableClassName = [
    'cost-table',
    hasDelegatedTokens ? 'cost-table--with-delegated' : '',
    hasDelegationSavings ? 'cost-table--with-savings' : '',
  ].filter(Boolean).join(' ')
  const modelSlices = useMemo(() => modelBreakdown(report), [report])
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
      <header className="costs-header">
        <div><h1 id="costs-title">Coûts · {project.name}</h1><p>Usage réel en tokens · lecture directe / déléguée, sans conversion monétaire.</p><HelpLink slug="couts" /></div>
        <label><span>Mois</span><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
      </header>
      {error ? <p className="costs-error" role="alert">{error}</p> : null}
      {report ? (
        <>
          <dl className={totalsClassName} aria-label="Répartition des tokens">
            <div><dt>Total</dt><dd>{tokens(report.totalTokens)}</dd></div>
            <div><dt>Direct</dt><dd>{tokens(report.directTokens)}</dd></div>
            {hasDelegatedTokens ? <div><dt>Délégué</dt><dd>{tokens(report.subtaskTokens)}</dd></div> : null}
            {hasDelegationSavings ? <div title="Estimation des tokens qui auraient été consommés par le modèle parent."><dt>{PARENT_TOKENS_AVOIDED_LABEL}</dt><dd>{tokens(report.delegationSavingsTokens)}</dd></div> : null}
          </dl>
          {modelSlices.length > 0 ? (
            <div className="costs-breakdown">
              <h2>
                Répartition par modèle
                {modelFilter ? (
                  <button type="button" className="costs-filter-clear" onClick={() => setModelFilter(null)}>
                    Filtré sur {modelFilter} · tout afficher
                  </button>
                ) : null}
              </h2>
              <DonutChart
                slices={modelSlices}
                total={modelSlices.reduce((sum, slice) => sum + slice.value, 0)}
                caption="Tokens consommés par modèle"
                selected={modelFilter}
                onSelect={setModelFilter}
              />
            </div>
          ) : null}
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
        </>
      ) : <div className="costs-empty">Calcul en cours…</div>}
    </section>
  )
}

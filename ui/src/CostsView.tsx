import { useEffect, useState } from 'react'
import { getProjectCosts } from './api'
import type { Project, ProjectCostReport } from './types'

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

export function CostsView({ project, onConversationSelect }: CostsViewProps) {
  const [month, setMonth] = useState(currentMonth)
  const [report, setReport] = useState<ProjectCostReport | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <section className="costs-view" aria-labelledby="costs-title">
      <header className="costs-header">
        <div><h1 id="costs-title">Coûts · {project.name}</h1><p>Usage réel en tokens, sans conversion monétaire.</p></div>
        <label><span>Mois</span><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
      </header>
      {error ? <p className="costs-error" role="alert">{error}</p> : null}
      {report ? (
        <>
          <dl className="cost-totals">
            <div><dt>Total</dt><dd>{tokens(report.totalTokens)}</dd></div>
            <div><dt>Conversations</dt><dd>{tokens(report.directTokens)}</dd></div>
            <div><dt>Sous-tâches</dt><dd>{tokens(report.subtaskTokens)}</dd></div>
            <div title="Tokens exécutés par Luna qui n'ont pas consommé le budget du modèle parent. Le contrefactuel reste en tokens, jamais en euros."><dt>Économie de délégation</dt><dd>{tokens(report.delegationSavingsTokens)}</dd></div>
          </dl>
          {report.conversations.length === 0 ? (
            <div className="costs-empty"><strong>Aucun usage ce mois-ci</strong><p>Les événements d’usage des conversations et sous-tâches apparaîtront ici.</p></div>
          ) : (
            <div className="cost-table">
              <div className="cost-row cost-head"><span>Conversation</span><span>Modèles</span><span>Direct</span><span>Délégué</span><span>Économie</span><span>Total</span></div>
              {report.conversations.map((conversation) => (
                <button type="button" className="cost-row" key={conversation.conversationId} onClick={() => onConversationSelect(conversation.conversationId)}>
                  <span><strong>{conversation.title}</strong><small>parent · {conversation.parentModel}</small></span>
                  <span className="model-breakdown">{conversation.models.map((model) => <small key={model.model}>{model.model} · {tokens(model.tokens)}</small>)}</span>
                  <span>{tokens(conversation.directTokens)}</span>
                  <span>{tokens(conversation.subtaskTokens)}</span>
                  <span>{tokens(conversation.delegationSavingsTokens)}</span>
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

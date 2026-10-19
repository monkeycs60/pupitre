import type { AiConversationSearch } from './api'
import type { Conversation } from './types'

export type AiSearchState =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'done'; query: string; response: AiConversationSearch }
  | { status: 'error'; query: string; message: string }

function shortDate(value: string): string {
  return new Date(value).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

export function ConversationAiResults({
  state,
  selectedConversationId,
  onSelect,
}: {
  state: AiSearchState
  selectedConversationId: string | null
  onSelect: (conversation: Conversation) => void
}) {
  if (state.status === 'idle') {
    return (
      <p className="list-empty ai-search-hint">
        Décris la conversation en langage naturel (sujet, décision, période), puis appuie sur Entrée.
      </p>
    )
  }
  if (state.status === 'loading') {
    return (
      <p className="list-empty ai-search-status" role="status">
        <span className="conv-row-dots" aria-hidden="true"><i /><i /><i /></span>
        Recherche dans les conversations…
      </p>
    )
  }
  if (state.status === 'error') {
    return <p className="list-empty ai-search-error" role="alert">{state.message}</p>
  }
  const { results, reranked } = state.response
  if (results.length === 0) {
    return <p className="list-empty">Aucune conversation ne correspond à « {state.query} »</p>
  }
  const strong = results.filter((hit) => hit.match === 'strong')
  const partial = results.filter((hit) => hit.match === 'partial')
  const explained = results.some((hit) => hit.reason !== '')
  const row = ({ conversation, reason }: AiConversationSearch['results'][number]) => (
    <button
      type="button"
      key={conversation.id}
      className={`ai-search-result${conversation.id === selectedConversationId ? ' is-selected' : ''}`}
      data-conversation-id={conversation.id}
      onClick={() => onSelect(conversation)}
    >
      <span className="ai-search-result-line1">
        <span className="ai-search-result-title">{conversation.title}</span>
        <span className="ai-search-result-date">{shortDate(conversation.updated_at)}</span>
      </span>
      {reason ? <span className="ai-search-result-reason">{reason}</span> : null}
      {conversation.archived ? <span className="ai-search-result-badge">archivée</span> : null}
    </button>
  )
  const partialHeading = !reranked
    ? 'Classées par proximité, sans tri IA'
    : !explained
      ? 'Aucune correspondance nette · les plus proches'
      : strong.length > 0 ? 'Correspondances partielles' : 'Aucune correspondance complète · partielles'
  return (
    <div className="ai-search-results" aria-label="Résultats de la recherche IA">
      {strong.length > 0 ? (
        <div className="ai-search-results-heading">
          {strong.length} conversation{strong.length > 1 ? 's' : ''} correspond{strong.length > 1 ? 'ent' : ''}
        </div>
      ) : null}
      {strong.map(row)}
      {partial.length > 0 ? <div className="ai-search-results-heading">{partialHeading}</div> : null}
      {partial.map(row)}
    </div>
  )
}

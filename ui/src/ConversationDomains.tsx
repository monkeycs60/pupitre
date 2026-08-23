import type { ConversationDomain } from './types'

export function ConversationDomains({
  domains,
  proposedCount,
}: {
  domains: ConversationDomain[]
  proposedCount: number
}) {
  if (domains.length === 0 && proposedCount === 0) return null
  return (
    <span className="conversation-header-domains">
      {domains.map((domain) => (
        <span
          key={domain.id}
          className={`conversation-header-domain conversation-header-domain-${domain.kind === 'métier' ? 'metier' : 'technique'}`}
        >
          {domain.name}
        </span>
      ))}
      {proposedCount > 0 ? (
        <span className="conversation-header-domain-proposed">
          {proposedCount} {proposedCount === 1 ? 'proposition' : 'propositions'}
        </span>
      ) : null}
    </span>
  )
}

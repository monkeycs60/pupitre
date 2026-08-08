import Markdown from './Markdown'
import type { SessionSummaryBlock } from './groupEvents'

export function SessionSummaryCard({ block }: { block: SessionSummaryBlock }) {
  return (
    <details className="session-summary-card" open>
      <summary>
        <span className="session-summary-card-kicker">Résumé session</span>
        <span className="session-summary-card-range">
          événements {block.eventIdFrom}–{block.eventIdTo}
        </span>
      </summary>
      <div className="session-summary-card-content">
        <Markdown>{block.contentMd}</Markdown>
      </div>
    </details>
  )
}

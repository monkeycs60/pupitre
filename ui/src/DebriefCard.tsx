import ReactMarkdown from 'react-markdown'
import type { DebriefBlock } from './groupEvents'

export function DebriefCard({ block }: { block: DebriefBlock }) {
  const date = new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(block.createdAt))

  return (
    <details className="debrief-card" open>
      <summary>
        <span className="debrief-card-kicker">Débrief</span>
        <span>{date}</span>
        <span className="debrief-card-range">
          événements {block.eventIdFrom}–{block.eventIdTo}
        </span>
      </summary>
      <div className="debrief-card-content">
        <ReactMarkdown>{block.contentMd}</ReactMarkdown>
      </div>
    </details>
  )
}

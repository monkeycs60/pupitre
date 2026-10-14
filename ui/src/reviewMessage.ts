import type { ReviewComment } from './api'

function location(comment: ReviewComment): string {
  const lines = comment.start_line === comment.end_line ? `${comment.start_line}` : `${comment.start_line}-${comment.end_line}`
  return `\`${comment.path}:${lines}\` (${comment.repository_label}${comment.side === 'old' ? ', lignes supprimées' : ''})`
}

/**
 * Consigne de relecture déposée dans le composer : chaque commentaire porte
 * le chemin depuis la racine du dépôt (cliquable dans le fil) et les lignes
 * visées, pour que l'agent ne devine pas l'état du fichier au moment du
 * commentaire.
 */
export function reviewMessage(comments: ReviewComment[]): string {
  const count = `${comments.length} commentaire${comments.length > 1 ? 's' : ''}`
  const items = comments.map((comment, index) => {
    const quoted = comment.line_text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(0, 6)
      .map((line) => `   > ${line}`)
    return [`${index + 1}. ${location(comment)}`, ...quoted, `   ${comment.body.trim().replace(/\n/g, '\n   ')}`].join('\n')
  })
  return [`Relecture du code (${count}). Traite chaque point, puis réponds point par point.`, '', items.join('\n\n')].join('\n')
}

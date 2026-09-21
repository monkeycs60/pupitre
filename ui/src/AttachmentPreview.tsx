import Markdown from './Markdown'
import type { Attachment } from './types'
import { mediaUrl } from './transport'
import { DownloadLink, ExternalLink } from './externalLink'
import {
  formatAttachmentSize,
  getAttachmentPreviewKind,
  getAvailableAttachmentContent,
  type AttachmentPreviewKind,
} from './attachmentPreviewMeta'
import { DelimitedTable } from './DelimitedTable'

const MAX_INLINE_PREVIEW_CHARS = 20_000

const PREVIEW_KIND_LABELS: Record<AttachmentPreviewKind, string> = {
  text: 'TXT',
  markdown: 'MD',
  json: 'JSON',
  csv: 'CSV',
}

function extensionLabel(name: string): string {
  const extension = name.trim().split('.').pop()
  return extension === undefined || extension === '' || extension === name.trim()
    ? 'FICHIER'
    : extension.toUpperCase()
}

function formatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return content
  }
}

function visibleContent(content: string): { value: string; truncated: boolean } {
  if (content.length <= MAX_INLINE_PREVIEW_CHARS) return { value: content, truncated: false }
  return {
    value: `${content.slice(0, MAX_INLINE_PREVIEW_CHARS)}\n…`,
    truncated: true,
  }
}

function InlineContent({ kind, content }: { kind: AttachmentPreviewKind; content: string }) {
  const preview = visibleContent(kind === 'json' ? formatJson(content) : content)

  if (kind === 'markdown') {
    return (
      <div className="event-attachment-markdown">
        <Markdown>{preview.value}</Markdown>
      </div>
    )
  }

  if (kind === 'csv') return <DelimitedTable content={content} />

  return (
    <pre className="event-attachment-code"><code>{preview.value}</code></pre>
  )
}

export function AttachmentPreview({ attachment }: { attachment: Attachment }) {
  const previewKind = getAttachmentPreviewKind(attachment)
  const content = getAvailableAttachmentContent(attachment)
  const canPreview = previewKind !== null && content !== null
  const kindLabel = previewKind === null
    ? extensionLabel(attachment.originalName)
    : PREVIEW_KIND_LABELS[previewKind]
  const mediaHref = mediaUrl(attachment.name)
  const mimeLabel = attachment.mimeType.trim() || 'type inconnu'

  return (
    <article className="event-attachment">
      <div className="event-attachment-header">
        <div className="event-attachment-heading">
          <span className="event-attachment-kind" aria-hidden="true">{kindLabel}</span>
          <span className="event-attachment-name" title={attachment.originalName}>{attachment.originalName}</span>
        </div>
        <div className="event-attachment-actions">
          <ExternalLink
            className="event-attachment-action"
            href={mediaHref}
            ariaLabel={`Ouvrir ${attachment.originalName}`}
          >
            Ouvrir
          </ExternalLink>
          <DownloadLink
            className="event-attachment-action"
            href={mediaHref}
            filename={attachment.originalName}
            ariaLabel={`Télécharger ${attachment.originalName}`}
          >
            Télécharger
          </DownloadLink>
        </div>
      </div>
      <div className="event-attachment-meta">
        {mimeLabel} · {formatAttachmentSize(attachment.size)}
      </div>
      {canPreview ? (
        <div className="event-attachment-preview" aria-label={`Aperçu de ${attachment.originalName}`}>
          <InlineContent kind={previewKind} content={content} />
          {content.length > MAX_INLINE_PREVIEW_CHARS ? (
            <p className="event-attachment-truncated">Aperçu limité à 20 000 caractères.</p>
          ) : null}
        </div>
      ) : (
        <p className="event-attachment-unavailable">
          {previewKind === null
            ? 'Aperçu indisponible pour ce type de fichier.'
            : 'Contenu non disponible dans le fil.'}
        </p>
      )}
    </article>
  )
}

import { useEffect } from 'react'
import { AttachmentPreview } from './AttachmentPreview'
import type { ConversationAsset } from './conversationAssets'
import { documentDownloadUrl, documentThumbnailUrl, mediaUrl } from './transport'
import { createHtmlDocumentViewToken } from './api'
import { DownloadLink } from './externalLink'

function imageSource(reference: string): string {
  if (reference.startsWith('/media/')) {
    return mediaUrl(decodeURIComponent(reference.slice('/media/'.length)))
  }
  if (/^https?:\/\//i.test(reference)
    || reference.startsWith('/')
    || reference.startsWith('data:')
    || reference.startsWith('blob:')) {
    return reference
  }
  return mediaUrl(reference)
}

function sourceLabel(source: ConversationAsset['source']): string {
  return source === 'user' ? 'Vous' : 'Assistant'
}

function formatCreatedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const datePart = new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric', month: 'long',
  }).format(date)
  const timePart = new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit', minute: '2-digit',
  }).format(date)
  return `${datePart} ${timePart}`
}

async function downloadDocument(asset: Extract<ConversationAsset, { kind: 'document' }>) {
  const grant = await createHtmlDocumentViewToken(asset.documentId)
  const link = document.createElement('a')
  link.href = documentDownloadUrl(asset.documentId, grant.token)
  link.download = asset.originalName
  document.body.append(link)
  link.click()
  link.remove()
}

async function openAssetDocument(asset: Extract<ConversationAsset, { kind: 'document' }>) {
  await downloadDocument(asset)
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2.5v7m0 0 2.75-2.75M8 9.5 5.25 6.75M3 12.5h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ConversationAssetsDrawer({
  assets,
  open,
  onOpen,
  onClose,
  onImageOpen,
  showTrigger = true,
}: {
  assets: ConversationAsset[]
  open: boolean
  onOpen: () => void
  onClose: () => void
  onImageOpen: (src: string, alt: string) => void
  /** Faux quand le head porte le déclencheur à sa place. */
  showTrigger?: boolean
}) {
  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) {
    if (!showTrigger || assets.length === 0) return null
    const countLabel = `${assets.length} pièce${assets.length > 1 ? 's' : ''} jointe${assets.length > 1 ? 's' : ''}`
    return (
      <button
        type="button"
        className="thread-assets-open"
        onClick={onOpen}
        title={`Afficher les pièces jointes (${assets.length})`}
        aria-label={`Afficher les ${countLabel}`}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.5 4h4l1.25 1.4h5.75v7.1h-11V4Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
        </svg>
        {assets.length > 0 ? <span>{assets.length}</span> : null}
      </button>
    )
  }

  return (
    <>
      <button
        type="button"
        className="thread-assets-backdrop"
        aria-label="Fermer les pièces jointes"
        onClick={onClose}
      />
      <aside className="thread-assets-drawer" role="dialog" aria-modal="true" aria-label="Pièces jointes">
        <header className="thread-assets-header">
          <div>
            <strong>Pièces jointes</strong>
            <span>{assets.length} élément{assets.length > 1 ? 's' : ''}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer les pièces jointes">×</button>
        </header>

        {assets.length === 0 ? (
          <p className="thread-assets-empty">Aucune pièce jointe dans cette conversation.</p>
        ) : (
          <div className="thread-assets-list">
            {assets.map((asset) => (
              <article className={`thread-asset is-${asset.kind}`} key={asset.id}>
                {asset.kind === 'image' ? (
                  <div className="thread-asset-media">
                    <button
                      type="button"
                      className="thread-asset-image"
                      aria-label={`Agrandir ${asset.label.toLocaleLowerCase('fr-FR')}`}
                      onClick={() => onImageOpen(imageSource(asset.reference), asset.label)}
                    >
                      <img src={imageSource(asset.reference)} alt={asset.label} />
                    </button>
                    <DownloadLink
                      className="thread-asset-download-icon"
                      href={imageSource(asset.reference)}
                      filename={asset.label}
                      ariaLabel={`Télécharger ${asset.label}`}
                      title="Télécharger"
                    >
                      <DownloadIcon />
                    </DownloadLink>
                  </div>
                ) : asset.kind === 'document' ? (
                  <div className="thread-asset-media">
                    <button
                      type="button"
                      className="thread-asset-image is-document"
                      aria-label={`Agrandir ${asset.label.toLocaleLowerCase('fr-FR')}`}
                      onClick={() => onImageOpen(documentThumbnailUrl(asset.documentId), asset.label)}
                    >
                      <img src={documentThumbnailUrl(asset.documentId)} alt={`Aperçu de ${asset.label}`} />
                      <span>{asset.documentKind.toUpperCase()}</span>
                    </button>
                    <button
                      type="button"
                      className="thread-asset-download-icon"
                      onClick={() => void openAssetDocument(asset)}
                      aria-label={`Télécharger ${asset.originalName}`}
                      title="Télécharger"
                    >
                      <DownloadIcon />
                    </button>
                  </div>
                ) : (
                  <div className="thread-asset-file">
                    <AttachmentPreview attachment={asset.attachment} />
                    <DownloadLink
                      className="thread-asset-download-icon"
                      href={mediaUrl(asset.attachment.name)}
                      filename={asset.attachment.originalName}
                      ariaLabel={`Télécharger ${asset.attachment.originalName}`}
                      title="Télécharger"
                    >
                      <DownloadIcon />
                    </DownloadLink>
                  </div>
                )}
                {asset.kind !== 'attachment' ? (
                  <div className="thread-asset-meta">
                    <strong title={asset.label}>{asset.label}</strong>
                    <span>{sourceLabel(asset.source)}{asset.kind === 'document' ? ` · ${asset.documentKind.toUpperCase()}` : ''}</span>
                    {asset.kind === 'document' ? (
                      <>
                        <button type="button" className="thread-asset-download" onClick={() => void openAssetDocument(asset)}>
                          Télécharger
                        </button>
                      </>
                    ) : null}
                    {asset.createdAt ? <time dateTime={asset.createdAt}>{formatCreatedAt(asset.createdAt)}</time> : null}
                  </div>
                ) : (
                  <div className="thread-asset-source">
                    <span>{sourceLabel(asset.source)}</span>
                    {asset.createdAt ? <time dateTime={asset.createdAt}>{formatCreatedAt(asset.createdAt)}</time> : null}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </aside>
    </>
  )
}

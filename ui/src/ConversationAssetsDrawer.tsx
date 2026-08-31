import { useEffect } from 'react'
import { AttachmentPreview } from './AttachmentPreview'
import type { ConversationAsset } from './conversationAssets'
import { documentThumbnailUrl, mediaUrl } from './transport'

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

export function ConversationAssetsDrawer({
  assets,
  open,
  onOpen,
  onClose,
  onImageOpen,
}: {
  assets: ConversationAsset[]
  open: boolean
  onOpen: () => void
  onClose: () => void
  onImageOpen: (src: string, alt: string) => void
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
                  <button
                    type="button"
                    className="thread-asset-image"
                    aria-label={`Agrandir ${asset.label.toLocaleLowerCase('fr-FR')}`}
                    onClick={() => onImageOpen(imageSource(asset.reference), asset.label)}
                  >
                    <img src={imageSource(asset.reference)} alt={asset.label} />
                  </button>
                ) : asset.kind === 'document' ? (
                  <button
                    type="button"
                    className="thread-asset-image is-document"
                    aria-label={`Agrandir ${asset.label.toLocaleLowerCase('fr-FR')}`}
                    onClick={() => onImageOpen(documentThumbnailUrl(asset.documentId), asset.label)}
                  >
                    <img src={documentThumbnailUrl(asset.documentId)} alt={`Aperçu de ${asset.label}`} />
                    <span>{asset.documentKind.toUpperCase()}</span>
                  </button>
                ) : (
                  <AttachmentPreview attachment={asset.attachment} />
                )}
                {asset.kind !== 'attachment' ? (
                  <div className="thread-asset-meta">
                    <strong title={asset.label}>{asset.label}</strong>
                    <span>{sourceLabel(asset.source)}{asset.kind === 'document' ? ` · ${asset.documentKind.toUpperCase()}` : ''}</span>
                  </div>
                ) : (
                  <span className="thread-asset-source">{sourceLabel(asset.source)}</span>
                )}
              </article>
            ))}
          </div>
        )}
      </aside>
    </>
  )
}

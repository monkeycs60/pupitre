import type { AppEvent, Attachment } from './types'

export type ConversationAsset =
  | {
      kind: 'image'
      id: string
      label: string
      reference: string
      source: 'user' | 'assistant'
      createdAt?: string
    }
  | {
      kind: 'attachment'
      id: string
      label: string
      attachment: Attachment
      source: 'user'
      createdAt?: string
    }
  | {
      kind: 'document'
      id: string
      label: string
      documentId: string
      documentKind: import('./types').DocumentKind
      mimeType: string
      originalName: string
      size: number
      createdAt: string
      source: 'assistant'
    }

function markdownImages(text: string): Array<{ alt: string; reference: string }> {
  const images: Array<{ alt: string; reference: string }> = []
  const pattern = /!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g
  for (const match of text.matchAll(pattern)) {
    const reference = match[2] ?? match[3]
    if (reference === undefined) continue
    images.push({ alt: match[1]?.trim() || 'Image produite', reference })
  }
  return images
}

type AssetEvent = AppEvent & { createdAt?: string; eventCreatedAt?: string }

function eventCreatedAt(event: AssetEvent): string | undefined {
  return event.createdAt ?? event.eventCreatedAt
}

export function collectConversationAssets(events: ReadonlyArray<AssetEvent>): ConversationAsset[] {
  const assets: ConversationAsset[] = []
  const imageReferences = new Set<string>()

  const addImage = (asset: Extract<ConversationAsset, { kind: 'image' }>) => {
    const key = asset.reference.startsWith('/media/')
      ? decodeURIComponent(asset.reference.slice('/media/'.length))
      : asset.reference
    if (key === 'attachment' || imageReferences.has(key)) return
    imageReferences.add(key)
    assets.push(asset)
  }

  events.forEach((event, eventIndex) => {
    if (event.type === 'user-message') {
      const imageNames = new Set(event.images)
      event.images.forEach((name, imageIndex) => {
        const attachment = event.attachments?.find((candidate) => candidate.name === name)
        addImage({
          kind: 'image',
          id: `user-image-${eventIndex}-${imageIndex}`,
          label: attachment?.originalName ?? `Image jointe ${imageIndex + 1}`,
          reference: name,
          source: 'user',
          createdAt: eventCreatedAt(event),
        })
      })
      event.attachments?.forEach((attachment, attachmentIndex) => {
        if (imageNames.has(attachment.name)) return
        if (attachment.mimeType.startsWith('image/')) {
          addImage({
            kind: 'image',
            id: `attachment-image-${eventIndex}-${attachmentIndex}`,
            label: attachment.originalName,
            reference: attachment.name,
            source: 'user',
            createdAt: eventCreatedAt(event),
          })
          return
        }
        assets.push({
          kind: 'attachment',
          id: `attachment-${eventIndex}-${attachmentIndex}`,
          label: attachment.originalName,
          attachment,
          source: 'user',
          createdAt: eventCreatedAt(event),
        })
      })
      return
    }

    if (event.type === 'text-final') {
      markdownImages(event.text).forEach((image, imageIndex) => {
        addImage({
          kind: 'image',
          id: `assistant-image-${eventIndex}-${imageIndex}`,
          label: image.alt,
          reference: image.reference,
          source: 'assistant',
          createdAt: eventCreatedAt(event),
        })
      })
      return
    }

    if (event.type === 'tool-end') {
      event.images.forEach((name, imageIndex) => {
        addImage({
          kind: 'image',
          id: `tool-image-${eventIndex}-${imageIndex}`,
          label: 'Image produite',
          reference: name,
          source: 'assistant',
          createdAt: eventCreatedAt(event),
        })
      })
      return
    }

    if (event.type === 'html-document-ref' || event.type === 'document-ref') {
      assets.push({
        kind: 'document',
        id: `document-${eventIndex}-${event.documentId}`,
        label: event.title,
        documentId: event.documentId,
        documentKind: event.type === 'document-ref' ? event.kind : 'html',
        mimeType: event.mimeType ?? 'text/html',
        originalName: event.originalName ?? 'index.html',
        size: event.sizeBytes,
        createdAt: event.createdAt,
        source: 'assistant',
      })
    }
  })

  return assets
}

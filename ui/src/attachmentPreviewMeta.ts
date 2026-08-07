import type { Attachment } from './types'

export type AttachmentPreviewKind = 'text' | 'markdown' | 'json' | 'csv'

type AttachmentWithInlineContent = Attachment & {
  content?: unknown
}

function extensionOf(name: string): string {
  const normalizedName = name.trim().toLowerCase()
  const extension = normalizedName.split('.').pop()
  return extension === undefined || extension === normalizedName ? '' : extension
}

/**
 * Détermine si le type est affichable sans consulter la ressource distante.
 * Le suffixe sert de repli pour les pièces jointes dont le MIME est absent ou
 * générique, sans changer la forme du protocole backend.
 */
export function getAttachmentPreviewKind(
  attachment: Attachment,
): AttachmentPreviewKind | null {
  const mimeType = attachment.mimeType.trim().toLowerCase().split(';', 1)[0]
  if (mimeType === 'text/markdown' || mimeType === 'text/x-markdown') return 'markdown'
  if (mimeType === 'application/json' || mimeType === 'text/json' || mimeType.endsWith('+json')) return 'json'
  if (mimeType === 'text/csv' || mimeType === 'application/csv') return 'csv'
  if (mimeType.startsWith('text/')) return 'text'

  switch (extensionOf(attachment.originalName)) {
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'json':
      return 'json'
    case 'csv':
      return 'csv'
    case 'txt':
      return 'text'
    default:
      return null
  }
}

/**
 * Retourne uniquement le texte déjà attaché à l'objet en mémoire.
 * Il n'y a volontairement aucun fallback réseau ou filesystem ici.
 */
export function getAvailableAttachmentContent(attachment: Attachment): string | null {
  const candidate = attachment as AttachmentWithInlineContent
  return typeof candidate.content === 'string' ? candidate.content : null
}

export function formatAttachmentSize(size: number): string {
  const safeSize = Number.isFinite(size) ? Math.max(0, size) : 0
  if (safeSize < 1024) return `${Math.round(safeSize).toLocaleString('fr-FR')} o`
  if (safeSize < 1024 * 1024) {
    return `${(safeSize / 1024).toLocaleString('fr-FR', {
      maximumFractionDigits: 1,
    })} Ko`
  }
  return `${(safeSize / (1024 * 1024)).toLocaleString('fr-FR', {
    maximumFractionDigits: 1,
  })} Mo`
}

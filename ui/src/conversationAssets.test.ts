import { expect, test } from 'bun:test'
import type { AppEvent } from './types'
import { collectConversationAssets } from './conversationAssets'

test('collecte les pièces jointes et productions visuelles dans l’ordre des événements', () => {
  const events: AppEvent[] = [
    {
      type: 'user-message',
      text: 'Voici les sources',
      images: ['capture.png'],
      attachments: [
        { name: 'capture.png', originalName: 'capture.png', mimeType: 'image/png', size: 1200 },
        { name: 'brief.pdf', originalName: 'brief.pdf', mimeType: 'application/pdf', size: 4200 },
      ],
    },
    { type: 'text-final', text: 'Résultat : ![Maquette](/media/maquette.png)' },
    { type: 'tool-start', toolId: 'tool-1', toolName: 'imagegen', input: {} },
    { type: 'tool-end', toolId: 'tool-1', output: 'ok', images: ['generation.png'] },
    {
      type: 'document-ref',
      documentId: 'doc-1',
      title: 'Audit final',
      kind: 'pdf',
      mimeType: 'application/pdf',
      originalName: 'audit.pdf',
      sizeBytes: 9000,
      createdAt: '2026-08-31T10:00:00.000Z',
      expiresAt: null,
    },
  ]

  expect(collectConversationAssets(events).map((asset) => [asset.kind, asset.label])).toEqual([
    ['image', 'capture.png'],
    ['attachment', 'brief.pdf'],
    ['image', 'Maquette'],
    ['image', 'Image produite'],
    ['document', 'Audit final'],
  ])
})

test('conserve les images markdown externes et déduplique une image jointe dans le même message', () => {
  const events: AppEvent[] = [
    {
      type: 'user-message',
      text: '',
      images: ['capture.png'],
      attachments: [
        { name: 'capture.png', originalName: 'capture.png', mimeType: 'image/png', size: 1200 },
      ],
    },
    { type: 'text-final', text: '![Externe](https://example.com/image.png)' },
  ]

  expect(collectConversationAssets(events).map((asset) => asset.label)).toEqual([
    'capture.png',
    'Externe',
  ])
})

test('traite comme visuel une pièce jointe image absente du champ images', () => {
  const events: AppEvent[] = [{
    type: 'user-message',
    text: '',
    images: [],
    attachments: [
      { name: 'photo.webp', originalName: 'Photo.webp', mimeType: 'image/webp', size: 800 },
    ],
  }]

  expect(collectConversationAssets(events).map((asset) => asset.kind)).toEqual(['image'])
})

import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ConversationAsset } from './conversationAssets'
import { ConversationAssetsDrawer } from './ConversationAssetsDrawer'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')

afterEach(cleanup)

const assets: ConversationAsset[] = [
  {
    kind: 'image',
    id: 'image-1',
    label: 'Capture envoyée',
    reference: 'capture.png',
    source: 'user',
  },
  {
    kind: 'attachment',
    id: 'file-1',
    label: 'brief.txt',
    source: 'user',
    attachment: {
      name: 'brief.txt',
      originalName: 'brief.txt',
      mimeType: 'text/plain',
      size: 120,
    },
  },
  {
    kind: 'document',
    id: 'document-1',
    label: 'Audit final',
    documentId: 'document-1',
    documentKind: 'html',
    mimeType: 'text/html',
    originalName: 'audit.html',
    size: 4200,
    createdAt: '2026-09-15T12:34:00.000Z',
    source: 'assistant',
  },
]

test('ouvre le catalogue, annonce son compte et prévisualise une image', () => {
  let opened: [string, string] | null = null
  render(createElement(ConversationAssetsDrawer, {
    assets,
    open: false,
    onOpen: () => undefined,
    onClose: () => undefined,
    onImageOpen: (src: string, alt: string) => { opened = [src, alt] },
  }))

  expect(screen.getByRole('button', { name: 'Afficher les 3 pièces jointes' })).toBeTruthy()

  cleanup()
  render(createElement(ConversationAssetsDrawer, {
    assets,
    open: true,
    onOpen: () => undefined,
    onClose: () => undefined,
    onImageOpen: (src: string, alt: string) => { opened = [src, alt] },
  }))

  expect(screen.getByRole('dialog', { name: 'Pièces jointes' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Télécharger' })).toBeTruthy()
  expect(document.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-15T12:34:00.000Z')
  fireEvent.click(screen.getByRole('button', { name: 'Agrandir capture envoyée' }))
  expect(opened).toEqual(['/media/capture.png', 'Capture envoyée'])
})

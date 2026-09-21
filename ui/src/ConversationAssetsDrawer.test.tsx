import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ConversationAsset } from './conversationAssets'
import { ConversationAssetsDrawer } from './ConversationAssetsDrawer'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

const assets: ConversationAsset[] = [
  {
    kind: 'image',
    id: 'image-1',
    label: 'Capture envoyée',
    reference: 'capture.png',
    source: 'user',
    createdAt: '2026-09-15T12:34:00.000Z',
  },
  {
    kind: 'attachment',
    id: 'file-1',
    label: 'brief.txt',
    source: 'user',
    createdAt: '2026-09-15T12:34:00.000Z',
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
  expect(screen.getAllByText(/15 septembre/).length).toBeGreaterThanOrEqual(2)
  expect(document.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-15T12:34:00.000Z')
  expect(screen.getByRole('link', { name: 'Télécharger Capture envoyée' }).getAttribute('download')).toBe('Capture envoyée')
  fireEvent.click(screen.getByRole('button', { name: 'Agrandir capture envoyée' }))
  expect(opened).toEqual(['/media/capture.png', 'Capture envoyée'])
})

test('ouvre le document complet au lieu d’agrandir sa vignette', async () => {
  let imageOpened = false
  globalThis.fetch = mock(() => Promise.resolve(Response.json({
    token: 'preview-token',
    expiresAt: '2099-09-15T12:35:00.000Z',
  }, { status: 201 }))) as typeof fetch

  render(createElement(ConversationAssetsDrawer, {
    assets,
    open: true,
    onOpen: () => undefined,
    onClose: () => undefined,
    onImageOpen: () => { imageOpened = true },
  }))

  fireEvent.click(screen.getByRole('button', { name: 'Prévisualiser audit final' }))
  expect(await screen.findByRole('dialog', { name: 'Aperçu de Audit final' })).toBeTruthy()
  const iframe = await screen.findByTitle('Contenu de Audit final')
  expect(iframe.getAttribute('src')).toContain('/api/documents/document-1/content?token=preview-token')
  expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-modals')
  expect(imageOpened).toBe(false)
})

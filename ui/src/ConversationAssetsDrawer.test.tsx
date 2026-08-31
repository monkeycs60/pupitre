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

  expect(screen.getByRole('button', { name: 'Afficher les 2 pièces jointes' })).toBeTruthy()

  cleanup()
  render(createElement(ConversationAssetsDrawer, {
    assets,
    open: true,
    onOpen: () => undefined,
    onClose: () => undefined,
    onImageOpen: (src: string, alt: string) => { opened = [src, alt] },
  }))

  expect(screen.getByRole('dialog', { name: 'Pièces jointes' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Agrandir capture envoyée' }))
  expect(opened).toEqual(['/media/capture.png', 'Capture envoyée'])
})

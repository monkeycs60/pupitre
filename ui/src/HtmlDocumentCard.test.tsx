import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { HtmlDocumentBlock } from './groupEvents'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { HtmlDocumentCard } = await import('./HtmlDocumentCard')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  window.sessionStorage.clear()
})

const block: HtmlDocumentBlock = {
  kind: 'html-document',
  id: 'html-document-1',
  documentId: 'document-1',
  title: 'Audit plateforme',
  summary: 'Décisions et priorités',
  sizeBytes: 12_480,
  createdAt: '2026-08-10T10:00:00.000Z',
  expiresAt: null,
}

test('ouvre le dernier document dans un iframe doublement sandboxé', async () => {
  let tokenCount = 0
  globalThis.fetch = mock((input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/view-token')) {
      tokenCount += 1
      return Promise.resolve(Response.json({ token: `token-${tokenCount}`, expiresAt: '2099-08-11T10:01:00.000Z' }, { status: 201 }))
    }
    return Promise.resolve(Response.json({
      id: 'document-1',
      conversationId: 'conversation-1',
      title: 'Audit plateforme',
      summary: 'Décisions et priorités',
      sizeBytes: 12_480,
      sha256: 'hash',
      createdAt: block.createdAt,
      expiresAt: block.expiresAt,
      retainedAt: block.createdAt,
      expiredAt: null,
      deletedAt: null,
      state: 'retained',
    }))
  }) as typeof fetch

  render(createElement(HtmlDocumentCard, { block, defaultOpen: true }))

  const iframe = await screen.findByTitle('Aperçu de Audit plateforme')
  expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-modals')
  expect(iframe.getAttribute('src')).toContain('/api/documents/document-1/content?token=token-1')
  expect(screen.queryByRole('textbox', { name: 'Modifier Audit plateforme' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Modifier' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Conserver' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Supprimer' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Télécharger' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Modifier' }))
  expect(await screen.findByRole('textbox', { name: 'Modifier Audit plateforme' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Plein écran' }))
  expect(await screen.findByRole('dialog', { name: 'Document HTML Audit plateforme' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Réduire' })).toBeTruthy()
  expect(screen.getByTitle('Aperçu de Audit plateforme').getAttribute('src')).toContain('token=token-2')
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTitle('Aperçu de Audit plateforme').getAttribute('src')).toContain('token=token-3')

  fireEvent.click(screen.getByRole('button', { name: 'Plein écran' }))
  expect(await screen.findByRole('dialog', { name: 'Document HTML Audit plateforme' })).toBeTruthy()
  expect(screen.getByTitle('Aperçu de Audit plateforme').getAttribute('src')).toContain('token=token-4')
}, 60_000);

test('rend une tombstone sans action lorsque le contenu a expiré', async () => {
  globalThis.fetch = mock(() => Promise.resolve(Response.json({
    id: 'document-1',
    conversationId: 'conversation-1',
    title: 'Audit plateforme',
    summary: null,
    sizeBytes: 12_480,
    sha256: 'hash',
    createdAt: block.createdAt,
    expiresAt: '2026-08-11T10:00:00.000Z',
    retainedAt: null,
    expiredAt: '2026-08-11T10:00:00.000Z',
    deletedAt: null,
    state: 'expired',
  }))) as typeof fetch

  render(createElement(HtmlDocumentCard, { block, defaultOpen: false }))

  expect(await screen.findByText('Le contenu a été supprimé automatiquement après 24 heures.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Ouvrir ↗' })).toBeNull()
  expect(screen.queryByTitle('Aperçu de Audit plateforme')).toBeNull()
});

test('affiche un document CSV sous forme de tableau', async () => {
  globalThis.fetch = mock((input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/view-token')) {
      return Promise.resolve(Response.json({ token: 'token-1', expiresAt: '2099-08-11T10:01:00.000Z' }, { status: 201 }))
    }
    if (url.includes('/content?token=')) return Promise.resolve(new Response('name,city\nAlice,Paris\nBob,Lyon'))
    return Promise.resolve(Response.json({
      id: 'document-1', conversationId: 'conversation-1', title: 'Contacts', summary: null,
      kind: 'csv', mimeType: 'text/csv', originalName: 'contacts.csv', sizeBytes: 40, sha256: 'hash',
      createdAt: block.createdAt, expiresAt: null, retainedAt: block.createdAt, expiredAt: null,
      deletedAt: null, state: 'retained',
    }))
  }) as typeof fetch

  render(createElement(HtmlDocumentCard, { block: { ...block, documentKind: 'csv' }, defaultOpen: true }))

  expect(await screen.findByRole('columnheader', { name: 'name' })).toBeTruthy()
  expect(screen.getByRole('cell', { name: 'Paris' })).toBeTruthy()
  expect(screen.getByText('2 lignes')).toBeTruthy()
  expect(screen.queryByTitle('Aperçu de Contacts')).toBeNull()
})

test('agrandit une image envoyée par l’aperçu et se ferme avec Échap', async () => {
  globalThis.fetch = mock((input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/view-token')) {
      return Promise.resolve(Response.json({ token: 'token-zoom', expiresAt: '2099-08-11T10:01:00.000Z' }, { status: 201 }))
    }
    return Promise.resolve(Response.json({
      id: 'document-1',
      conversationId: 'conversation-1',
      title: 'Audit plateforme',
      sizeBytes: 12_480,
      sha256: 'hash',
      createdAt: block.createdAt,
      expiresAt: null,
      state: 'retained',
    }))
  }) as typeof fetch

  render(createElement(HtmlDocumentCard, { block, defaultOpen: true }))
  const iframe = await screen.findByTitle('Aperçu de Audit plateforme') as HTMLIFrameElement
  expect(iframe.getAttribute('src')).toContain('&embed=1')

  const src = 'data:image/png;base64,iVBORw0KGgo='
  const video = 'data:video/webm;base64,GkXfow=='
  const send = (data: unknown, source: MessageEventSource | null) => {
    window.dispatchEvent(new MessageEvent('message', { data, source }))
  }
  send({ type: 'pupitre:media-zoom', index: 0, items: [{ kind: 'image', src: 'https://exemple.test/a.png' }] }, iframe.contentWindow)
  send({ type: 'pupitre:media-zoom', index: 0, items: [{ kind: 'image', src, alt: 'Capture avant' }] }, window)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(screen.queryByRole('dialog', { name: 'Image agrandie' })).toBeNull()

  send({
    type: 'pupitre:media-zoom',
    index: 2,
    items: [
      { kind: 'image', src, alt: 'Capture avant' },
      { kind: 'image', src: 'https://exemple.test/b.png', alt: 'Distante' },
      { kind: 'image', src, alt: 'Capture après' },
      { kind: 'video', src: video, alt: 'Parcours', time: 3 },
    ],
  }, iframe.contentWindow)
  await screen.findByRole('dialog', { name: 'Image agrandie' })
  expect(screen.getByAltText('Capture après').getAttribute('src')).toBe(src)
  expect(screen.getByText('2 / 3')).toBeTruthy()

  fireEvent.keyDown(window, { key: 'ArrowRight' })
  expect(await screen.findByRole('dialog', { name: 'Vidéo agrandie' })).toBeTruthy()
  expect(screen.getByText('3 / 3')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Média suivant' }))
  expect(screen.getByAltText('Capture avant')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Média précédent' }))
  expect(screen.getByText('3 / 3')).toBeTruthy()

  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Vidéo agrandie' })).toBeNull())
  expect(screen.getByTitle('Aperçu de Audit plateforme')).toBeTruthy()
}, 60_000)

test('compare côte à côte la vidéo avant et la vidéo après', async () => {
  globalThis.fetch = mock((input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/view-token')) {
      return Promise.resolve(Response.json({ token: 'token-compare', expiresAt: '2099-08-11T10:01:00.000Z' }, { status: 201 }))
    }
    return Promise.resolve(Response.json({
      id: 'document-1',
      conversationId: 'conversation-1',
      title: 'Audit plateforme',
      sizeBytes: 12_480,
      sha256: 'hash',
      createdAt: block.createdAt,
      expiresAt: null,
      state: 'retained',
    }))
  }) as typeof fetch

  render(createElement(HtmlDocumentCard, { block, defaultOpen: true }))
  const iframe = await screen.findByTitle('Aperçu de Audit plateforme') as HTMLIFrameElement
  const video = 'data:video/mp4;base64,AAAAIGZ0eXA='
  window.dispatchEvent(new MessageEvent('message', {
    source: iframe.contentWindow,
    data: {
      type: 'pupitre:media-zoom',
      index: 1,
      items: [
        { kind: 'video', src: video, alt: 'avant · parcours' },
        { kind: 'video', src: video, alt: 'après · parcours' },
        { kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'capture' },
      ],
    },
  }))
  await screen.findByRole('dialog', { name: 'Vidéo agrandie' })

  fireEvent.click(screen.getByRole('button', { name: '⇆ Côte à côte' }))
  const dialog = await screen.findByRole('dialog', { name: 'Vidéos côte à côte' })
  expect(dialog.querySelectorAll('video')).toHaveLength(2)
  expect([...dialog.querySelectorAll('figcaption')].map((caption) => caption.textContent)).toEqual(['avant · parcours', 'après · parcours'])
  expect(screen.getByText('1–2 / 3')).toBeTruthy()
  expect(screen.getByRole('slider', { name: 'Position dans les deux vidéos' })).toBeTruthy()

  fireEvent.keyDown(window, { key: 'ArrowRight' })
  expect(await screen.findByRole('dialog', { name: 'Image agrandie' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '⇆ Côte à côte' })).toBeNull()
}, 60_000)

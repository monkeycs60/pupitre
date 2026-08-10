import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { HtmlDocumentBlock } from './groupEvents'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
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
  globalThis.fetch = mock((input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/view-token')) {
      return Promise.resolve(Response.json({ token: 'token-1', expiresAt: '2099-08-11T10:01:00.000Z' }, { status: 201 }))
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
  expect(screen.queryByRole('button', { name: 'Conserver' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Supprimer' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Plein écran' }))
  expect(screen.getByRole('dialog', { name: 'Document HTML Audit plateforme' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Réduire' })).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
});

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

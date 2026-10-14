import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { groupEvents } from './groupEvents'
import { INTERRUPTED_BY_RESTART } from './turnError'
import type { AppEvent } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { EventView } = await import('./EventView')

const realFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

function footerOf(events: AppEvent[]) {
  const footer = groupEvents(events).findLast((block) => block.kind === 'turn-footer')
  if (footer?.kind !== 'turn-footer') throw new Error('pied de tour absent')
  return footer
}

const asked: AppEvent = {
  type: 'user-message',
  text: 'lance la stack',
  images: ['capture.png'],
  attachments: [{ name: 'a.pdf', originalName: 'A.pdf', mimeType: 'application/pdf', size: 3 }],
}

test('un tour interrompu par un redémarrage propose de renvoyer son message à l’identique', async () => {
  const requests: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return new Response(null, { status: 202 })
  }) as unknown as typeof fetch
  const footer = footerOf([asked, { type: 'status', state: 'error', error: INTERRUPTED_BY_RESTART }])
  render(createElement(EventView, { block: footer, onImageOpen: () => {}, onImageLoad: () => {}, resendConversationId: 'conv-1' }))

  fireEvent.click(screen.getByRole('button', { name: 'Renvoyer ce message' }))

  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]!.url).toContain('/api/conversations/conv-1/messages')
  expect(requests[0]!.body).toEqual({
    message: 'lance la stack',
    images: ['capture.png'],
    attachments: [{ name: 'a.pdf', originalName: 'A.pdf', mimeType: 'application/pdf', size: 3 }],
  })
})

test('aucun renvoi pour une annulation volontaire ni pour un tour plus ancien', () => {
  const cancelled = footerOf([asked, { type: 'status', state: 'error', error: 'annulé' }])
  render(createElement(EventView, { block: cancelled, onImageOpen: () => {}, onImageLoad: () => {}, resendConversationId: 'conv-1' }))
  expect(screen.queryByRole('button', { name: 'Renvoyer ce message' })).toBeNull()
  cleanup()

  const interrupted = footerOf([asked, { type: 'status', state: 'error', error: INTERRUPTED_BY_RESTART }])
  render(createElement(EventView, { block: interrupted, onImageOpen: () => {}, onImageLoad: () => {} }))
  expect(screen.queryByRole('button', { name: 'Renvoyer ce message' })).toBeNull()
})

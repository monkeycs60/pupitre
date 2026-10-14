import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ConversationMentionText, splitConversationMentions } = await import('./ConversationMentionText')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

test('découpe les mentions sans toucher aux crochets ordinaires ni aux espaces', () => {
  expect(splitConversationMentions('Reprends @[Refonte du checkout] puis tableau[0]')).toEqual([
    'Reprends ',
    { title: 'Refonte du checkout' },
    ' puis tableau[0]',
  ])
})

test('ouvre la conversation citée par son titre', async () => {
  globalThis.fetch = (async () => Response.json([
    { id: 'conv-v2', project_id: 'p', project_name: 'affilae-mono', title: 'Refonte du checkout v2', updated_at: '2026-10-14' },
    { id: 'conv-1', project_id: 'p', project_name: 'affilae-mono', title: 'Refonte du checkout', updated_at: '2026-10-13' },
  ])) as unknown as typeof fetch
  const opened: string[] = []
  const listener = (event: Event) => opened.push((event as CustomEvent<{ conversationId: string }>).detail.conversationId)
  window.addEventListener('pupitre:open-conversation', listener)
  try {
    render(createElement(ConversationMentionText, { text: 'Voir @[Refonte du checkout].' }))
    fireEvent.click(screen.getByRole('button', { name: '@Refonte du checkout' }))
    await waitFor(() => expect(opened).toEqual(['conv-1']))
  } finally {
    window.removeEventListener('pupitre:open-conversation', listener)
  }
})

test('barre une mention dont la conversation n’existe plus', async () => {
  globalThis.fetch = (async () => Response.json([])) as unknown as typeof fetch
  render(createElement(ConversationMentionText, { text: '@[Disparue]' }))
  fireEvent.click(screen.getByRole('button', { name: '@Disparue' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '@Disparue' }).className).toContain('is-missing'))
})

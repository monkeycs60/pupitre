import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { NudgeStack } = await import('./NudgeStack')
const originalFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

const nudge = (id: string, conversationId: string) => ({
  id,
  conversation_id: conversationId,
  project_id: 'p1',
  project_name: 'Pupitre',
  conversation_title: 'Veille',
  kind: 'choice',
  title: 'Qui committe ?',
  body: 'Le chantier est prêt.',
  actions: [
    { label: "L'agent committe", message: "Réponse à « Qui réalise le commit » : l'agent committe" },
    { label: 'Clément committe', message: 'Réponse à « Qui réalise le commit » : Clément committe' },
  ],
  created_at: '2026-10-19T10:00:00.000Z',
})

test('un clic envoie la réponse à l’autre conversation puis ferme la notification', async () => {
  const calls: { url: string; body?: unknown }[] = []
  globalThis.fetch = (async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : undefined })
    if (String(url).endsWith('/api/nudges')) return Response.json([nudge('n1', 'c2'), nudge('n2', 'c1')])
    return new Response(null, { status: String(url).includes('/messages') ? 202 : 204 })
  }) as typeof fetch
  render(<NudgeStack hiddenConversationId="c1" onOpen={() => {}} />)
  await waitFor(() => expect(document.querySelectorAll('.nudge')).toHaveLength(1))

  fireEvent.click(screen.getByRole('button', { name: 'Clément committe' }))
  await waitFor(() => expect(screen.getByText('Envoyé : Clément committe')).toBeTruthy())
  expect(calls.slice(1)).toEqual([
    { url: expect.stringContaining('/api/conversations/c2/messages'), body: { message: 'Réponse à « Qui réalise le commit » : Clément committe' } },
    { url: expect.stringContaining('/api/nudges/n1/close'), body: {} },
  ])
})

test('un envoi refusé garde la notification et montre l’erreur', async () => {
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('/api/nudges')) return Response.json([nudge('n1', 'c2')])
    return Response.json({ error: 'conversation occupée' }, { status: 409 })
  }) as typeof fetch
  render(<NudgeStack onOpen={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: "L'agent committe" }))
  await waitFor(() => expect(screen.getByText('conversation occupée')).toBeTruthy())
  expect(document.querySelectorAll('.nudge')).toHaveLength(1)
})

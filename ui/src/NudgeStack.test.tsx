import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { NudgeStack } = await import('./NudgeStack')
const { useConversationNudges } = await import('./useConversationNudges')

function Stack({ hiddenConversationId }: { hiddenConversationId?: string }) {
  const nudges = useConversationNudges()
  return <NudgeStack nudges={nudges} hiddenConversationId={hiddenConversationId} onOpen={() => {}} />
}
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
  parked: null as 'dismissed' | 'snoozed' | null,
  snoozed_until: null as string | null,
})

test('un clic envoie la réponse à l’autre conversation puis ferme la notification', async () => {
  const calls: { url: string; body?: unknown }[] = []
  globalThis.fetch = (async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : undefined })
    if (String(url).endsWith('/api/nudges')) return Response.json([nudge('n1', 'c2'), nudge('n2', 'c1')])
    return new Response(null, { status: String(url).includes('/messages') ? 202 : 204 })
  }) as typeof fetch
  render(<Stack hiddenConversationId="c1" />)
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
  render(<Stack />)
  fireEvent.click(await screen.findByRole('button', { name: "L'agent committe" }))
  await waitFor(() => expect(screen.getByText('conversation occupée')).toBeTruthy())
  expect(document.querySelectorAll('.nudge')).toHaveLength(1)
})

test('« Dans 30 min » range la carte et demande le rappel au sidecar', async () => {
  const calls: { url: string; body?: unknown }[] = []
  globalThis.fetch = (async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : undefined })
    if (String(url).endsWith('/api/nudges')) return Response.json([nudge('n1', 'c2')])
    return new Response(null, { status: 204 })
  }) as typeof fetch
  render(<Stack />)
  fireEvent.click(await screen.findByRole('button', { name: 'Dans 30 min' }))
  await waitFor(() => expect(document.querySelectorAll('.nudge')).toHaveLength(0))
  expect(calls.at(-1)).toEqual({ url: expect.stringContaining('/api/nudges/n1/snooze'), body: { minutes: 30 } })
})

test('la pile montre une seule carte, son épaisseur et passe à la suivante après ×', async () => {
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('/api/nudges')) return Response.json([nudge('n1', 'c1'), nudge('n2', 'c2'), nudge('n3', 'c3')])
    return new Response(null, { status: 204 })
  }) as typeof fetch
  render(<Stack />)
  await waitFor(() => expect(document.querySelector('.nudge')?.getAttribute('data-id')).toBe('n1'))
  expect(document.querySelectorAll('.nudge')).toHaveLength(1)
  expect(document.querySelectorAll('.nudge-layer')).toHaveLength(2)
  expect(document.querySelector('.nudge-count')?.textContent).toBe('3')

  fireEvent.click(screen.getByRole('button', { name: 'Ignorer' }))
  await waitFor(() => expect(document.querySelector('.nudge')?.getAttribute('data-id')).toBe('n2'))
  expect(document.querySelectorAll('.nudge-layer')).toHaveLength(1)
})

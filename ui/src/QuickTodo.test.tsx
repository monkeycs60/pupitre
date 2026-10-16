import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { QuickTodo } = await import('./QuickTodo')
const originalFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

test('Entrée empile la tâche pour la conversation et referme le champ', async () => {
  const calls: { url: string; body: unknown }[] = []
  globalThis.fetch = (async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(String(options?.body)) })
    return Response.json({ id: 't1', title: 'Revoir le cache', project: 'Pupitre' }, { status: 201 })
  }) as typeof fetch
  render(<QuickTodo conversationId="c1" />)
  fireEvent.click(screen.getByRole('button', { name: 'Ajouter une tâche' }))
  const field = screen.getByRole('textbox', { name: 'Description de la tâche' })
  fireEvent.change(field, { target: { value: '  Revoir le cache  ' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Ajoutée : Revoir le cache'))
  expect(calls).toEqual([{ url: expect.stringContaining('/api/todo-inbox'), body: { conversationId: 'c1', message: 'Revoir le cache' } }])
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('un échec garde le texte saisi et affiche l’erreur', async () => {
  globalThis.fetch = (async () => Response.json({ error: 'projet Pupitre introuvable' }, { status: 404 })) as typeof fetch
  render(<QuickTodo conversationId="c1" />)
  fireEvent.click(screen.getByRole('button', { name: 'Ajouter une tâche' }))
  const field = screen.getByRole('textbox', { name: 'Description de la tâche' }) as HTMLTextAreaElement
  fireEvent.change(field, { target: { value: 'Tâche' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('projet Pupitre introuvable'))
  expect(field.value).toBe('Tâche')
})

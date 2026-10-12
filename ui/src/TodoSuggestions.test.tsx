import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { TodoItem } from './todos'

if (typeof document === 'undefined') GlobalRegistrator.register()
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { TodoSuggestions } = await import('./TodoSuggestions')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('une suggestion se garde ou s’écarte depuis le fil de la conversation', async () => {
  const urls: string[] = []
  globalThis.fetch = (async (url) => { urls.push(String(url)); return Response.json({}) }) as typeof fetch
  let changed = 0
  const items = ['A', 'B'].map((id) => ({ id, title: id, message: id, proposed: true }) as TodoItem)
  render(<TodoSuggestions items={items} onChanged={() => { changed += 1 }} />)
  expect(document.querySelectorAll('.todo-suggestions li').length).toBe(2)
  fireEvent.click(screen.getAllByRole('button', { name: 'Garder' })[0]!)
  await waitFor(() => expect(urls).toEqual(['/api/todos/A/accept']))
  fireEvent.click(screen.getAllByRole('button', { name: 'Écarter' })[0]!)
  await waitFor(() => expect(urls.at(-1)).toBe('/api/todos/B'))
  await waitFor(() => expect(changed).toBe(2), { timeout: 3000 })
})

test('la portée suggérée se corrige avant de garder', async () => {
  const calls: { url: string; body: unknown }[] = []
  globalThis.fetch = (async (url, options) => { calls.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : undefined }); return Response.json({}) }) as typeof fetch
  const links = new Map([['t1', { ticketKey: 'TECH-1', title: 'Un ticket', externalUrl: null, mergeRequestUrl: null, branch: null }]])
  render(<TodoSuggestions items={[{ id: 'A', title: 'A', message: 'A', proposed: true, ticket_id: null, target_branch: 'develop' } as TodoItem]} ticketLinks={links} onChanged={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Changer' }))
  fireEvent.change(screen.getByLabelText('Ticket'), { target: { value: 't1' } })
  fireEvent.change(screen.getByLabelText('Branche cible'), { target: { value: 'feature/x' } })
  fireEvent.click(screen.getByRole('button', { name: 'OK' }))
  await waitFor(() => expect(calls[0]).toEqual({ url: '/api/todos/A', body: { ticketId: 't1', targetBranch: 'feature/x' } }))
  await waitFor(() => expect(document.querySelector('.todo-suggestion-scope')?.textContent).toContain('TECH-1'))
  expect(document.querySelector('.todo-suggestion-scope')?.textContent).toContain('sur feature/x')
})

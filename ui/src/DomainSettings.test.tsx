import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ProjectDomain } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { DomainSettings } = await import('./DomainSettings')
const defaultFetch = globalThis.fetch

const proposed: ProjectDomain = {
  id: 'd-proposed',
  project_id: 'p1',
  name: 'Match AI',
  kind: 'métier',
  status: 'proposé',
  created_at: '2026-08-23T08:00:00.000Z',
  updated_at: '2026-08-23T08:00:00.000Z',
}

const active: ProjectDomain = {
  ...proposed,
  id: 'd-active',
  name: 'API',
  kind: 'technique',
  status: 'actif',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

test('une proposition n’apparaît pas comme label actif tant qu’elle n’est pas validée', async () => {
  const calls: string[] = []
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    calls.push(`${method} ${url}`)
    if (url.endsWith('/api/projects/p1/domains') && method === 'GET') {
      return json(calls.some((call) => call.includes('/validate')) ? [{ ...proposed, status: 'actif' }, active] : [proposed, active])
    }
    if (url.endsWith('/api/projects/p1/domains/d-proposed/validate') && method === 'POST') {
      return json({ ...proposed, status: 'actif' })
    }
    throw new Error(`route inattendue: ${method} ${url}`)
  }) as typeof fetch

  render(createElement(DomainSettings, { projectId: 'p1' }))
  expect(await screen.findByText('Proposés')).toBeTruthy()
  expect(screen.getByText('Actifs')).toBeTruthy()
  const proposedRow = screen.getByText('Match AI').closest('.project-domain-row')
  expect(proposedRow?.getAttribute('data-status')).toBe('proposé')
  expect(proposedRow?.textContent).toContain('Valider')
  const activeRow = screen.getByText('API').closest('.project-domain-row')
  expect(activeRow?.getAttribute('data-status')).toBe('actif')
  expect(activeRow?.textContent).not.toContain('Valider')

  fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
  await waitFor(() => expect(document.querySelectorAll('[data-status="proposé"]').length).toBe(0))
  expect(document.querySelectorAll('[data-status="actif"]').length).toBe(2)
})

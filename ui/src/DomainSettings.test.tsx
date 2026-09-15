import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ProjectDomain } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen } = await import('@testing-library/react')
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

test('les réglages ne présentent que les domaines ajoutés manuellement', async () => {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/api/projects/p1/domains')) return json([proposed, active])
    throw new Error(`route inattendue: ${url}`)
  }) as typeof fetch

  render(createElement(DomainSettings, { projectId: 'p1' }))
  expect(await screen.findByText('Actifs')).toBeTruthy()
  expect(screen.queryByText('Proposés')).toBeNull()
  expect(screen.queryByText('Match AI')).toBeNull()
  const activeRow = screen.getByText('API').closest('.project-domain-row')
  expect(activeRow?.getAttribute('data-status')).toBe('actif')
})

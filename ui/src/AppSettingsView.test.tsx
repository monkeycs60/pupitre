import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { AppSettingsView } = await import('./AppSettingsView')
const defaultFetch = globalThis.fetch

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

test('enregistre puis efface un token d’intégration sans jamais le relire', async () => {
  const writes: Array<Record<string, unknown>> = []
  let settings = {
    filesystemScope: 'project-and-ai-roots',
    actionFormat: {
      enabled: true,
      todoHeadings: ['TODO'],
      followUpHeadings: ['FOLLOW-UP'],
    },
    integrationTokens: {} as Record<string, boolean>,
  }

  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (!url.endsWith('/api/settings')) throw new Error(`route inattendue: ${method} ${url}`)
    if (method === 'GET') return json(settings)

    const body = JSON.parse(String(init?.body ?? '{}')) as {
      integrationTokens?: Partial<Record<'clickup' | 'gitlab', string | null>>
    }
    writes.push(body)
    const patch = body.integrationTokens ?? {}
    const nextTokens = { ...settings.integrationTokens }
    for (const [name, value] of Object.entries(patch)) {
      if (typeof value === 'string' && value.length > 0) nextTokens[name] = true
      if (value === null || value === '') delete nextTokens[name]
    }
    settings = { ...settings, integrationTokens: nextTokens }
    return json(settings)
  }) as typeof fetch

  render(createElement(AppSettingsView))

  const clickupInput = await screen.findByLabelText('Token ClickUp')
  expect(screen.getByLabelText('Statut token ClickUp').textContent).toContain('non défini')

  fireEvent.change(clickupInput, { target: { value: 'pk_secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer les tokens' }))

  await waitFor(() => expect(writes).toContainEqual({ integrationTokens: { clickup: 'pk_secret' } }))
  expect(screen.getByLabelText('Statut token ClickUp').textContent).toContain('défini')
  expect((clickupInput as HTMLInputElement).value).toBe('')
  expect(document.body.textContent).not.toContain('pk_secret')

  fireEvent.click(screen.getByRole('button', { name: 'Effacer le token ClickUp' }))

  await waitFor(() => expect(writes).toContainEqual({ integrationTokens: { clickup: null } }))
  expect(screen.getByLabelText('Statut token ClickUp').textContent).toContain('non défini')
})

import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import type { Project } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ProjectSettingsDialog } = await import('./ProjectSettingsDialog')
const dialogsCss = readFileSync(new URL('./styles/dialogs.css', import.meta.url), 'utf8')
const defaultFetch = globalThis.fetch

const project: Project = {
  id: 'p1',
  name: 'mono',
  path: '/tmp/mono',
  permission_mode: 'default',
  filesystem_scope: 'project-and-ai-roots',
  pinned: false,
  created_at: '2026-08-19T08:00:00.000Z',
  default_preset_id: null,
  default_review_preset_id: null,
  default_correction_preset_id: null,
  auto_rescan: true,
}

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

test('enregistre une intégration GitLab avec son motif de branche', async () => {
  const calls: Array<{ url: string; body: unknown }> = []

  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (url.endsWith('/api/presets')) return json([])
    if (url.endsWith('/api/projects/p1/mcp-servers')) {
      return json({ servers: [], enabled: [], weights: {}, used: [] })
    }
    if (url.endsWith('/api/projects/p1/integrations') && method === 'GET') return json([])
    if (url.endsWith('/api/projects/p1/filesystem-scope')) return json(project)
    if (url.endsWith('/api/projects/p1/default-review-preset')) return json(project)
    if (url.endsWith('/api/projects/p1/default-correction-preset')) return json(project)
    if (url.endsWith('/api/projects/p1/integrations/gitlab') && method === 'PUT') {
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      return json({
        id: 'gitlab-1',
        project_id: 'p1',
        type: 'gitlab',
        config: { host: 'https://git.example', projects: [] },
        branch_pattern: '^(issue|feature)/(TECH-\\d+)',
        status: 'non configurée',
        last_ok_at: null,
        last_error: null,
        created_at: '2026-08-19T08:00:00.000Z',
        updated_at: '2026-08-19T08:00:00.000Z',
      })
    }
    throw new Error(`route inattendue: ${method} ${url}`)
  }) as typeof fetch

  render(createElement(ProjectSettingsDialog, {
    project,
    onClose: () => {},
    onUpdated: () => {},
  }))

  fireEvent.click(await screen.findByLabelText('Activer GitLab'))
  fireEvent.change(screen.getByLabelText('Hôte GitLab'), { target: { value: 'https://git.example' } })
  fireEvent.change(screen.getByLabelText('Motif de branche'), { target: { value: '^(issue|feature)/(TECH-\\d+)' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))

  await waitFor(() => expect(calls).toHaveLength(1))
  const saved = calls[0]!.body as {
    config: { host: string }
    branchPattern: string
  }
  expect(saved.config.host).toBe('https://git.example')
  expect(saved.branchPattern).toBe('^(issue|feature)/(TECH-\\d+)')
})

test('le corps des paramètres projet défile sans masquer les actions', () => {
  expect(dialogsCss).toMatch(/\.project-settings-body\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/)
})

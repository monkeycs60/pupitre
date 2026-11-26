import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { JarvisJob } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { Jarvis } = await import('./Jarvis')

const defaultFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

const preview = {
  conversationId: 'c1',
  projectId: 'p1',
  projectName: 'pupitre',
  title: 'Menu contexte : copier et continuer',
  reason: 'Décrit le menu « Continuer ailleurs ».',
  score: 92,
}

function job(status: JarvisJob['status'], answer: JarvisJob['answer'] = null): JarvisJob {
  return {
    id: 'j1',
    status,
    steps: [{ id: 's1', label: 'Qwen 3.8 rédige la réponse', detail: null, state: status === 'running' ? 'running' : 'done', at: new Date().toISOString() }],
    route: { model: 'qwen-3.8', effort: 'high', label: 'Qwen 3.8 · Cerebras', reason: 'Qwen 3.8 répond.', escalated: false, by: 'fast' },
    preview: [preview],
    answer,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: status === 'running' ? null : new Date().toISOString(),
  }
}

function stubJarvis(jobs: JarvisJob[]) {
  let polls = 0
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/jarvis/ask')) return Response.json({ jobId: 'j1' }, { status: 202 })
    if (url.endsWith('/api/jarvis/jobs/j1')) return Response.json(jobs[Math.min(polls++, jobs.length - 1)])
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
}

function renderJarvis(open: boolean, openConversation = mock(async () => {})) {
  const onOpenChange = mock(() => {})
  const context = { openConversation, refreshConversations: () => {}, resolveTicketId: async () => null }
  render(<Jarvis open={open} onOpenChange={onOpenChange} projectId="p1" conversationId={null} context={context} />)
  return { onOpenChange, openConversation }
}

function ask(question: string) {
  const input = screen.getByLabelText('Question pour Jarvis')
  fireEvent.change(input, { target: { value: question } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

test('fermé, Jarvis ne montre que sa bulle, qui ouvre le panneau', () => {
  stubJarvis([])
  const { onOpenChange } = renderJarvis(false)

  expect(screen.queryByRole('dialog', { name: 'Jarvis' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Jarvis' }))
  expect(onOpenChange).toHaveBeenCalledWith(true)
})

test('les conversations proches s’ouvrent avec leur certitude avant la fin de la réponse', async () => {
  stubJarvis([job('running')])
  const { onOpenChange, openConversation } = renderJarvis(true)
  ask('le menu continuer ailleurs')

  const card = await waitFor(() => screen.getByRole('button', { name: /Menu contexte : copier et continuer/ }), { timeout: 3000 })
  expect(card.textContent).toContain('92 %')
  expect(card.closest('.jarvis-preview')).not.toBeNull()
  fireEvent.click(card)
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(openConversation).toHaveBeenCalledWith('p1', 'c1', [])
})

test('la réponse remplace l’aperçu et garde la certitude de chaque résultat', async () => {
  stubJarvis([job('running'), job('done', {
    text: 'C’est la conversation sur le menu.',
    results: [{
      conversationId: 'c1', projectId: 'p1', projectName: 'pupitre', title: preview.title, status: 'idle',
      ticketKey: null, branch: null, updatedAt: new Date().toISOString(), reason: 'Le menu y est conçu.', score: 92, events: [],
    }],
    actions: [],
    durationMs: 2100,
  })])
  renderJarvis(true)
  ask('le menu continuer ailleurs')

  await waitFor(() => screen.getByText('C’est la conversation sur le menu.'), { timeout: 4000 })
  expect(document.querySelector('.jarvis-preview')).toBeNull()
  const results = [...document.querySelectorAll('.jarvis-result')]
  expect(results).toHaveLength(1)
  expect(results[0]!.querySelector('.jarvis-certainty')?.textContent).toBe('92 %')
})

test('la trace annonce le coût facturé et le détaille appel par appel', async () => {
  const done = job('done', { text: 'Personne ne t’attend.', results: [], actions: [], durationMs: 2100 })
  done.costs = [
    { label: 'Recherche · classement par gpt-oss-120b', inputTokens: 4000, outputTokens: 300, usd: 0.001625, billing: 'api' },
    { label: 'Qwen 3.8 · réponse', inputTokens: 8000, outputTokens: 400, usd: 0.008516, billing: 'api' },
    { label: 'Opus 5.5 · plan', inputTokens: 12, outputTokens: 900, usd: 0.21, billing: 'subscription' },
  ]
  stubJarvis([done])
  renderJarvis(true)
  ask('qui m’attend ?')

  const toggle = await waitFor(() => screen.getByRole('button', { name: /Ce que j’ai fait/ }), { timeout: 4000 })
  expect(toggle.textContent).toContain('2,1 s · 0,01 $')
  fireEvent.click(toggle)
  const list = screen.getByLabelText('Coût de la demande')
  expect(list.querySelector('.jarvis-costs-head')?.textContent).toBe('Coût · 0,01 $ facturés')
  const lines = [...list.querySelectorAll('li')].map((line) => [
    line.querySelector('.jarvis-cost-label')?.textContent,
    line.querySelector('.jarvis-cost-usd')?.textContent,
  ])
  expect(lines).toEqual([
    ['Recherche · classement par gpt-oss-120b', '0,0016 $'],
    ['Qwen 3.8 · réponse', '0,0085 $'],
    ['Opus 5.5 · plan', '≈ 0,21 $ · abonnement'],
  ])
})

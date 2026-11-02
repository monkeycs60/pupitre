import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { JarvisAnswer, JarvisAskInput, JarvisJob, JarvisRoute } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const { Jarvis } = await import('./Jarvis')

const defaultFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

const JEV_ROUTE: JarvisRoute = { model: 'jev', effort: null, label: 'Jev · sans Claude', reason: 'Recherche reconnue à 93 %, conversation désignée à 82 %.', escalated: false, by: 'router' }
const LOCAL_ROUTE: JarvisRoute = { model: 'local', effort: null, label: 'État de Pupitre', reason: 'Réponse tirée de l’état de Pupitre : aucun modèle appelé.', escalated: false, by: 'shortcut' }
const HAIKU_ROUTE: JarvisRoute = { model: 'haiku-5.5', effort: 'high', label: 'Haiku 5.5 · rapide', reason: 'Mode rapide demandé : Haiku 5.5 répond seul.', escalated: false, by: 'mode' }

function job(id: string, route: JarvisRoute, answer: Partial<JarvisAnswer>): JarvisJob {
  return {
    id,
    status: 'done',
    steps: [],
    route,
    answer: { text: 'Réponse.', results: [], actions: [], durationMs: 300, ...answer },
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  }
}

/** Sert chaque question avec le job suivant de la liste ; `null` laisse le job en cours. */
function serve(jobs: Array<JarvisJob | null>) {
  const asked: JarvisAskInput[] = []
  globalThis.fetch = mock(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/api/jarvis/ask')) {
      asked.push(JSON.parse(String(init?.body)) as JarvisAskInput)
      return Response.json({ jobId: `job-${asked.length}` }, { status: 202 })
    }
    const polled = url.match(/\/api\/jarvis\/jobs\/job-(\d+)$/)
    if (polled) {
      const answer = jobs[Number(polled[1]) - 1]
      return Response.json(answer ?? { id: 'en-cours', status: 'running', steps: [], route: null, answer: null, error: null, startedAt: new Date().toISOString(), finishedAt: null })
    }
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  return asked
}

function panel() {
  return render(createElement(Jarvis, {
    open: true,
    onOpenChange: () => {},
    projectId: 'pupitre',
    conversationId: null,
    context: { openConversation: async () => {}, refreshConversations: () => {}, resolveTicketId: async () => null },
  }))
}

const shortcuts = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>('.jarvis-shortcuts button')]

test('les raccourcis restent sous la main, demandent une réponse sans modèle et ne vident pas le brouillon', async () => {
  const asked = serve([job('job-1', LOCAL_ROUTE, { text: 'Personne ne t’attend.' }), job('job-2', LOCAL_ROUTE, { text: 'Un agent tourne, aucun serveur n’écoute dans les projets.' })])
  const view = panel()

  expect(shortcuts(view.container).map((button) => button.textContent)).toEqual(['Qui m’attend ?', 'Qu’est-ce qui tourne ?'])
  const input = view.getByLabelText('Question pour Jarvis') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: 'je tape encore' } })

  fireEvent.click(shortcuts(view.container)[0]!)
  await waitFor(() => expect(view.getByText('Personne ne t’attend.')).toBeTruthy())
  expect(asked[0]).toMatchObject({ question: 'Qui m’attend ?', shortcut: 'waiting', mode: 'auto', projectId: 'pupitre' })
  expect(input.value).toBe('je tape encore')
  expect(view.container.querySelector('.jarvis-route')!.className).toContain('is-local')

  expect(shortcuts(view.container)).toHaveLength(2)
  fireEvent.click(shortcuts(view.container)[1]!)
  await waitFor(() => expect(view.getByText('Un agent tourne, aucun serveur n’écoute dans les projets.')).toBeTruthy())
  expect(asked[1]).toMatchObject({ question: 'Qu’est-ce qui tourne ?', shortcut: 'running' })
})

test('une question tapée ne porte pas de raccourci et vide le brouillon', async () => {
  const asked = serve([job('job-1', HAIKU_ROUTE, { text: 'Trois conversations.' })])
  const view = panel()
  const input = view.getByLabelText('Question pour Jarvis') as HTMLTextAreaElement

  fireEvent.change(input, { target: { value: 'où en est le mobile ?' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(view.getByText('Trois conversations.')).toBeTruthy())

  expect(asked[0]).toMatchObject({ question: 'où en est le mobile ?', mode: 'auto' })
  expect(asked[0]!.shortcut).toBeUndefined()
  expect(input.value).toBe('')
})

test('les raccourcis attendent la fin de la question en cours', async () => {
  serve([null])
  const view = panel()

  fireEvent.click(shortcuts(view.container)[0]!)
  await waitFor(() => expect(shortcuts(view.container)[0]!.disabled).toBe(true))
  expect(shortcuts(view.container)[1]!.disabled).toBe(true)
})

test('une réponse de Jev propose de demander à Haiku, sans lui montrer la liste déjà donnée', async () => {
  const asked = serve([
    job('job-1', HAIKU_ROUTE, { text: 'Première réponse.' }),
    job('job-2', JEV_ROUTE, { text: 'Je n’ai trouvé aucune conversation sur ce sujet.' }),
    job('job-3', HAIKU_ROUTE, { text: 'Haiku a relu.' }),
  ])
  const view = panel()
  const input = view.getByLabelText('Question pour Jarvis') as HTMLTextAreaElement

  fireEvent.change(input, { target: { value: 'première question' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(view.getByText('Première réponse.')).toBeTruthy())
  expect(view.queryByText('Demander à Haiku 5.5')).toBeNull()

  fireEvent.change(input, { target: { value: 'le bug Stripe' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(view.getByText('Je n’ai trouvé aucune conversation sur ce sujet.')).toBeTruthy())
  const routes = view.container.querySelectorAll('.jarvis-route')
  expect(routes[1]!.className).toContain('is-jev')
  expect(routes[1]!.textContent).toContain('Jev · sans Claude')

  fireEvent.click(view.getByText('Demander à Haiku 5.5'))
  await waitFor(() => expect(view.getByText('Haiku a relu.')).toBeTruthy())
  expect(asked[2]).toMatchObject({ question: 'le bug Stripe', mode: 'fast' })
  expect(asked[2]!.history).toEqual([
    { role: 'user', text: 'première question' },
    { role: 'jarvis', text: 'Première réponse.' },
  ])
  expect(view.getAllByText('le bug Stripe')).toHaveLength(2)
})

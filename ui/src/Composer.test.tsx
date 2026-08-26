import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Project, QuotaSnapshot } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

mock.module('@tauri-apps/api/core', () => ({ invoke: mock(() => Promise.resolve(null)) }))
mock.module('@tauri-apps/api/webview', () => ({
  getCurrentWebview: mock(() => ({
    onDragDropEvent: mock(() => Promise.resolve(() => undefined)),
  })),
}))

const { cleanup, render, screen } = await import('@testing-library/react')
const { Composer } = await import('./Composer')

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const project: Project = {
  id: 'project-1',
  name: 'Projet de test',
  path: '/tmp/project-1',
  permission_mode: 'default',
  filesystem_scope: 'project-and-ai-roots',
  pinned: false,
  default_preset_id: null,
  default_review_preset_id: null,
  auto_rescan: false,
  created_at: '2026-08-17T00:00:00.000Z',
}

const quotas: QuotaSnapshot = { claude: null, codex: null, grok: null }

function composerProps(isRunning: boolean, message = '') {
  return {
    conversationId: 'conversation-1',
    project,
    quotas,
    isRunning,
    onConversationCreated: () => undefined,
    onProjectUpdated: () => undefined,
    message,
    onMessageChange: () => undefined,
    focusRequest: 0,
    providerLabel: 'codex · GPT-5.6 Luna · xhigh · rapide',
    provider: 'codex',
  } as const
}

function renderComposer(isRunning: boolean) {
  render(createElement(Composer, composerProps(isRunning)))
}

test('ne superpose pas le faux placeholder avec celui du tour orientable', () => {
  renderComposer(true)

  expect(screen.getByPlaceholderText('Ajoute une précision au tour en cours…')).toBeTruthy()
  expect(screen.queryByText('Écris ton message, ou')).toBeNull()
})

test('affiche le faux placeholder quand aucun tour ne court', () => {
  renderComposer(false)

  expect(document.querySelector('.composer-placeholder')?.textContent).toContain('Écris ton message, ou')
  expect(document.querySelector('.composer-placeholder')?.textContent).toContain('@ pour un outil')
  expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('')
})

test('agrandit le champ avec son contenu puis le rend scrollable à sa hauteur maximale', () => {
  const view = render(createElement(Composer, composerProps(false)))
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 148 })

  view.rerender(createElement(Composer, composerProps(false, 'Un message sur plusieurs lignes')))

  expect(textarea.style.height).toBe('148px')
  expect(textarea.style.overflowY).toBe('hidden')

  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 260 })
  view.rerender(createElement(Composer, composerProps(false, 'Un message encore plus long')))

  expect(textarea.style.height).toBe('200px')
  expect(textarea.style.overflowY).toBe('auto')
})

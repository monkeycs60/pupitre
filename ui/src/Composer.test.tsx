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

const quotas: QuotaSnapshot = { claude: null, codex: null }

function renderComposer(isRunning: boolean) {
  render(createElement(Composer, {
    conversationId: 'conversation-1',
    project,
    quotas,
    isRunning,
    onConversationCreated: () => undefined,
    onProjectUpdated: () => undefined,
    message: '',
    onMessageChange: () => undefined,
    focusRequest: 0,
    providerLabel: 'codex · GPT-5.6 Luna · xhigh · rapide',
    provider: 'codex',
  }))
}

test('ne superpose pas le faux placeholder avec celui du tour orientable', () => {
  renderComposer(true)

  expect(screen.getByPlaceholderText('Ajoute une précision au tour en cours…')).toBeTruthy()
  expect(screen.queryByText('Écris ton message, ou')).toBeNull()
})

test('affiche le faux placeholder quand aucun tour ne court', () => {
  renderComposer(false)

  expect(document.querySelector('.composer-placeholder')?.textContent).toContain('Écris ton message, ou')
  expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('')
})

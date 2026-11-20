import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { CommandPalette } from './CommandPalette'
import type { Conversation, ViewedConversation } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

function viewed(id: string, title: string, projectName: string): ViewedConversation {
  return {
    id, project_id: `p-${projectName}`, project_name: projectName, title, summary: `Résumé de ${title}`,
    provider: 'claude', model: 'opus', answered_turn: 1, last_read_turn: 1,
    updated_at: '2026-11-20T10:00:00.000Z', viewed_at: '2026-11-20T10:00:00.000Z',
  }
}

function renderPalette(rows: ViewedConversation[], currentConversationId: string | null) {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/conversations/viewed')) return Response.json(rows)
    return Response.json([])
  }) as unknown as typeof fetch
  const opened: string[] = []
  render(createElement(CommandPalette, {
    open: true,
    onOpenChange: () => {},
    currentProject: null,
    currentConversation: currentConversationId ? { id: currentConversationId } as Conversation : null,
    onProjectSelect: () => {},
    onConversationSelect: (_projectId: string, conversationId: string) => { opened.push(conversationId) },
    onSkillLaunch: () => {},
    onViewSelect: () => {},
    onAction: () => {},
  }))
  return opened
}

const optionLabels = () => screen.getAllByRole('option').map((option) => option.querySelector('span')?.textContent)

test('la palette vide propose d’abord les lues récemment, sans la conversation affichée', async () => {
  const opened = renderPalette([viewed('c0', 'Affichée', 'pupitre'), viewed('c1', 'Globe Match', 'affilae-mono'), viewed('c2', 'Skill YouTube', 'pupitre')], 'c0')

  await screen.findByText('Globe Match')
  expect(screen.getAllByRole('heading', { level: 3 })[0]?.textContent).toBe('Lues récemment')
  expect(optionLabels().slice(0, 2)).toEqual(['Globe Match', 'Skill YouTube'])
  expect(optionLabels()).not.toContain('Affichée')

  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  expect(opened).toEqual(['c1'])
})

test('la saisie filtre les lues récemment par titre ou par projet', async () => {
  renderPalette([viewed('c1', 'Globe Match', 'affilae-mono'), viewed('c2', 'Skill YouTube', 'pupitre')], null)
  await screen.findByText('Globe Match')

  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'affilae' } })

  expect(optionLabels()).toContain('Globe Match')
  expect(optionLabels()).not.toContain('Skill YouTube')
})

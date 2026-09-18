import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { AttentionInbox } = await import('./AttentionInbox')

afterEach(cleanup)

const unread = {
  id: 'conversation-1',
  project_id: 'project-1',
  project_name: 'Pupitre',
  title: 'Réparer le panneau Activité',
  summary: 'Le branchement utilise désormais les conversations non lues.',
  provider: 'codex' as const,
  model: 'gpt-5',
  answered_turn: 2,
  last_read_turn: 1,
  updated_at: '2026-09-17T10:30:00.000Z',
}

test('affiche les conversations non lues et ouvre toute la ligne', () => {
  let opened = ''
  render(createElement(AttentionInbox, {
    items: [unread],
    loading: false,
    error: null,
    onOpen: (item: typeof unread) => { opened = item.id },
  }))

  const button = screen.getByRole('button', { name: /Réparer le panneau Activité/ })
  expect(button.textContent).toContain('Pupitre')
  expect(screen.getByText('1 à lire')).toBeTruthy()
  fireEvent.click(button)
  expect(opened).toBe(unread.id)
})

test('annonce que toutes les conversations sont lues', () => {
  render(createElement(AttentionInbox, {
    items: [],
    loading: false,
    error: null,
    onOpen: () => {},
  }))

  expect(screen.getByText('Tout est lu')).toBeTruthy()
})

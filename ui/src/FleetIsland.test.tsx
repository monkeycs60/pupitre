import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState } from 'react'
import { FleetIsland, type BoardTab } from './FleetIsland'
import type { FleetItem, UnreadConversation, ViewedConversation } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function viewed(index: number, overrides: Partial<ViewedConversation> = {}): ViewedConversation {
  return {
    id: `c${index}`,
    project_id: 'p1',
    project_name: 'pupitre',
    title: `Conversation ${index}`,
    summary: `Résumé ${index}`,
    provider: 'claude',
    model: 'opus',
    answered_turn: 1,
    last_read_turn: 1,
    updated_at: minutesAgo(index),
    viewed_at: minutesAgo(index),
    ...overrides,
  }
}

function stubViewed(rows: ViewedConversation[]) {
  const requested: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/api/conversations/viewed')) return Response.json(rows)
    return Response.json({})
  }) as unknown as typeof fetch
  return requested
}

function Harness({ items = [], unread = [], currentConversationId = null, onOpenViewed = () => {} }: {
  items?: FleetItem[]
  unread?: UnreadConversation[]
  currentConversationId?: string | null
  onOpenViewed?: (item: ViewedConversation) => void
}) {
  const [open, setOpen] = useState(false)
  const [requestedTab, setRequestedTab] = useState<BoardTab | null>(null)
  return createElement('div', null, createElement('button', {
    type: 'button',
    onClick: () => { setRequestedTab('viewed'); setOpen(true) },
  }, 'Raccourci'), createElement(FleetIsland, {
    items,
    unread,
    open,
    requestedTab,
    currentConversationId,
    onOpenChange: (next: boolean) => { setOpen(next); if (!next) setRequestedTab(null) },
    onOpenRunning: () => {},
    onOpenUnread: () => {},
    onOpenViewed,
    onReadAll: async () => {},
  }))
}

test("sans activité, l'île reste visible et ouvre directement les huit dernières lues, hors conversation affichée", async () => {
  const requested = stubViewed(Array.from({ length: 9 }, (_, index) => viewed(index)))
  const opened: string[] = []
  render(createElement(Harness, { currentConversationId: 'c0', onOpenViewed: (item) => opened.push(item.id) }))

  fireEvent.click(screen.getByRole('button', { name: /Lues récemment/ }))

  expect(screen.getByRole('tab', { name: /Lues récemment/ }).getAttribute('aria-selected')).toBe('true')
  const section = await screen.findByRole('region', { name: 'Lues récemment' })
  await within(section).findByText('Conversation 1')
  const titles = within(section).getAllByRole('button').map((row) => row.querySelector('strong')?.textContent)
  expect(titles).toEqual(['Conversation 1', 'Conversation 2', 'Conversation 3', 'Conversation 4', 'Conversation 5', 'Conversation 6', 'Conversation 7', 'Conversation 8'])
  expect(requested.some((url) => url.endsWith('/api/conversations/viewed?limit=9'))).toBe(true)

  fireEvent.click(within(section).getByText('Conversation 3'))
  expect(opened).toEqual(['c3'])
  expect(screen.queryByRole('dialog')).toBeNull()
})

test("avec de l'activité, l'île s'ouvre sur l'activité et l'onglet des lues signale celles qui ont bougé", async () => {
  const requested = stubViewed([viewed(1), viewed(2), viewed(3)])
  const running: FleetItem = {
    id: 'turn-1', kind: 'turn', projectId: 'p1', projectName: 'pupitre', conversationId: 'c1',
    title: 'Conversation 1', provider: 'claude', model: 'opus', startedAt: minutesAgo(1), lastEvent: 'Lecture',
  }
  const unread: UnreadConversation = { ...viewed(2), answered_turn: 2, last_read_turn: 1 }
  render(createElement(Harness, { items: [running], unread: [unread] }))

  fireEvent.click(screen.getByRole('button', { name: /pupitre/ }))
  expect(screen.getByRole('tab', { name: /Activité/ }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByText('En cours')).toBeTruthy()
  expect(requested.some((url) => url.includes('/api/conversations/viewed'))).toBe(false)

  fireEvent.click(screen.getByRole('tab', { name: /Lues récemment/ }))
  const section = await screen.findByRole('region', { name: 'Lues récemment' })
  await within(section).findByText('Conversation 3')
  const rows = within(section).getAllByRole('button')
  expect(rows.map((row) => row.querySelector('.activity-board-viewed-state')?.textContent ?? null)).toEqual(['en cours', 'nouvelle réponse', null])
})

test("le raccourci ouvre les lues récemment malgré l'activité, focus sur la première, flèches pour descendre", async () => {
  stubViewed([viewed(1), viewed(2), viewed(3)])
  const running: FleetItem = {
    id: 'turn-9', kind: 'turn', projectId: 'p1', projectName: 'pupitre', conversationId: 'c9',
    title: 'Conversation 9', provider: 'claude', model: 'opus', startedAt: minutesAgo(1), lastEvent: 'Lecture',
  }
  const opened: string[] = []
  render(createElement(Harness, { items: [running], onOpenViewed: (item) => opened.push(item.id) }))

  fireEvent.click(screen.getByRole('button', { name: 'Raccourci' }))

  expect(screen.getByRole('tab', { name: /Lues récemment/ }).getAttribute('aria-selected')).toBe('true')
  const section = await screen.findByRole('region', { name: 'Lues récemment' })
  await within(section).findByText('Conversation 1')
  const rows = within(section).getAllByRole('button')
  await waitFor(() => expect(document.activeElement).toBe(rows[0]!))

  fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' })
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(rows[2]!)
  fireEvent.keyDown(rows[2]!, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(rows[2]!)
  fireEvent.keyDown(rows[2]!, { key: 'ArrowUp' })
  expect(document.activeElement).toBe(rows[1]!)

  fireEvent.click(document.activeElement!)
  expect(opened).toEqual(['c2'])
})

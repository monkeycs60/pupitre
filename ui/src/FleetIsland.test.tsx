import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState } from 'react'
import { FleetIsland, type BoardTab } from './FleetIsland'
import type { FleetItem, UnreadConversation, ViewedConversation } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')

afterEach(() => {
  cleanup()
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

const running: FleetItem = {
  id: 'turn-1', kind: 'turn', projectId: 'p1', projectName: 'pupitre', conversationId: 'c1',
  title: 'Conversation 1', provider: 'claude', model: 'opus', startedAt: minutesAgo(1), lastEvent: 'Lecture',
}

function Harness({ items = [], unread = [], recent, switchIndex = null, onOpenViewed = () => {}, onRecentRefresh = () => {} }: {
  items?: FleetItem[]
  unread?: UnreadConversation[]
  recent: ViewedConversation[] | null
  switchIndex?: number | null
  onOpenViewed?: (item: ViewedConversation) => void
  onRecentRefresh?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [requestedTab, setRequestedTab] = useState<BoardTab | null>(null)
  return createElement('div', null, createElement('button', {
    type: 'button',
    onClick: () => { setRequestedTab('viewed'); setOpen(true) },
  }, 'Raccourci'), createElement(FleetIsland, {
    items,
    unread,
    recent,
    open,
    requestedTab,
    switchIndex,
    onOpenChange: (next: boolean) => { setOpen(next); if (!next) setRequestedTab(null) },
    onRecentRefresh,
    onOpenRunning: () => {},
    onOpenUnread: () => {},
    onOpenViewed,
    onReadAll: async () => {},
  }))
}

const recentRows = () => within(screen.getByRole('region', { name: 'Lues récemment' })).queryAllByRole('button')
const rowTitles = () => recentRows().map((row) => row.querySelector('strong')?.textContent)

test("sans activité, l'île reste visible et s'ouvre directement sur les lues récemment", () => {
  const opened: string[] = []
  let refreshes = 0
  render(createElement(Harness, {
    recent: [viewed(1), viewed(2), viewed(3)],
    onOpenViewed: (item) => opened.push(item.id),
    onRecentRefresh: () => { refreshes += 1 },
  }))

  fireEvent.click(screen.getByRole('button', { name: /Lues récemment/ }))

  expect(screen.getByRole('tab', { name: /Lues récemment/ }).getAttribute('aria-selected')).toBe('true')
  expect(rowTitles()).toEqual(['Conversation 1', 'Conversation 2', 'Conversation 3'])
  expect(refreshes).toBe(1)

  fireEvent.click(screen.getByText('Conversation 3'))
  expect(opened).toEqual(['c3'])
  expect(screen.queryByRole('dialog')).toBeNull()
})

test("avec de l'activité, l'île s'ouvre sur l'activité et l'onglet des lues signale celles qui ont bougé", () => {
  const unread: UnreadConversation = { ...viewed(2), answered_turn: 2, last_read_turn: 1 }
  render(createElement(Harness, { items: [running], unread: [unread], recent: [viewed(1), viewed(2), viewed(3)] }))

  fireEvent.click(screen.getByRole('button', { name: /pupitre/ }))
  expect(screen.getByRole('tab', { name: /Activité/ }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByText('En cours')).toBeTruthy()

  fireEvent.click(screen.getByRole('tab', { name: /Lues récemment/ }))
  expect(recentRows().map((row) => row.querySelector('.activity-board-viewed-state')?.textContent ?? null)).toEqual(['en cours', 'nouvelle réponse', null])
})

test("le raccourci ouvre les lues récemment malgré l'activité, focus sur la première, flèches pour descendre", async () => {
  const opened: string[] = []
  render(createElement(Harness, { items: [running], recent: [viewed(1), viewed(2), viewed(3)], onOpenViewed: (item) => opened.push(item.id) }))

  fireEvent.click(screen.getByRole('button', { name: 'Raccourci' }))

  expect(screen.getByRole('tab', { name: /Lues récemment/ }).getAttribute('aria-selected')).toBe('true')
  const rows = recentRows()
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

test("pendant Ctrl Tab, l'île affiche les lues récemment avec la cible surlignée, même fermée et en pleine activité", () => {
  const { rerender } = render(createElement(Harness, { items: [running], recent: [viewed(1), viewed(2), viewed(3)], switchIndex: 1 }))

  expect(screen.getByRole('tab', { name: /Lues récemment/ }).getAttribute('aria-selected')).toBe('true')
  expect(recentRows().map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true', null])
  expect(screen.getByText(/pour ouvrir/)).toBeTruthy()

  rerender(createElement(Harness, { items: [running], recent: [viewed(1), viewed(2), viewed(3)], switchIndex: null }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

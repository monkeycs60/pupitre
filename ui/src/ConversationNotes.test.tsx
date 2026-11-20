import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ConversationNotes, Note } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react')
const { ConversationNotesChip } = await import('./ConversationNotes')
const { notesChangedFor } = await import('./useConversationNotes')

const defaultFetch = globalThis.fetch
const DefaultSocket = globalThis.WebSocket

class FakeSocket {
  static instances: FakeSocket[] = []
  url: string
  listeners = new Map<string, Array<(event: { data?: unknown }) => void>>()
  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close() {}
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

afterEach(() => {
  cleanup()
  FakeSocket.instances = []
  globalThis.fetch = defaultFetch
  globalThis.WebSocket = DefaultSocket
})

function note(overrides: Partial<Note>): Note {
  return {
    id: 'n',
    project_id: 'p1',
    ticket_id: 't1',
    body: 'Note',
    author: 'user',
    conversation_id: null,
    done_at: null,
    created_at: '2026-11-20T10:00:00.000Z',
    ...overrides,
  }
}

function serve(initial: Note[], ticket: ConversationNotes['ticket'] = { id: 't1', key: 'TECH-9', title: 'Alia' }) {
  const state = { notes: [...initial] }
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    calls.push({ method, url, body })
    if (method === 'GET') return Response.json({ ticket, notes: state.notes })
    if (method === 'POST') {
      const created = note({ id: `n${state.notes.length + 1}`, body: String(body!.body), ticket_id: body!.scope === 'ticket' ? 't1' : null })
      state.notes.push(created)
      return Response.json(created, { status: 201 })
    }
    const id = decodeURIComponent(url.split('/').pop()!)
    if (method === 'DELETE') {
      state.notes = state.notes.filter((item) => item.id !== id)
      return new Response(null, { status: 204 })
    }
    state.notes = state.notes.map((item) => item.id === id
      ? { ...item, ...(typeof body!.body === 'string' ? { body: body!.body } : {}), ...(typeof body!.done === 'boolean' ? { done_at: body!.done ? '2026-11-20T12:00:00.000Z' : null } : {}) }
      : item)
    return Response.json(state.notes.find((item) => item.id === id))
  }) as unknown as typeof fetch
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  return { state, calls }
}

function mount(ticketId: string | null = 't1') {
  return render(createElement('header', { className: 'conversation-header' },
    createElement(ConversationNotesChip, { conversationId: 'c1', projectId: 'p1', ticketId })))
}

test('la pastille compte les notes ouvertes et le popover les range par portée, faites repliées', async () => {
  serve([
    note({ id: 'n1', body: 'Brancher le vrai worker', author: 'agent' }),
    note({ id: 'n2', ticket_id: null, body: 'Relancer la doc' }),
    note({ id: 'n3', body: 'Déjà réglé', done_at: '2026-11-19T10:00:00.000Z' }),
  ])
  mount()

  const chip = await screen.findByRole('button', { name: 'Notes avant déploiement : 2 notes ouvertes' })
  expect(chip.className).toContain('has-notes')
  expect(chip.textContent).toBe('2')
  expect(FakeSocket.instances[0]?.url).toContain('/ws?channel=notes&project=p1')

  fireEvent.click(chip)
  const popover = screen.getByRole('dialog', { name: 'Notes avant déploiement' })
  const ticketSection = within(popover).getByRole('region', { name: 'Ticket TECH-9' })
  const projectSection = within(popover).getByRole('region', { name: 'Projet' })
  expect(within(ticketSection).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Brancher le vrai workeragent'])
  expect(within(projectSection).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Relancer la doc'])
  expect(within(popover).queryByText('Déjà réglé')).toBeNull()

  fireEvent.click(within(popover).getByRole('button', { name: 'Faites (1)' }))
  expect(within(popover).getByText('Déjà réglé')).toBeTruthy()
  expect(popover.querySelectorAll('.note-row')).toHaveLength(3)

  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('cocher fait baisser le compteur ; ajouter respecte la portée choisie ; supprimer retire la ligne', async () => {
  const { calls } = serve([note({ id: 'n1', body: 'Brancher le vrai worker' })])
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Notes avant déploiement : 1 note ouverte' }))

  fireEvent.click(screen.getByRole('checkbox', { name: 'Marquer comme faite : Brancher le vrai worker' }))
  await screen.findByRole('button', { name: 'Notes avant déploiement : aucune note ouverte' })
  expect(calls.at(-1)).toMatchObject({ method: 'PATCH', url: '/api/notes/n1', body: { done: true } })

  const input = screen.getByRole('textbox', { name: 'Ajouter une note au ticket TECH-9' })
  fireEvent.change(input, { target: { value: '  Couper le flag  ' } })
  fireEvent.submit(input)
  await screen.findByRole('button', { name: 'Notes avant déploiement : 1 note ouverte' })
  expect(calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/conversations/c1/notes', body: { body: 'Couper le flag', scope: 'ticket' } })
  expect((input as HTMLInputElement).value).toBe('')

  fireEvent.click(screen.getByRole('button', { name: 'Projet' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Ajouter une note au projet' }), { target: { value: 'Relancer la doc' } })
  fireEvent.submit(screen.getByRole('textbox', { name: 'Ajouter une note au projet' }))
  await screen.findByRole('button', { name: 'Notes avant déploiement : 2 notes ouvertes' })
  expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { body: 'Relancer la doc', scope: 'project' } })
  expect(screen.getByRole('region', { name: 'Projet' }).textContent).toContain('Relancer la doc')

  fireEvent.click(screen.getByRole('button', { name: 'Supprimer : Relancer la doc' }))
  await screen.findByRole('button', { name: 'Notes avant déploiement : 1 note ouverte' })
  expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/notes/n3' })
  expect(screen.queryByRole('region', { name: 'Projet' })).toBeNull()
})

test('modifier une note au clic : Entrée enregistre, Échap annule sans fermer le popover', async () => {
  const { calls } = serve([note({ id: 'n1', body: 'Brancher le worker' })])
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /1 note ouverte/ }))

  fireEvent.click(screen.getByRole('button', { name: 'Brancher le worker' }))
  const editor = screen.getByRole('textbox', { name: 'Modifier la note' })
  fireEvent.change(editor, { target: { value: 'Autre texte' } })
  fireEvent.keyDown(editor, { key: 'Escape' })
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Brancher le worker' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Brancher le worker' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Modifier la note' }), { target: { value: "Brancher le worker d'Incubator" } })
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Modifier la note' }), { key: 'Enter' })
  await screen.findByRole('button', { name: "Brancher le worker d'Incubator" })
  expect(calls.at(-1)).toMatchObject({ method: 'PATCH', url: '/api/notes/n1', body: { body: "Brancher le worker d'Incubator" } })
})

test('une note ajoutée par un agent arrive par le canal WS ; sans ticket, la pastille reste discrète et sans bascule de portée', async () => {
  const { state } = serve([], null)
  mount(null)
  const chip = await screen.findByRole('button', { name: 'Notes avant déploiement : aucune note ouverte' })
  expect(chip.textContent).toBe('Notes')
  expect(chip.className).not.toContain('has-notes')

  state.notes.push(note({ id: 'n9', ticket_id: null, author: 'agent', body: 'Rebrancher le cache' }))
  await act(async () => {
    FakeSocket.instances[0]!.emit('message', JSON.stringify({ type: 'notes-changed', projectId: 'p1', ticketId: null }))
  })
  await screen.findByRole('button', { name: 'Notes avant déploiement : 1 note ouverte' })

  fireEvent.click(screen.getByRole('button', { name: /1 note ouverte/ }))
  expect(screen.queryByRole('group', { name: 'Portée de la note' })).toBeNull()
  expect(screen.getByRole('region', { name: 'Projet' }).textContent).toContain('agent')
})

test('seuls les changements du projet et du ticket de la conversation déclenchent un rechargement', () => {
  const message = (projectId: string, ticketId: string | null) => JSON.stringify({ type: 'notes-changed', projectId, ticketId })
  expect(notesChangedFor(message('p1', null), 'p1', 't1')).toBe(true)
  expect(notesChangedFor(message('p1', 't1'), 'p1', 't1')).toBe(true)
  expect(notesChangedFor(message('p1', 't2'), 'p1', 't1')).toBe(false)
  expect(notesChangedFor(message('p2', null), 'p1', 't1')).toBe(false)
  expect(notesChangedFor('pas du json', 'p1', 't1')).toBe(false)
})

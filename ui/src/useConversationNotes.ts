import { useEffect, useState } from 'react'
import { createConversationNote, deleteNote, listConversationNotes, updateNote } from './api'
import { reconnectDelayMs } from './backoff'
import { webSocketUrl } from './transport'
import type { ConversationNotes, Note, NoteScope } from './types'

const EMPTY: ConversationNotes = { ticket: null, notes: [] }

export function notesChangedFor(raw: string, projectId: string, ticketId: string | null): boolean {
  try {
    const message = JSON.parse(raw) as { type?: unknown; projectId?: unknown; ticketId?: unknown }
    return message.type === 'notes-changed'
      && message.projectId === projectId
      && (message.ticketId === null || message.ticketId === ticketId)
  } catch {
    return false
  }
}

/** Notes du ticket et du projet d'une conversation, rechargées à chaque changement diffusé. */
export function useConversationNotes(conversationId: string, projectId: string, ticketId: string | null) {
  const [state, setState] = useState<{ key: string; data: ConversationNotes }>({ key: conversationId, data: EMPTY })

  useEffect(() => {
    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let failedAttempts = 0
    const controller = new AbortController()
    const load = () => {
      void listConversationNotes(conversationId, controller.signal)
        .then((data) => { if (!disposed) setState({ key: conversationId, data }) })
        .catch(() => {})
    }
    const connect = () => {
      if (disposed) return
      let current: WebSocket
      try {
        current = new WebSocket(webSocketUrl(`/ws?channel=notes&project=${encodeURIComponent(projectId)}`))
      } catch {
        retryTimer = setTimeout(connect, reconnectDelayMs(++failedAttempts))
        return
      }
      socket = current
      current.addEventListener('open', () => {
        if (failedAttempts > 0) load()
        failedAttempts = 0
      })
      current.addEventListener('message', (message) => {
        if (!disposed && socket === current && notesChangedFor(String(message.data), projectId, ticketId)) load()
      })
      const retry = () => {
        if (disposed || socket !== current) return
        socket = null
        current.close()
        retryTimer = setTimeout(connect, reconnectDelayMs(++failedAttempts))
      }
      current.addEventListener('close', retry)
      current.addEventListener('error', retry)
    }
    load()
    connect()
    return () => {
      disposed = true
      controller.abort()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      socket?.close()
    }
  }, [conversationId, projectId, ticketId])

  const data = state.key === conversationId ? state.data : EMPTY
  const apply = (update: (notes: Note[]) => Note[]) => {
    setState((current) => current.key === conversationId
      ? { key: current.key, data: { ...current.data, notes: update(current.data.notes) } }
      : current)
  }
  const replace = (note: Note) => apply((notes) => notes.map((item) => item.id === note.id ? note : item))

  return {
    ticket: data.ticket,
    notes: data.notes,
    add: async (body: string, scope: NoteScope) => {
      const note = await createConversationNote(conversationId, body, scope)
      apply((notes) => notes.some((item) => item.id === note.id) ? notes : [...notes, note])
    },
    setDone: async (note: Note, done: boolean) => replace(await updateNote(note.id, { done })),
    edit: async (note: Note, body: string) => replace(await updateNote(note.id, { body })),
    remove: async (note: Note) => {
      await deleteNote(note.id)
      apply((notes) => notes.filter((item) => item.id !== note.id))
    },
  }
}

export type NotesApi = ReturnType<typeof useConversationNotes>

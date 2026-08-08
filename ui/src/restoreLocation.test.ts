import { expect, test } from 'bun:test'
import type { Conversation, Project } from './types'
import {
  LAST_ACTIVE_LOCATION_STORAGE_KEY,
  type StorageLike,
  locationForSelection,
  readLastActiveLocation,
  restoreConversation,
  restoreProject,
  writeLastActiveLocation,
} from './restoreLocation'

function project(id: string): Project {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    permission_mode: 'acceptEdits',
    filesystem_scope: 'project-and-ai-roots',
    pinned: false,
    created_at: '2026-08-08T08:00:00.000Z',
    default_preset_id: null,
    auto_counter_red: false,
    auto_rescan: false,
  }
}

function conversation(
  id: string,
  projectId: string,
  updatedAt: string,
): Conversation {
  return {
    id,
    project_id: projectId,
    title: id,
    summary: id,
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'medium',
    speed: 'standard',
    permission_mode: null,
    orchestrator: true,
    subagent_preset_id: null,
    subagent_effort: null,
    continued_from: null,
    routine_id: null,
    cli_session_id: null,
    pinned: false,
    title_locked: false,
    digest_turn: 0,
    archived: false,
    deleted_at: null,
    created_at: '2026-08-08T08:00:00.000Z',
    updated_at: updatedAt,
  }
}

function memoryStorage(): StorageLike {
  const values = new Map<string, string>()
  return {
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      values.set(key, value)
    },
  }
}

function storageWith(raw: string): StorageLike {
  const storage = memoryStorage()
  storage.setItem(LAST_ACTIVE_LOCATION_STORAGE_KEY, raw)
  return storage
}

function failingStorage(): StorageLike {
  return {
    getItem() {
      throw new Error('storage indisponible')
    },
    setItem() {
      throw new Error('storage indisponible')
    },
  }
}

const projects = [project('project-1'), project('project-2')]
const conversations = [
  conversation('conversation-old', 'project-1', '2026-08-08T08:01:00.000Z'),
  conversation('conversation-newest', 'project-1', '2026-08-08T08:03:00.000Z'),
]
const conversationsFromAnotherProject = [
  conversation('conversation-other-project', 'project-2', '2026-08-08T08:04:00.000Z'),
]

test('lit un snapshot valide et ignore un JSON invalide', () => {
  expect(readLastActiveLocation(storageWith(
    JSON.stringify({ projectId: 'project-1', conversationId: 'conversation-1' }),
  ))).toEqual({ projectId: 'project-1', conversationId: 'conversation-1' })
  expect(readLastActiveLocation(storageWith('{'))).toBeNull()
  expect(readLastActiveLocation(storageWith(
    JSON.stringify({ projectId: '', conversationId: null }),
  ))).toBeNull()
})

test('ne restaure aucun projet sans snapshot et replie vers le premier projet si nécessaire', () => {
  expect(restoreProject(projects, null)).toBeNull()
  expect(restoreProject(projects, { projectId: 'project-2', conversationId: null }))
    .toEqual(projects[1])
  expect(restoreProject(projects, { projectId: 'missing', conversationId: null }))
    .toEqual(projects[0])
})

test('restaure la conversation mémorisée ou la plus récemment mise à jour', () => {
  expect(restoreConversation(conversations, 'conversation-old')?.id)
    .toBe('conversation-old')
  expect(restoreConversation(conversations, 'missing')?.id)
    .toBe('conversation-newest')
  expect(restoreConversation([], null)).toBeNull()
})

test('écrit le snapshot sans propager une erreur de stockage', () => {
  const storage = memoryStorage()
  writeLastActiveLocation(storage, { projectId: 'project-1', conversationId: null })
  expect(readLastActiveLocation(storage)).toEqual({
    projectId: 'project-1',
    conversationId: null,
  })
  expect(() => writeLastActiveLocation(failingStorage(), {
    projectId: 'project-1',
    conversationId: null,
  })).not.toThrow()
})

test('les conversations d’un autre projet restent hors de la liste restaurée', () => {
  expect(restoreConversation(conversations, conversationsFromAnotherProject[0].id)?.project_id)
    .toBe('project-1')
})

test('n’écrit pas une conversation appartenant à un autre projet', () => {
  expect(locationForSelection(projects[0], conversationsFromAnotherProject[0]))
    .toEqual({ projectId: 'project-1', conversationId: null })
})

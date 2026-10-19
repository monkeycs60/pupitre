import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Conversation } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render } = await import('@testing-library/react')
const { ConversationAiResults } = await import('./ConversationAiResults')

afterEach(cleanup)

function conversation(id: string, title: string, archived = false): Conversation {
  return { id, title, archived, updated_at: '2026-10-07T10:00:00Z' } as Conversation
}

test('les correspondances fortes précèdent les partielles, chacune sous son intertitre', () => {
  const opened: string[] = []
  const view = render(createElement(ConversationAiResults, {
    state: {
      status: 'done',
      query: 'veille Haiku',
      response: {
        reranked: true,
        results: [
          { conversation: conversation('a', 'Veille Haiku'), reason: 'Elle met en place la veille.', match: 'strong' },
          { conversation: conversation('b', 'Ajout de Haiku', true), reason: 'Haiku sans la veille.', match: 'partial' },
        ],
      },
    },
    selectedConversationId: 'b',
    onSelect: (item: Conversation) => opened.push(item.id),
  }))
  const headings = [...view.container.querySelectorAll('.ai-search-results-heading')].map((node) => node.textContent)
  expect(headings).toEqual(['1 conversation correspond', 'Correspondances partielles'])
  const rows = [...view.container.querySelectorAll('.ai-search-result')]
  expect(rows.map((row) => row.getAttribute('data-conversation-id'))).toEqual(['a', 'b'])
  expect(rows[1]!.className).toContain('is-selected')
  expect(rows[1]!.textContent).toContain('archivée')
  fireEvent.click(rows[0]!)
  expect(opened).toEqual(['a'])
})

test('sans explication du tri, les résultats sont annoncés comme les plus proches', () => {
  const view = render(createElement(ConversationAiResults, {
    state: {
      status: 'done',
      query: 'tarte aux pommes',
      response: { reranked: true, results: [{ conversation: conversation('a', 'Autre sujet'), reason: '', match: 'partial' }] },
    },
    selectedConversationId: null,
    onSelect: () => {},
  }))
  expect(view.container.querySelector('.ai-search-results-heading')?.textContent).toBe('Aucune correspondance nette · les plus proches')
  expect(view.container.querySelector('.ai-search-result-reason')).toBeNull()
})

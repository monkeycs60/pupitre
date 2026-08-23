import { expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen } = await import('@testing-library/react')
const { ConversationDomains } = await import('./ConversationDomains')

test('affiche les domaines actifs et le nombre de propositions dans l’en-tête', () => {
  render(createElement(ConversationDomains, {
    domains: [{ id: 'match', name: 'Match AI', kind: 'métier' }],
    proposedCount: 2,
  }))
  expect(screen.getByText('Match AI')).not.toBeNull()
  expect(screen.getByText('2 propositions')).not.toBeNull()
  cleanup()
})

test('ne rend rien sans domaine ni proposition', () => {
  const { container } = render(createElement(ConversationDomains, { domains: [], proposedCount: 0 }))
  expect(container.innerHTML).toBe('')
  cleanup()
})

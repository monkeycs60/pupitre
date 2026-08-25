import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ChangelogReview } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ChangelogReviewDialog } = await import('./ChangelogReviewDialog')
const defaultFetch = globalThis.fetch

afterEach(() => { cleanup(); globalThis.fetch = defaultFetch })

const review: ChangelogReview = {
  id: 'r1', conversationId: 'c1', summaryId: 's1', eventIdFrom: 1, eventIdTo: 4,
  status: 'proposé', createdAt: '', publishedAt: null,
  changes: [
    { id: 'a', groupId: 'g1', domainId: 'd1', domainName: 'Dashboard', nature: 'ajout', title: 'Vue ajoutée', description: 'Une vue existe.', impact: 'Le suivi est centralisé.', evidence: ['commit abc'], ambiguous: false, selected: true },
    { id: 'b', groupId: 'g2', domainId: 'd1', domainName: 'Dashboard', nature: 'correction', title: 'CSS ambigu', description: 'Une règle a changé.', impact: 'À confirmer.', evidence: ['ui.css'], ambiguous: true, selected: false },
  ],
}

test('présélectionne les changements certains et isole les ambiguïtés', () => {
  render(createElement(ChangelogReviewDialog, { review, onClose: () => {} }))
  expect(screen.getByText('Modifications certaines')).toBeTruthy()
  expect(screen.getByText('Attribution incertaine (1)')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Publier 1 changement(s)' })).toBeTruthy()
  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
  expect(boxes.map((box) => box.checked)).toEqual([true, false])
})

test('publie les corrections éditées après validation rapide', async () => {
  let body: Record<string, unknown> | null = null
  globalThis.fetch = mock(async (_input, init) => {
    body = JSON.parse(String(init?.body))
    return Response.json({ review: { ...review, status: 'publié' }, files: ['/skill/CHANGELOG.md'] })
  }) as typeof fetch
  const close = mock(() => {})
  render(createElement(ChangelogReviewDialog, { review, onClose: close }))
  fireEvent.change(screen.getAllByLabelText('Titre du changement')[0]!, { target: { value: 'Vue clarifiée' } })
  fireEvent.click(screen.getByRole('button', { name: 'Publier 1 changement(s)' }))
  await waitFor(() => expect(close).toHaveBeenCalled())
  expect(((body?.changes as Array<{ title: string }>)[0]?.title)).toBe('Vue clarifiée')
})

test('fusionne deux propositions voisines en conservant leur contenu et leurs preuves', () => {
  const mergeReview: ChangelogReview = {
    ...review,
    changes: [
      review.changes[0]!,
      { ...review.changes[0]!, id: 'c', groupId: 'g3', title: 'Seed idempotent', description: 'La répétition ne crée pas de doublons.', evidence: ['test seed'] },
    ],
  }
  render(createElement(ChangelogReviewDialog, { review: mergeReview, onClose: () => {} }))
  fireEvent.click(screen.getByRole('button', { name: 'Fusionner avec la précédente' }))
  expect(screen.getAllByLabelText('Titre du changement')).toHaveLength(1)
  expect((screen.getByLabelText('Description du changement') as HTMLTextAreaElement).value).toContain('Seed idempotent')
  expect(screen.getByText('commit abc · test seed')).toBeTruthy()
})

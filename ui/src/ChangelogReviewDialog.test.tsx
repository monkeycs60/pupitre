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
  expect(screen.getByText('Dashboard · Ajout')).toBeTruthy()
  expect(screen.getByText('Vue ajoutée')).toBeTruthy()
  expect(screen.getByText('Attribution incertaine (1)')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Publier 1 changement' })).toBeTruthy()
  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
  expect(boxes.map((box) => box.checked)).toEqual([true, false])
  expect((screen.getAllByText('Modifier')[0]!.closest('details') as HTMLDetailsElement).open).toBe(false)
})

test('replie les détails puis publie la phrase éditée', async () => {
  let body: Record<string, unknown> | null = null
  globalThis.fetch = mock(async (_input, init) => {
    body = JSON.parse(String(init?.body))
    return Response.json({ review: { ...review, status: 'publié' }, files: ['/skill/CHANGELOG.md'] })
  }) as typeof fetch
  const close = mock(() => {})
  render(createElement(ChangelogReviewDialog, { review, onClose: close }))
  fireEvent.click(screen.getAllByText('Modifier')[0]!)
  fireEvent.change(screen.getAllByLabelText('Titre du changement')[0]!, { target: { value: 'Vue clarifiée' } })
  fireEvent.click(screen.getByRole('button', { name: 'Publier 1 changement' }))
  await waitFor(() => expect(close).toHaveBeenCalled())
  const publishedChanges = body?.changes as Array<{ title: string }> | undefined
  expect(publishedChanges?.[0]?.title).toBe('Vue clarifiée')
})

test('ne montre aucun contrôle de fusion ou de scission', () => {
  render(createElement(ChangelogReviewDialog, { review, onClose: () => {} }))
  expect(screen.queryByText('Fusionner avec la précédente')).toBeNull()
  expect(screen.queryByText('Scinder')).toBeNull()
})

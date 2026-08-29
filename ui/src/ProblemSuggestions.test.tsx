import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Problem } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ProblemSuggestions } = await import('./ProblemSuggestions')

afterEach(cleanup)

function problem(index: number, conversationCount: number): Problem {
  return {
    id: `problem-${index}`,
    public_id: `PB-ABC12${index}`,
    capture_id: 'capture-1',
    project_id: 'project-1',
    ticket_id: index === 2 ? 'ticket-2' : null,
    ticket_key: index === 2 ? 'TECH-42' : null,
    ticket_title: index === 2 ? 'Mesurer Match AI côté annonceur' : null,
    ticket_branch: index === 2 ? 'feature/TECH-42-match-ai' : null,
    title: `Problème ${index}`,
    context: `Contexte ${index}`,
    resolution: `Résolution ${index}`,
    plans: index === 2
      ? [{ title: 'Instrumenter', instruction: 'Tracer.' }, { title: 'Mesurer', instruction: 'Calculer.' }]
      : [{ title: `Plan ${index}`, instruction: `Consigne ${index}` }],
    status: 'open',
    closed_at: null,
    closed_commit_sha: null,
    conversation_count: conversationCount,
    created_at: `2026-08-${20 + index}T10:00:00Z`,
    updated_at: `2026-08-${20 + index}T10:00:00Z`,
  }
}

test('propose cinq problématiques non lancées en priorité', () => {
  const onSelect = mock(() => {})
  const onSeeAll = mock(() => {})
  const problems = [problem(1, 1), ...[2, 3, 4, 5, 6].map((index) => problem(index, 0))]

  render(createElement(ProblemSuggestions, { problems, onSelect, onSeeAll }))

  expect(screen.getAllByRole('button', { name: 'Lancer' })).toHaveLength(5)
  expect(screen.queryByText('Problème 1')).toBeNull()
  expect(screen.getByText('TECH-42 · Mesurer Match AI côté annonceur')).toBeTruthy()
  expect(screen.getByText('feature/TECH-42-match-ai')).toBeTruthy()
  expect(screen.getByText('2 axes')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'Lancer' })[4]!)
  expect(onSelect).toHaveBeenCalledWith({
    problems: [expect.objectContaining({ public_id: 'PB-ABC122' })],
    missionTitle: 'Problème 2',
  })
  fireEvent.click(screen.getByRole('button', { name: 'Voir toutes' }))
  expect(onSeeAll).toHaveBeenCalledTimes(1)
})

import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { groupEvents, type CodeExcerptBlock } from './groupEvents'
import { foldFinishedTurns } from './turnWork'
import type { AppEvent } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { CodeExcerptCard } = await import('./CodeExcerptCard')
afterEach(cleanup)

const block: CodeExcerptBlock = {
  kind: 'code-excerpt', id: 'code-excerpt-1', excerptId: '1', path: 'src/config.ts',
  title: 'Le choix du port', explanation: 'Le port sert à construire **l’adresse locale**.',
  content: Array.from({ length: 200 }, (_, i) => `const value${i + 1} = ${i + 1};`).join('\n'),
  startLine: 80, endLine: 84, highlights: [{ startLine: 81, endLine: 82 }],
  sha256: 'a'.repeat(64), createdAt: '2026-10-14T10:00:00Z',
}

test('ouvre au passage cité, surligne seulement les lignes clés et permet de revenir après défilement', async () => {
  const { container } = render(createElement(CodeExcerptCard, { block }))
  const region = screen.getByRole('region', { name: /fichier défilable/ })
  expect(region.scrollTop).toBe(77 * 22)
  expect([...container.querySelectorAll('[data-highlighted]')].map((node) => node.getAttribute('data-line'))).toEqual(['81', '82'])
  expect(screen.getByText('l’adresse locale').tagName).toBe('STRONG')
  region.scrollTop = 0
  fireEvent.scroll(region)
  expect(container.querySelector('[data-line="1"]')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /L80–84/ }))
  expect(region.scrollTop).toBe(77 * 22)
  await waitFor(() => expect(container.querySelector('.code-tok-keyword')).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Agrandir' }))
  expect(screen.getByRole('button', { name: 'Réduire' }).getAttribute('aria-expanded')).toBe('true')
});

test('le code HTML reste du texte et ne crée aucun élément exécutable', async () => {
  const { container } = render(createElement(CodeExcerptCard, { block: { ...block, path: 'test.txt', startLine: 1, endLine: 1, content: '<img src=x onerror=alert(1)>' } }))
  expect(container.querySelector('.code-excerpt-lines img')).toBeNull()
  await waitFor(() => expect(container.querySelector('code')?.textContent).toContain('<img'))
});

test('plusieurs extraits restent séparés, ordonnés et visibles après la fin du tour', () => {
  const { kind: _kind, id: _id, ...data } = block
  const events: AppEvent[] = [
    { type: 'user-message', text: '@code explique', images: [] },
    { type: 'tool-start', toolId: 'tool', toolName: 'publish_code', input: {} },
    { type: 'code-excerpt', ...data },
    { type: 'text-delta', text: 'Le second passage complète le premier.' },
    { type: 'code-excerpt', ...data, excerptId: '2' },
    { type: 'tool-end', toolId: 'tool', output: 'ok', images: [] },
    { type: 'text-final', text: 'Les deux passages sont expliqués.' },
    { type: 'status', state: 'done' },
  ]
  const blocks = groupEvents(events)
  expect(blocks.filter((item) => item.kind === 'code-excerpt').map((item) => item.excerptId)).toEqual(['1', '2'])
  expect(foldFinishedTurns(blocks).filter((item) => item.kind === 'code-excerpt')).toHaveLength(2)
});


test('un grand fichier reste navigable sans rendre toutes ses lignes', () => {
  const { container } = render(createElement(CodeExcerptCard, { block }))
  const region = screen.getByRole('region', { name: /fichier défilable/ })
  expect(container.querySelectorAll('[data-line]').length).toBeLessThan(80)
  region.scrollTop = 199 * 22
  fireEvent.scroll(region)
  expect(container.querySelector('[data-line="200"]')).not.toBeNull()
  expect(container.querySelector('[data-line="1"]')).toBeNull()
})

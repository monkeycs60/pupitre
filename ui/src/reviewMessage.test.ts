import { expect, test } from 'bun:test'
import type { ReviewComment } from './api'
import { reviewMessage } from './reviewMessage'

function comment(overrides: Partial<ReviewComment>): ReviewComment {
  return {
    id: 'c', conversation_id: 'conv', repository_label: 'hapigator', worktree_path: '/w/hapigator-t1', path: 'lib/scope.js',
    side: 'new', start_line: 42, end_line: 42, line_text: 'if (roles.some(isManager)) return ALL', body: 'Les AM aussi.',
    status: 'draft', created_at: '2026-10-14T20:00:00Z', sent_at: null, ...overrides,
  }
}

test('compose une consigne numérotée avec chemin cliquable, lignes visées et commentaire', () => {
  expect(reviewMessage([
    comment({}),
    comment({ path: 'source/App.tsx', repository_label: 'reactor', start_line: 118, end_line: 120, line_text: 'a\n\nb', body: 'Réutilise le helper.\nMerci.' }),
    comment({ side: 'old', start_line: 7, end_line: 7, line_text: 'legacy()', body: 'Pourquoi retiré ?' }),
  ])).toBe([
    'Relecture du code (3 commentaires). Traite chaque point, puis réponds point par point.',
    '',
    '1. `lib/scope.js:42` (hapigator)',
    '   > if (roles.some(isManager)) return ALL',
    '   Les AM aussi.',
    '',
    '2. `source/App.tsx:118-120` (reactor)',
    '   > a',
    '   > b',
    '   Réutilise le helper.',
    '   Merci.',
    '',
    '3. `lib/scope.js:7` (hapigator, lignes supprimées)',
    '   > legacy()',
    '   Pourquoi retiré ?',
  ].join('\n'))
})

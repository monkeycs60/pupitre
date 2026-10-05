import { expect, test } from 'bun:test'
import { locateToolFile } from './toolFiles'
import type { CodeSource } from './types'

function source(path: string, ref: string | null = null): CodeSource {
  return { path, repositoryPath: path, repositoryLabel: path, branch: 'main', head: null, detached: false, main: false, conversations: [], ref, updatedAt: null }
}

test('un fichier se rattache au dépôt le plus profond qui le contient, hors références sans worktree', () => {
  const sources = [source('/repo'), source('/repo/apps/front'), source('/repo/apps/front/x', 'feature')]
  expect(locateToolFile(sources, '/repo/apps/front/x/src/a.ts')).toEqual({ source: sources[1], relative: 'x/src/a.ts' })
  expect(locateToolFile(sources, '/repo-bis/a.ts')).toBeNull()
})

import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { CitationResolution, EditorFileTarget } from './api'
import type { ToolFileAccess } from './toolFiles'

if (typeof document === 'undefined') GlobalRegistrator.register()
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ToolFileContext } = await import('./toolFiles')
const { default: Markdown } = await import('./Markdown')
const { CitedFilesAction, inlineCodeSpans } = await import('./FileCitation')
afterEach(cleanup)

const RESOLUTIONS: Record<string, CitationResolution> = {
  'lib/auth.js:132': { status: 'resolved', path: '/w/hapigator/lib/auth.js', line: 132, label: 'hapigator/lib/auth.js' },
  'takeover.js:43': { status: 'resolved', path: '/w/hapigator/lib/takeover.js', line: 43, label: 'hapigator/lib/takeover.js' },
  'routes.js': {
    status: 'ambiguous', line: null, more: 3,
    candidates: [{ path: '/w/a/routes.js', label: 'a/routes.js' }, { path: '/w/b/routes.js', label: 'b/routes.js' }],
  },
}

function access() {
  const editor: EditorFileTarget[][] = []
  const code: Array<[string, number | null]> = []
  const asked: string[] = []
  const value: ToolFileAccess = {
    readFile: async () => null,
    openInCode: async (path, line) => { code.push([path, line]); return true },
    resolveCitation: async (text) => { asked.push(text); return RESOLUTIONS[text] ?? { status: 'missing' } },
    openInEditor: async (files) => { editor.push(files) },
  }
  return { value, editor, code, asked }
}

const TEXT = 'Voir `lib/auth.js:132`, `takeover.js:43`, `routes.js` et `req.app.user`.\n\n```js\nconst a = `lib/auth.js`\n```'

test('une citation retrouvée ouvre VS Code au clic et l’onglet Code au Ctrl+clic', async () => {
  const context = access()
  render(createElement(ToolFileContext.Provider, { value: context.value }, createElement(Markdown, null, TEXT)))

  const link = await screen.findByTitle(/hapigator\/lib\/auth\.js:132/)
  fireEvent.click(link)
  fireEvent.click(link, { ctrlKey: true })

  expect(context.editor).toEqual([[{ path: '/w/hapigator/lib/auth.js', line: 132 }]])
  expect(context.code).toEqual([['/w/hapigator/lib/auth.js', 132]])
  expect(context.asked).not.toContain('req.app.user')
  expect(document.querySelectorAll('a.file-citation')).toHaveLength(2)
  expect(document.querySelector('pre a')).toBeNull()
})

test('une citation ambiguë propose ses candidats dans un menu', async () => {
  const context = access()
  render(createElement(ToolFileContext.Provider, { value: context.value }, createElement(Markdown, null, TEXT)))

  fireEvent.click(await screen.findByRole('button', { name: 'routes.js' }))
  const items = screen.getAllByRole('menuitem')
  expect(items.map((item) => item.textContent)).toEqual(['a/routes.js', 'b/routes.js'])
  expect(screen.getByText('et 3 autres')).toBeTruthy()

  fireEvent.click(items[1]!)
  expect(context.editor).toEqual([[{ path: '/w/b/routes.js', line: null }]])
  expect(screen.queryByRole('menu')).toBeNull()
})

test('l’action de fin de réponse ouvre d’un coup les fichiers retrouvés', async () => {
  const context = access()
  render(createElement(ToolFileContext.Provider, { value: context.value }, createElement(CitedFilesAction, { text: TEXT })))

  fireEvent.click(await screen.findByRole('button', { name: /Ouvrir les 2 fichiers cités/ }))
  await waitFor(() => expect(context.editor).toHaveLength(1))
  expect(context.editor[0]).toEqual([
    { path: '/w/hapigator/lib/auth.js', line: 132 },
    { path: '/w/hapigator/lib/takeover.js', line: 43 },
  ])
})

test('sans worktree accessible, le code inline reste du texte', () => {
  render(createElement(Markdown, null, TEXT))
  expect(document.querySelectorAll('.file-citation')).toHaveLength(0)
  expect(inlineCodeSpans(TEXT)).toEqual(['lib/auth.js:132', 'takeover.js:43', 'routes.js', 'req.app.user'])
})

test('le nom de fichier d’un extrait @code ouvre VS Code à la première ligne citée', async () => {
  const { CodeExcerptCard } = await import('./CodeExcerptCard')
  const context = access()
  context.value.resolveCitation = async () => ({ status: 'resolved', path: '/w/src/config.ts', line: null, label: 'src/config.ts' })
  render(createElement(ToolFileContext.Provider, { value: context.value }, createElement(CodeExcerptCard, {
    block: {
      kind: 'code-excerpt', id: 'e', excerptId: 'e', path: 'src/config.ts', title: 'Port', explanation: 'Le port.',
      content: 'a\nb\nc\nd', startLine: 3, endLine: 4, highlights: [{ startLine: 3, endLine: 4 }],
      sha256: 'a'.repeat(64), createdAt: '2026-10-14T10:00:00Z',
    },
  })))

  fireEvent.click(await screen.findByTitle(/src\/config\.ts:3/))
  expect(context.editor).toEqual([[{ path: '/w/src/config.ts', line: 3 }]])
})

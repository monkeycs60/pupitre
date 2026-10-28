import { expect, test } from 'bun:test'
import { highlightCode, languageForPath, splitHighlightedHtml } from './codeHighlight'

test('le découpage en lignes referme et rouvre les jetons multi-lignes', () => {
  expect(splitHighlightedHtml('<span class="hljs-comment">/* a\nb */</span>\n<span class="hljs-keyword">const</span> x')).toEqual([
    '<span class="code-tok-comment">/* a</span>',
    '<span class="code-tok-comment">b */</span>',
    '<span class="code-tok-keyword">const</span> x',
  ])
})

test('colore un fichier TypeScript et échappe le texte brut des langages inconnus', async () => {
  expect(languageForPath('ui/src/App.tsx')).toBe('typescript')
  expect(languageForPath('Dockerfile')).toBe('dockerfile')
  expect(languageForPath('.env.local')).toBe('ini')

  const lines = await highlightCode("const a = '<b>'\n", 'x.ts')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('<span class="code-tok-keyword">const</span>')
  expect(lines[0]).toContain('&lt;b&gt;')

  expect(await highlightCode('<script>\n', 'notes.unknown')).toEqual(['&lt;script&gt;'])
})

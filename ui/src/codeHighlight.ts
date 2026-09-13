import type { LanguageFn } from 'highlight.js'

type LanguageLoader = () => Promise<{ default: LanguageFn }>

const LOADERS: Record<string, LanguageLoader> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  json: () => import('highlight.js/lib/languages/json'),
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  less: () => import('highlight.js/lib/languages/less'),
  xml: () => import('highlight.js/lib/languages/xml'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  bash: () => import('highlight.js/lib/languages/bash'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  ini: () => import('highlight.js/lib/languages/ini'),
  python: () => import('highlight.js/lib/languages/python'),
  go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'),
  sql: () => import('highlight.js/lib/languages/sql'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  php: () => import('highlight.js/lib/languages/php'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  swift: () => import('highlight.js/lib/languages/swift'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  diff: () => import('highlight.js/lib/languages/diff'),
}

const EXTENSIONS: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  md: 'markdown', mdx: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', env: 'ini', conf: 'ini',
  py: 'python', go: 'go', rs: 'rust', sql: 'sql', rb: 'ruby', php: 'php',
  java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff',
}

/**
 * Les scopes highlight.js (une quarantaine) ramenés à la palette du lecteur :
 * la feuille `code.css` ne déclare que ces jetons.
 */
const TOKENS: Record<string, string> = {
  keyword: 'keyword', built_in: 'builtin', type: 'type', class: 'type', literal: 'literal', symbol: 'literal',
  bullet: 'literal', number: 'number', string: 'string', link: 'string', regexp: 'regexp', char: 'string',
  comment: 'comment', doctag: 'comment', quote: 'comment', meta: 'meta', 'meta-keyword': 'meta',
  title: 'title', function: 'title', section: 'title', tag: 'tag', name: 'tag', 'selector-tag': 'tag',
  attr: 'attr', attribute: 'attr', 'selector-id': 'attr', 'selector-class': 'attr', 'selector-attr': 'attr',
  'selector-pseudo': 'attr', property: 'property', variable: 'variable', 'template-variable': 'variable',
  params: 'variable', subst: 'variable', operator: 'punct', punctuation: 'punct',
  addition: 'addition', deletion: 'deletion', emphasis: 'emphasis', strong: 'strong',
}

export const MAX_HIGHLIGHT_BYTES = 400_000

export function languageForPath(path: string): string | null {
  const name = path.split('/').pop() ?? path
  const lower = name.toLowerCase()
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile'
  if (lower === 'makefile') return 'makefile'
  if (lower.startsWith('.env')) return 'ini'
  const extension = lower.includes('.') ? lower.split('.').pop()! : ''
  return EXTENSIONS[extension] ?? null
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function splitCodeLines(content: string): string[] {
  const lines = content.split(/\r?\n/)
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Découpe le HTML de highlight.js ligne par ligne : un commentaire ou une
 * chaîne sur plusieurs lignes ouvre un `<span>` qui traverse les retours à la
 * ligne. Chaque ligne referme les jetons encore ouverts et la suivante les rouvre.
 */
export function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = []
  const open: string[] = []
  let current = ''
  for (const match of html.matchAll(/<span class="([^"]*)">|<\/span>|\n|[^<\n]+|</g)) {
    const token = match[0]
    if (token === '\n') {
      lines.push(current + '</span>'.repeat(open.length))
      current = open.join('')
    } else if (token === '</span>') {
      open.pop()
      current += token
    } else if (match[1] !== undefined) {
      const scope = match[1].match(/hljs-([\w-]+)/)?.[1] ?? ''
      const tag = `<span class="code-tok-${TOKENS[scope] ?? 'plain'}">`
      open.push(tag)
      current += tag
    } else {
      current += token
    }
  }
  lines.push(current + '</span>'.repeat(open.length))
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

export function plainCodeLines(content: string): string[] {
  return splitCodeLines(content).map(escapeHtml)
}

export async function highlightCode(content: string, path: string): Promise<string[]> {
  const language = languageForPath(path)
  const loader = language ? LOADERS[language] : undefined
  if (!language || !loader || content.length > MAX_HIGHLIGHT_BYTES) return plainCodeLines(content)
  const { default: hljs } = await import('highlight.js/lib/core')
  if (!hljs.getLanguage(language)) hljs.registerLanguage(language, (await loader()).default)
  const { value } = hljs.highlight(content.replace(/\r\n/g, '\n'), { language, ignoreIllegals: true })
  return splitHighlightedHtml(value)
}

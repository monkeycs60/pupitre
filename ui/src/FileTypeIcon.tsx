import type { ReactNode } from 'react'

type Glyph =
  | { kind: 'badge', label: string, background: string, color: string }
  | { kind: 'react', color: string }
  | { kind: 'braces', color: string }
  | { kind: 'markdown' }
  | { kind: 'image' }
  | { kind: 'lock' }
  | { kind: 'key' }
  | { kind: 'git' }
  | { kind: 'terminal' }
  | { kind: 'database' }
  | { kind: 'document' }

const BADGES: Record<string, [label: string, background: string, color: string]> = {
  js: ['JS', '#f0db4f', '#1d1b16'], mjs: ['JS', '#f0db4f', '#1d1b16'], cjs: ['JS', '#f0db4f', '#1d1b16'],
  ts: ['TS', '#3178c6', '#ffffff'], mts: ['TS', '#3178c6', '#ffffff'], cts: ['TS', '#3178c6', '#ffffff'],
  css: ['#', '#2f6fe4', '#ffffff'], scss: ['S', '#c6538c', '#ffffff'], sass: ['S', '#c6538c', '#ffffff'],
  less: ['L', '#2a4d80', '#ffffff'], html: ['<>', '#e44d26', '#ffffff'], htm: ['<>', '#e44d26', '#ffffff'],
  xml: ['<>', '#a8773a', '#ffffff'], vue: ['V', '#41b883', '#10231a'], svelte: ['S', '#ff3e00', '#ffffff'],
  py: ['Py', '#3572a5', '#ffe873'], go: ['Go', '#00add8', '#08262f'], rs: ['Rs', '#dea584', '#2b1a0f'],
  rb: ['Rb', '#cc342d', '#ffffff'], php: ['P', '#777bb4', '#ffffff'], java: ['J', '#b07219', '#ffffff'],
  kt: ['K', '#a97bff', '#ffffff'], kts: ['K', '#a97bff', '#ffffff'], swift: ['S', '#f05138', '#ffffff'],
  c: ['C', '#5c6bc0', '#ffffff'], h: ['H', '#5c6bc0', '#ffffff'], cpp: ['C+', '#f34b7d', '#ffffff'],
  cs: ['C#', '#178600', '#ffffff'], yml: ['Y', '#cb4b4b', '#ffffff'], yaml: ['Y', '#cb4b4b', '#ffffff'],
  toml: ['T', '#9c5a3c', '#ffffff'], ini: ['I', '#6b6875', '#ffffff'], graphql: ['GQ', '#e10098', '#ffffff'],
  gql: ['GQ', '#e10098', '#ffffff'], txt: ['Tx', '#55525c', '#e9e8ed'], csv: ['Cs', '#2e8b57', '#ffffff'],
  pdf: ['Pdf', '#d13b3b', '#ffffff'],
}

const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'svg'])
const LOCKS = new Set(['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock', 'composer.lock', 'gemfile.lock'])

function glyphFor(path: string): Glyph {
  const name = (path.split('/').pop() ?? path).toLowerCase()
  const extension = name.includes('.') ? name.split('.').pop()! : ''
  if (LOCKS.has(name) || extension === 'lock') return { kind: 'lock' }
  if (name.startsWith('.env')) return { kind: 'key' }
  if (name.startsWith('.git')) return { kind: 'git' }
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name === 'docker-compose.yml') {
    return { kind: 'badge', label: 'D', background: '#2496ed', color: '#ffffff' }
  }
  if (name === 'package.json') return { kind: 'braces', color: '#e8595a' }
  if (extension === 'tsx') return { kind: 'react', color: '#4b9be8' }
  if (extension === 'jsx') return { kind: 'react', color: '#61dafb' }
  if (extension === 'json' || extension === 'jsonc' || extension === 'json5') return { kind: 'braces', color: '#f0b64a' }
  if (extension === 'md' || extension === 'mdx') return { kind: 'markdown' }
  if (extension === 'sh' || extension === 'bash' || extension === 'zsh') return { kind: 'terminal' }
  if (extension === 'sql' || extension === 'db' || extension === 'sqlite') return { kind: 'database' }
  if (IMAGES.has(extension)) return { kind: 'image' }
  const badge = BADGES[extension]
  if (badge) return { kind: 'badge', label: badge[0], background: badge[1], color: badge[2] }
  return { kind: 'document' }
}

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[a-z0-9]+$/i.test(path) || /(^|\/)__tests__\//.test(path)
}

function renderGlyph(glyph: Glyph): ReactNode {
  switch (glyph.kind) {
    case 'badge': {
      const fontSize = glyph.label.length === 1 ? 8.5 : glyph.label.length === 2 ? 6.6 : 5.2
      return <>
        <rect x="1.5" y="2.5" width="13" height="11" rx="2.6" fill={glyph.background} />
        <text x="8" y="8.1" fill={glyph.color} fontSize={fontSize} fontWeight="800" textAnchor="middle" dominantBaseline="central" fontFamily="ui-monospace, 'JetBrains Mono', monospace" letterSpacing="-0.3">{glyph.label}</text>
      </>
    }
    case 'react':
      return <g fill="none" stroke={glyph.color} strokeWidth="0.95">
        <ellipse cx="8" cy="8" rx="6.4" ry="2.5" />
        <ellipse cx="8" cy="8" rx="6.4" ry="2.5" transform="rotate(60 8 8)" />
        <ellipse cx="8" cy="8" rx="6.4" ry="2.5" transform="rotate(120 8 8)" />
        <circle cx="8" cy="8" r="1.35" fill={glyph.color} stroke="none" />
      </g>
    case 'braces':
      return <path d="M6 2.8c-1.6 0-2 .8-2 2.1v1.3c0 .9-.4 1.5-1.4 1.8 1 .3 1.4.9 1.4 1.8v1.3c0 1.3.4 2.1 2 2.1M10 2.8c1.6 0 2 .8 2 2.1v1.3c0 .9.4 1.5 1.4 1.8-1 .3-1.4.9-1.4 1.8v1.3c0 1.3-.4 2.1-2 2.1" fill="none" stroke={glyph.color} strokeWidth="1.4" strokeLinecap="round" />
    case 'markdown':
      return <>
        <rect x="1" y="3.5" width="14" height="9" rx="2" fill="none" stroke="#9d9aa6" strokeWidth="1.1" />
        <path d="M3.6 10.2V5.8l1.7 2 1.7-2v4.4M10.9 5.8v4.2M9.3 8.6l1.6 1.6 1.6-1.6" fill="none" stroke="#c9c6d1" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      </>
    case 'image':
      return <>
        <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" fill="none" stroke="#b39dff" strokeWidth="1.2" />
        <circle cx="5.6" cy="6.1" r="1.2" fill="#b39dff" />
        <path d="m2.6 12 3.8-3.6 2.5 2.2 2-1.7 2.6 2.4" fill="none" stroke="#b39dff" strokeWidth="1.2" strokeLinejoin="round" />
      </>
    case 'lock':
      return <>
        <rect x="3.2" y="7" width="9.6" height="7" rx="1.6" fill="#76737e" />
        <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" fill="none" stroke="#76737e" strokeWidth="1.4" />
      </>
    case 'key':
      return <>
        <circle cx="5.3" cy="8" r="3" fill="none" stroke="#e5b94e" strokeWidth="1.5" />
        <path d="M8.3 8h6M12.2 8v2.4M14.3 8v1.8" fill="none" stroke="#e5b94e" strokeWidth="1.5" strokeLinecap="round" />
      </>
    case 'git':
      return <>
        <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.8" transform="rotate(45 8 8)" fill="#f05033" />
        <circle cx="6.6" cy="6.4" r="1" fill="#ffffff" />
        <circle cx="9.4" cy="9.6" r="1" fill="#ffffff" />
        <path d="M6.6 6.4v3.2M6.6 6.4l2.8 3.2" stroke="#ffffff" strokeWidth="0.9" />
      </>
    case 'terminal':
      return <>
        <rect x="1.5" y="2.8" width="13" height="10.4" rx="2" fill="#1f3b2f" stroke="#4ec9a5" strokeWidth="1" />
        <path d="m4.2 6.2 2 1.8-2 1.8M7.8 10.2h3.6" fill="none" stroke="#4ec9a5" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </>
    case 'database':
      return <g fill="none" stroke="#e7a33e" strokeWidth="1.2">
        <ellipse cx="8" cy="4" rx="5" ry="1.9" />
        <path d="M3 4v8c0 1 2.2 1.9 5 1.9s5-.9 5-1.9V4M3 8c0 1 2.2 1.9 5 1.9s5-.9 5-1.9" />
      </g>
    default:
      return <>
        <path d="M4 1.8h5.2L12.5 5v9.2H4Z" fill="none" stroke="#8a8793" strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M9 1.9V5.2h3.4M6 8.3h4.4M6 10.6h4.4" fill="none" stroke="#8a8793" strokeWidth="1.1" strokeLinecap="round" />
      </>
  }
}

export function FileTypeIcon({ path, size = 16 }: { path: string, size?: number }) {
  return <svg className="file-type-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    {renderGlyph(glyphFor(path))}
    {isTestFile(path) ? <circle cx="13.6" cy="2.6" r="2.2" fill="#4ec9a5" stroke="var(--bg-panel)" strokeWidth="1" /> : null}
  </svg>
}

export function RepositoryIcon({ size = 16 }: { size?: number }) {
  return <svg className="file-type-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 2.5h8.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3Z" fill="#8b7cff" fillOpacity="0.18" stroke="#a396ff" strokeWidth="1" strokeLinejoin="round" />
    <path d="M3 2.5v11M5.2 11.2h5.3" stroke="#a396ff" strokeWidth="1" strokeLinecap="round" />
    <circle cx="8.2" cy="5.8" r="1.2" fill="#c4bbff" />
  </svg>
}

export function FolderIcon({ open, size = 16 }: { open: boolean, size?: number }) {
  return <svg className="file-type-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    {open
      ? <path d="M1.8 4.2c0-.6.4-1 1-1h3.3l1.4 1.5h5.3c.6 0 1 .4 1 1v1.1H4.6l-2.8 6.3Z M1.8 12.8l2.6-6h10.3l-2.4 6Z" fill="#8f8a6c" fillOpacity="0.35" stroke="#c7b77a" strokeWidth="1" strokeLinejoin="round" />
      : <path d="M1.8 4.2c0-.6.4-1 1-1h3.3l1.4 1.5h5.7c.6 0 1 .4 1 1v6.9c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z" fill="#8f8a6c" fillOpacity="0.3" stroke="#b3a56f" strokeWidth="1" strokeLinejoin="round" />}
  </svg>
}

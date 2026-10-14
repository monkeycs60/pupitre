import { useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MouseEvent, ReactNode } from 'react'
import type { CitationResolution } from './api'
import { ToolFileContext } from './toolFiles'
import type { ToolFileAccess } from './toolFiles'
import './styles/file-citation.css'

const EXTENSIONS = 'js|jsx|ts|tsx|mjs|cjs|mts|cts|json|jsonc|md|mdx|css|scss|sass|less|html|vue|svelte|py|rb|go|rs|java|kt|swift|php|sql|sh|bash|zsh|ya?ml|toml|ini|env|lock|txt|xml|graphql|gql|proto|c|h|cpp|hpp|cs|dart|lua|twig|hbs|ejs'
const CITATION = new RegExp(
  `^(?:~|\\.{1,2})?/?(?:[\\w@.+\\-\\[\\]()]+/)*(?:[\\w@+\\-\\[\\]()][\\w@.+\\-\\[\\]()]*\\.(?:${EXTENSIONS})|\\.env(?:\\.[\\w-]+)?|Dockerfile|Makefile)(?:(?::|#L)\\d+(?:[-–]L?\\d+)?(?::\\d+)?)?$`,
  'i',
)

export function looksLikeFileCitation(text: string): boolean {
  return CITATION.test(text.trim())
}

/** Spans de code inline d'un Markdown, hors blocs clôturés. */
export function inlineCodeSpans(markdown: string): string[] {
  const prose = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
  return [...prose.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].map((match) => match[1]!)
}

function useCitation(access: ToolFileAccess | null, text: string): CitationResolution | null {
  const [resolution, setResolution] = useState<CitationResolution | null>(null)
  useEffect(() => {
    if (access === null || !looksLikeFileCitation(text)) return
    let active = true
    void access.resolveCitation(text).then((value) => { if (active) setResolution(value) })
    return () => { active = false }
  }, [access, text])
  return resolution
}

export function openFileTarget(access: ToolFileAccess, event: MouseEvent, path: string, line: number | null) {
  event.preventDefault()
  if (event.ctrlKey || event.metaKey) void access.openInCode(path, line)
  else void access.openInEditor([{ path, line }])
}

const HINT = 'Ouvrir dans VS Code · Ctrl+clic : onglet Code'

/** Code inline d'une réponse : un fichier retrouvé dans le worktree devient un lien vers VS Code. */
/** Résolution d'un chemin cité, partagée avec les cartes `@code`. */
export function useFileCitation(text: string): { access: ToolFileAccess | null; resolution: CitationResolution | null } {
  const access = useContext(ToolFileContext)
  return { access, resolution: useCitation(access, text) }
}

export const FILE_CITATION_HINT = HINT

export function FileCitation({ text, children }: { text: string; children: ReactNode }) {
  const access = useContext(ToolFileContext)
  const resolution = useCitation(access, text)
  const [menu, setMenu] = useState<{ top?: number; bottom?: number; left: number } | null>(null)
  const wrapper = useRef<HTMLSpanElement>(null)
  const menuElement = useRef<HTMLSpanElement>(null)
  const menuOpen = menu !== null
  const setMenuOpen = (open: boolean) => {
    const rect = wrapper.current?.getBoundingClientRect()
    if (!open || !rect) {
      setMenu(null)
      return
    }
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 300))
    setMenu(window.innerHeight - rect.bottom >= 340
      ? { top: rect.bottom + 4, left }
      : { bottom: window.innerHeight - rect.top + 4, left })
  }

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: Event) => {
      const target = event.target as Node
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !wrapper.current?.contains(target) && !menuElement.current?.contains(target)) setMenu(null)
    }
    const dismiss = (event: Event) => { if (!menuElement.current?.contains(event.target as Node)) setMenu(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [menuOpen])

  if (access === null || resolution === null || resolution.status === 'missing') return <code>{children}</code>

  if (resolution.status === 'resolved') {
    return (
      <a
        className="file-citation"
        href="#"
        title={`${resolution.label}${resolution.line ? `:${resolution.line}` : ''}\n${HINT}`}
        onClick={(event) => openFileTarget(access, event, resolution.path, resolution.line)}
      >
        <code>{children}</code>
      </a>
    )
  }

  return (
    <span className="file-citation-ambiguous" ref={wrapper}>
      <button
        type="button"
        className="file-citation"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={`${resolution.candidates.length + resolution.more} fichiers portent ce nom : choisir lequel ouvrir`}
        onClick={() => setMenuOpen(!menuOpen)}
      >
        <code>{children}</code>
      </button>
      {menuOpen ? createPortal(
        <span className="file-citation-menu" role="menu" style={menu} ref={menuElement}>
          <span className="file-citation-menu-hint">{HINT}</span>
          {resolution.candidates.map((candidate) => (
            <button
              key={candidate.path}
              type="button"
              role="menuitem"
              title={candidate.path}
              onClick={(event) => {
                setMenuOpen(false)
                openFileTarget(access, event, candidate.path, resolution.line)
              }}
            >
              {candidate.label}
            </button>
          ))}
          {resolution.more > 0 ? <span className="file-citation-menu-more">et {resolution.more} autres</span> : null}
        </span>,
        document.body,
      ) : null}
    </span>
  )
}

/** Action sous une réponse : ouvrir d'un coup dans VS Code tous les fichiers qu'elle cite. */
export function CitedFilesAction({ text }: { text: string }) {
  const access = useContext(ToolFileContext)
  const [files, setFiles] = useState<Array<{ path: string; line: number | null }>>([])

  useEffect(() => {
    if (access === null) return
    const spans = [...new Set(inlineCodeSpans(text).filter(looksLikeFileCitation))]
    if (spans.length < 2) return
    let active = true
    void Promise.all(spans.map((span) => access.resolveCitation(span))).then((resolutions) => {
      if (!active) return
      const unique = new Map<string, { path: string; line: number | null }>()
      for (const resolution of resolutions) {
        if (resolution.status !== 'resolved') continue
        const known = unique.get(resolution.path)
        if (!known || (known.line === null && resolution.line !== null)) unique.set(resolution.path, { path: resolution.path, line: resolution.line })
      }
      setFiles([...unique.values()])
    })
    return () => { active = false }
  }, [access, text])

  if (access === null || files.length < 2) return null
  return (
    <button
      type="button"
      className="cited-files-action"
      onClick={() => void access.openInEditor(files)}
      title="Ouvrir dans la fenêtre VS Code du worktree, chaque fichier à la ligne citée"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Ouvrir les {files.length} fichiers cités dans VS Code
    </button>
  )
}

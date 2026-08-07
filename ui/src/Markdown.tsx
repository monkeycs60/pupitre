import { Children, createContext, isValidElement, memo, useContext, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Mermaid from './Mermaid'
import { TaskToggleContext } from './taskToggle'
import type { SectionKind } from './taskToggle'
import { ActionFormatContext, headingKind } from './actionHeadings'
import type { ActionFormat } from './actionHeadings'

/** GFM : tableaux, listes de tâches, barré, autolinks. */
const REMARK_PLUGINS = [remarkGfm]

interface TaskContextValue {
  checked: boolean
  label: string
  toggle: () => void
}

interface SectionRange {
  kind: SectionKind
  /** Lignes 1-indexées, bornes incluses, dans la source normalisée. */
  from: number
  to: number
}

const MARKDOWN_SCOPE = createContext('global')
const TASK_CONTEXT = createContext<TaskContextValue | null>(null)
/** Rang de l'élément dans sa liste, fourni par NumberedList. */
const TASK_INDEX = createContext(1)
const SECTIONS = createContext<SectionRange[]>([])

function hash(text: string): string {
  let value = 2_166_136_261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16_777_619)
  }
  return (value >>> 0).toString(36)
}

function nodeText(node: any): string {
  if (!node) return ''
  if (typeof node.value === 'string') return node.value
  if (!Array.isArray(node.children)) return ''
  return node.children.map(nodeText).join('')
}

function storedTaskState(key: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key)
    return stored === null ? fallback : stored === '1'
  } catch {
    return fallback
  }
}

function saveTaskState(key: string, checked: boolean): void {
  try {
    window.localStorage.setItem(key, checked ? '1' : '0')
  } catch {
    // Le rendu reste utilisable si le contexte Tauri bloque le stockage local.
  }
}

/**
 * Convertit les listes des blocs DO THIS et FOLLOW-UP en cases à cocher GFM, et
 * retient l'intervalle de lignes de chaque section : c'est ce qui permet
 * ensuite de savoir si une case cochée est une action ou une piste, sans
 * polluer le Markdown d'un marqueur.
 */
function normalizeActionChecklists(markdown: string, format: ActionFormat): {
  source: string
  sections: SectionRange[]
} {
  const lines = markdown.split('\n')
  const sections: SectionRange[] = []
  let current: SectionRange | null = null

  const close = (lastLine: number) => {
    if (current) {
      sections.push({ ...current, to: lastLine })
      current = null
    }
  }

  const source = lines.map((line, offset) => {
    const lineNumber = offset + 1
    const heading = headingKind(line, format)
    if (heading) {
      close(lineNumber - 1)
      current = { kind: heading, from: lineNumber, to: lines.length }
      return line
    }
    if (current === null) return line
    // Un titre de niveau quelconque ferme la section en cours.
    if (/^#{1,6}\s/u.test(line.trim())) {
      close(lineNumber - 1)
      return line
    }
    if (current.kind === 'do-this' && /^\s*\d+[.)]\s+/u.test(line)) {
      return line.replace(/^(\s*)\d+[.)]\s+/u, '$1- [ ] ')
    }
    if (current.kind === 'follow-up' && /^\s*[-*]\s+(?!\[[ xX]\])/u.test(line)) {
      return line.replace(/^(\s*)[-*]\s+/u, '$1- [ ] ')
    }
    return line
  }).join('\n')

  close(lines.length)
  return { source, sections }
}

/** Section d'appartenance d'un élément, d'après sa ligne dans la source. */
function sectionAt(sections: SectionRange[], line: number): SectionKind {
  return sections.find((section) => line >= section.from && line <= section.to)?.kind
    ?? 'do-this'
}

/** Sépare la case à cocher du corps : sans ça, chaque nœud inline du texte
 *  devient une colonne de la grille et la phrase part en morceaux. */
function splitCheckbox(children: any): { checkbox: any; body: any[] } {
  const items = Children.toArray(children)
  const isCheckbox = (child: any) => isValidElement(child)
    && (child.type === MarkdownTaskInput || child.type === 'input')
  return {
    checkbox: items.find(isCheckbox) ?? null,
    body: items.filter((child) => !isCheckbox(child)),
  }
}

/** Un clic sur un lien, ou une simple sélection de texte, ne doit rien cocher. */
function isPassiveClick(event: any): boolean {
  if (event.target?.closest?.('a, button, code')) return true
  const selection = window.getSelection()
  return selection !== null && !selection.isCollapsed
}

function MarkdownTaskItem({ node, children, props }: { node: any; children: any; props: any }) {
  const scope = useContext(MARKDOWN_SCOPE)
  const index = useContext(TASK_INDEX)
  const kind = sectionAt(useContext(SECTIONS), node?.position?.start?.line ?? 0)
  const label = nodeText(node).trim()
  // Clé stable : message + section + rang, indépendante de la formulation.
  const key = `pupitre:markdown-task:${scope}:${kind}:${index}`
  const input = node.children.find((child: any) => child.tagName === 'input')
  const [checked, setChecked] = useState(() => storedTaskState(key, Boolean(input.properties?.checked)))
  // Cocher pousse l'action dans le composeur ; décocher l'en retire.
  const onToggle = useContext(TaskToggleContext)
  const toggle = () => {
    const next = !checked
    setChecked(next)
    saveTaskState(key, next)
    onToggle?.({ index, label, kind }, next)
  }
  const { checkbox, body } = splitCheckbox(children)
  return (
    <TASK_CONTEXT.Provider value={{ checked, label, toggle }}>
      <li
        {...props}
        className={`${props.className ?? ''} markdown-task-item`.trim()}
        // Toute la ligne est cliquable ; la case garde son propre onChange, d'où
        // le filtre sur la cible pour ne pas basculer deux fois.
        onClick={(event: any) => {
          if (event.target?.tagName === 'INPUT' || isPassiveClick(event)) return
          toggle()
        }}
      >
        {checkbox}
        <span className="markdown-task-number" aria-hidden="true">{index}</span>
        <span className="markdown-task-body">{body}</span>
      </li>
    </TASK_CONTEXT.Provider>
  )
}

/**
 * Numérote les éléments d'une liste : la conversion en cases à cocher perd la
 * numérotation d'origine, alors que c'est elle qu'on référence ensuite dans le
 * message (« Exécute les actions 2 et 4 »).
 */
function NumberedList({ ordered, children, props }: { ordered: boolean; children: any; props: any }) {
  let position = 0
  const items = Children.map(children, (child) => {
    if (!isValidElement(child)) return child
    position += 1
    return <TASK_INDEX.Provider value={position}>{child}</TASK_INDEX.Provider>
  })
  return ordered ? <ol {...props}>{items}</ol> : <ul {...props}>{items}</ul>
}

function MarkdownTaskInput({ node: _node, ...props }: any) {
  const task = useContext(TASK_CONTEXT)
  if (!task) return <input {...props} />
  return (
    <input
      {...props}
      type="checkbox"
      checked={task.checked}
      disabled={false}
      aria-label={task.label ? `Reprendre dans le message : ${task.label}` : 'Reprendre dans le message'}
      onChange={task.toggle}
    />
  )
}

/** Texte brut d'un bloc ```mermaid, ou null si ce n'en est pas un. */
function mermaidSource(node: any): string | null {
  const code = node?.children?.[0]
  if (code?.tagName !== 'code') return null
  const classes = code.properties?.className
  if (!Array.isArray(classes) || !classes.includes('language-mermaid')) return null
  return code.children?.[0]?.value ?? null
}

const COMPONENTS = {
  /** Les tableaux larges défilent au lieu de déborder de la bulle. */
  table: ({ node: _node, ...props }: any) => (
    <div className="markdown-table-wrap">
      <table {...props} />
    </div>
  ),
  ul: ({ node: _node, children, ...props }: any) => (
    <NumberedList ordered={false} props={props}>{children}</NumberedList>
  ),
  ol: ({ node: _node, children, ...props }: any) => (
    <NumberedList ordered props={props}>{children}</NumberedList>
  ),
  li: ({ node, children, ...props }: any) => {
    const input = node?.children?.find((child: any) => child.tagName === 'input')
    if (!input) return <li {...props}>{children}</li>
    return <MarkdownTaskItem node={node} props={props}>{children}</MarkdownTaskItem>
  },
  input: MarkdownTaskInput,
  pre: ({ node, children, ...props }: any) => {
    const chart = mermaidSource(node)
    if (chart !== null) return <Mermaid chart={chart} />
    return <pre {...props}>{children}</pre>
  },
}

/** Rendu Markdown unique de l'app : tout passe par ici pour rester cohérent. */
export default memo(MarkdownImpl)

function MarkdownImpl({ children, scope }: { children: string; scope?: string }) {
  const format = useContext(ActionFormatContext)
  const { source, sections } = useMemo(
    () => normalizeActionChecklists(children, format),
    [children, format],
  )
  return (
    // `scope` identifie le message : l'état des cases survit alors à une
    // reformulation du texte, là où un hash du contenu le réinitialisait.
    <MARKDOWN_SCOPE.Provider value={scope ?? hash(source)}>
      <SECTIONS.Provider value={sections}>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
          {source}
        </ReactMarkdown>
      </SECTIONS.Provider>
    </MARKDOWN_SCOPE.Provider>
  )
}

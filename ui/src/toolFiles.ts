import { createContext } from 'react'
import { getCodeFile, listCodeSources, openConversationInEditor, openRevisionInEditor, resolveFileCitations } from './api'
import type { CitationResolution, EditorFileTarget, EditorRevision } from './api'
import { pushToast } from './toasts'
import type { CodeSource } from './types'

export interface ToolFileAccess {
  readFile: (path: string) => Promise<string | null>
  resolveCitation: (text: string) => Promise<CitationResolution>
  openInEditor: (files: EditorFileTarget[]) => Promise<void>
  openRevisionInEditor: (revision: EditorRevision) => Promise<void>
}

export const ToolFileContext = createContext<ToolFileAccess | null>(null)

interface ToolFileLocation {
  source: CodeSource
  relative: string
}

export function locateToolFile(sources: CodeSource[], path: string): ToolFileLocation | null {
  let best: CodeSource | null = null
  for (const source of sources) {
    if (source.ref !== null || !path.startsWith(`${source.path}/`)) continue
    if (!best || source.path.length > best.path.length) best = source
  }
  return best ? { source: best, relative: path.slice(best.path.length + 1) } : null
}

function editorFailed(error: unknown) {
  pushToast({
    tone: 'danger',
    title: 'Ouverture dans VS Code impossible',
    detail: error instanceof Error ? error.message : String(error),
  })
}

export function createToolFileAccess(
  projectId: string,
  conversationId: string | null,
): ToolFileAccess {
  const citations = new Map<string, Promise<CitationResolution>>()
  let batch: Map<string, (resolution: CitationResolution) => void> | null = null
  const flush = async (texts: Map<string, (resolution: CitationResolution) => void>) => {
    const resolved = conversationId === null
      ? {}
      : await resolveFileCitations(conversationId, [...texts.keys()]).catch(() => ({} as Record<string, CitationResolution>))
    for (const [text, settle] of texts) settle(resolved[text] ?? { status: 'missing' })
  }
  let sources: Promise<CodeSource[]> | null = null
  const locate = async (path: string) => {
    sources ??= listCodeSources(projectId).catch(() => {
      sources = null
      return []
    })
    return locateToolFile(await sources, path)
  }
  return {
    async readFile(path) {
      const location = await locate(path)
      if (!location) return null
      try {
        const file = await getCodeFile(projectId, location.source.path, location.relative)
        return file.content
      } catch {
        return null
      }
    },
    resolveCitation(text) {
      const known = citations.get(text)
      if (known) return known
      if (batch === null) {
        const current = new Map<string, (resolution: CitationResolution) => void>()
        batch = current
        setTimeout(() => {
          batch = null
          void flush(current)
        }, 0)
      }
      const pending = batch
      const promise = new Promise<CitationResolution>((settle) => { pending.set(text, settle) })
      citations.set(text, promise)
      return promise
    },
    async openInEditor(files) {
      if (conversationId === null || files.length === 0) return
      await openConversationInEditor(conversationId, files).catch(editorFailed)
    },
    async openRevisionInEditor(revision) {
      if (conversationId === null) return
      await openRevisionInEditor(conversationId, revision).catch(editorFailed)
    },
  }
}

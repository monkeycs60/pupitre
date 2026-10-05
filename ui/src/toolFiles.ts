import { createContext } from 'react'
import { getCodeFile, listCodeSources } from './api'
import type { CodeSource } from './types'

export interface ToolFileAccess {
  readFile: (path: string) => Promise<string | null>
  openInCode: (path: string, line: number | null) => Promise<boolean>
}

export const ToolFileContext = createContext<ToolFileAccess | null>(null)

export interface ToolFileLocation {
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

export function createToolFileAccess(
  projectId: string,
  open: (location: ToolFileLocation, line: number | null) => void,
): ToolFileAccess {
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
    async openInCode(path, line) {
      const location = await locate(path)
      if (location) open(location, line)
      return location !== null
    },
  }
}

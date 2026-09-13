import type { CodeOpenFile } from './CodeReader'

/** Ce que l'onglet Code retrouve quand on y revient depuis la même conversation. */
export interface CodeViewMemory {
  scopeId?: string | null
  openFile?: CodeOpenFile | null
  readerScrollTop?: number
  expandedDirectories?: string[]
  selected?: { sha: string, source: string } | null
  detailView?: 'commit' | 'changes'
  graphExpanded?: boolean
  branchOnly?: boolean
  conversationFilter?: string
  hiddenRepositories?: string[]
}

const memories = new Map<string, CodeViewMemory>()

export function codeViewMemoryKey(projectId: string, conversationId: string | null): string {
  return `${projectId}\n${conversationId ?? ''}`
}

export function readCodeViewMemory(key: string): CodeViewMemory {
  return memories.get(key) ?? {}
}

export function writeCodeViewMemory(key: string, patch: CodeViewMemory): void {
  memories.set(key, { ...memories.get(key), ...patch })
}

export function resetCodeViewMemory(): void {
  memories.clear()
}

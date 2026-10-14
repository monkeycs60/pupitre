import type { ChangedFileDiff } from './api'

const HIDDEN_META = /^(diff --git |index |--- |\+\+\+ |similarity index |rename from |rename to |new file mode |deleted file mode |old mode |new mode )/

export interface DiffLine {
  kind: 'addition' | 'deletion' | 'context' | 'meta'
  text: string
  oldLine: number | null
  newLine: number | null
}

export function parseUnifiedDiff(diff: string): DiffLine[] {
  let oldLine: number | null = null
  let newLine: number | null = null
  return diff.split('\n').map((text) => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      return { kind: 'meta', text, oldLine: null, newLine: null }
    }
    if (oldLine === null || newLine === null || text.startsWith('diff ') || text.startsWith('index ') || text.startsWith('--- ') || text.startsWith('+++ ')) {
      return { kind: 'meta', text, oldLine: null, newLine: null }
    }
    if (text.startsWith('+')) return { kind: 'addition', text, oldLine: null, newLine: newLine++ }
    if (text.startsWith('-')) return { kind: 'deletion', text, oldLine: oldLine++, newLine: null }
    const row = { kind: 'context' as const, text, oldLine, newLine }
    oldLine += 1
    newLine += 1
    return row
  })
}

export function codeDiffRows(diff: string): DiffLine[] {
  return parseUnifiedDiff(diff).filter((line) => line.kind !== 'meta' || (line.text !== '' && !HIDDEN_META.test(line.text)))
}

export function isCodeLine(line: DiffLine): boolean {
  return line.kind === 'addition' || line.kind === 'deletion' || line.kind === 'context'
}

const GENERATED_FILE = /(?:^|\/)(?:dist|build)\/|(?:\.lock|-lock\.json|\.snap)$/
const MAX_FILE_DIFF_LINES = 3_000

/** Découpe un `git diff` multi-fichiers en un bloc par fichier, comme le fait le sidecar pour « Voir les changements ». */
export function splitUnifiedDiff(diff: string, worktreePath: string | null): ChangedFileDiff[] {
  const files: ChangedFileDiff[] = []
  for (const block of diff.split(/^(?=diff --git )/m)) {
    if (!block.startsWith('diff --git ')) continue
    const lines = block.replace(/\n$/, '').split('\n')
    const header = lines[0]!.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/)
    let previous = header?.[1] ?? ''
    let path = header?.[2] ?? previous
    let status: ChangedFileDiff['status'] = 'modified'
    let binary = false
    let added = 0
    let removed = 0
    let firstLine: number | null = null
    let inHunks = false
    let newLine = 0
    for (const line of lines) {
      if (!inHunks) {
        if (line.startsWith('new file mode')) status = 'added'
        else if (line.startsWith('deleted file mode')) status = 'deleted'
        else if (line.startsWith('rename from ')) { status = 'renamed'; previous = line.slice(12) }
        else if (line.startsWith('rename to ')) path = line.slice(10)
        else if (line.startsWith('Binary files ')) binary = true
      }
      if (line.startsWith('@@ ')) {
        inHunks = true
        newLine = Number(line.match(/\+(\d+)/)?.[1] ?? 1)
      } else if (inHunks && line.startsWith('+')) {
        added += 1
        firstLine ??= Math.max(1, newLine)
        newLine += 1
      } else if (inHunks && line.startsWith('-')) {
        removed += 1
        firstLine ??= Math.max(1, newLine)
      } else if (inHunks && !line.startsWith('\\')) {
        newLine += 1
      }
    }
    const truncated = lines.length > MAX_FILE_DIFF_LINES
    files.push({
      path,
      previousPath: status === 'renamed' ? previous : null,
      status,
      added,
      removed,
      binary,
      generated: GENERATED_FILE.test(path),
      diff: (truncated ? lines.slice(0, MAX_FILE_DIFF_LINES) : lines).join('\n'),
      truncated,
      absolutePath: status === 'deleted' || worktreePath === null ? null : `${worktreePath}/${path}`,
      firstLine: status === 'deleted' ? null : firstLine,
    })
  }
  return files
}

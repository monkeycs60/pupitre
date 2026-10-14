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

import type { EventBlock } from './eventBlocks'

type ToolBlock = Extract<EventBlock, { kind: 'tool' }>

export interface ToolDiffLine {
  kind: 'added' | 'removed' | 'context' | 'gap'
  text: string
  line?: number
}

export interface ToolDiffFile {
  path: string
  status: 'added' | 'deleted' | 'modified'
  lines: ToolDiffLine[]
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function linesOf(text: string): string[] {
  return text.replace(/\n$/, '').split('\n')
}

function replacement(oldText: unknown, newText: unknown): ToolDiffLine[] {
  return [
    ...(typeof oldText === 'string' && oldText ? linesOf(oldText).map((text) => ({ kind: 'removed' as const, text })) : []),
    ...(typeof newText === 'string' && newText ? linesOf(newText).map((text) => ({ kind: 'added' as const, text })) : []),
  ]
}

function numbered(text: string, kind: 'added' | 'removed'): ToolDiffLine[] {
  return text ? linesOf(text).map((line, index) => ({ kind, text: line, line: index + 1 })) : []
}

function unifiedDiffLines(diff: string): ToolDiffLine[] {
  const lines: ToolDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  for (const text of linesOf(diff)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      lines.push({ kind: 'gap', text: hunk[3] })
    } else if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('\\')) {
      continue
    } else if (text.startsWith('+')) {
      lines.push({ kind: 'added', text: text.slice(1), line: newLine++ })
    } else if (text.startsWith('-')) {
      lines.push({ kind: 'removed', text: text.slice(1), line: oldLine++ })
    } else {
      lines.push({ kind: 'context', text: text.slice(1), line: newLine++ })
      oldLine += 1
    }
  }
  return lines[0]?.kind === 'gap' && !lines[0].text ? lines.slice(1) : lines
}

function applyPatchFiles(command: string): ToolDiffFile[] {
  const files: ToolDiffFile[] = []
  let inPatch = false
  for (const line of command.split('\n')) {
    const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line)
    const current = files.at(-1)
    if (line.startsWith('*** Begin Patch')) inPatch = true
    else if (line.startsWith('*** End Patch')) inPatch = false
    else if (!inPatch) continue
    else if (header) files.push({ path: header[2].trim(), status: header[1] === 'Add' ? 'added' : header[1] === 'Delete' ? 'deleted' : 'modified', lines: [] })
    else if (!current || line.startsWith('*** ')) continue
    else if (line.startsWith('@@')) current.lines.push({ kind: 'gap', text: line.slice(2).trim() })
    else if (line.startsWith('+')) current.lines.push({ kind: 'added', text: line.slice(1) })
    else if (line.startsWith('-')) current.lines.push({ kind: 'removed', text: line.slice(1) })
    else current.lines.push({ kind: 'context', text: line.slice(1) })
  }
  return files
}

function fileChangeFiles(input: Record<string, unknown>): ToolDiffFile[] {
  return (Array.isArray(input.changes) ? input.changes : []).flatMap((raw): ToolDiffFile[] => {
    const change = recordOf(raw)
    if (typeof change.path !== 'string') return []
    const diff = typeof change.diff === 'string' ? change.diff : ''
    const path = typeof change.movePath === 'string' ? change.movePath : change.path
    if (change.kind === 'add') return [{ path, status: 'added', lines: numbered(diff, 'added') }]
    if (change.kind === 'delete') return [{ path, status: 'deleted', lines: numbered(diff, 'removed') }]
    return [{ path, status: 'modified', lines: unifiedDiffLines(diff) }]
  })
}

function dedented(file: ToolDiffFile): ToolDiffFile {
  const indents = file.lines
    .filter((line) => line.kind !== 'gap' && line.text.trim())
    .map((line) => /^[ \t]*/.exec(line.text)![0])
  if (indents.length === 0) return file
  let common = indents[0]
  for (const indent of indents) {
    while (!indent.startsWith(common)) common = common.slice(0, -1)
  }
  if (!common) return file
  return {
    ...file,
    lines: file.lines.map((line) => line.kind === 'gap' ? line : { ...line, text: line.text.startsWith(common) ? line.text.slice(common.length) : line.text.trimStart() }),
  }
}

export function toolDiff(tool: ToolBlock): ToolDiffFile[] | null {
  const input = recordOf(tool.input)
  const path = typeof input.file_path === 'string' ? input.file_path : ''
  let files: ToolDiffFile[] = []
  switch (tool.toolName.toLocaleLowerCase('en-US')) {
    case 'edit':
      files = [{ path, status: 'modified', lines: replacement(input.old_string, input.new_string) }]
      break
    case 'multiedit':
      files = [{
        path,
        status: 'modified',
        lines: (Array.isArray(input.edits) ? input.edits : []).flatMap((raw, index) => {
          const edit = recordOf(raw)
          return [...(index > 0 ? [{ kind: 'gap' as const, text: '' }] : []), ...replacement(edit.old_string, edit.new_string)]
        }),
      }]
      break
    case 'write':
      files = [{ path, status: 'modified', lines: numbered(typeof input.content === 'string' ? input.content : '', 'added') }]
      break
    case 'file_change':
      files = fileChangeFiles(input)
      break
    case 'shell':
    case 'bash':
      if (typeof input.command === 'string') files = applyPatchFiles(input.command)
      break
  }
  files = files.filter((file) => file.lines.some((line) => line.kind === 'added' || line.kind === 'removed'))
  return files.length > 0 ? files.map(dedented) : null
}

export function changedRange(before: string, after: string): { before: [number, number]; after: [number, number] } | null {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1
  const shared = prefix + suffix
  if (shared === 0 || shared < Math.min(before.length, after.length) * 0.3) return null
  return { before: [prefix, before.length - suffix], after: [prefix, after.length - suffix] }
}

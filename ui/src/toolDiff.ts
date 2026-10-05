import type { EventBlock } from './eventBlocks'

type ToolBlock = Extract<EventBlock, { kind: 'tool' }>

export interface ToolDiffLine {
  kind: 'added' | 'removed' | 'context' | 'file' | 'gap'
  text: string
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

function patchLines(command: string): ToolDiffLine[] {
  const lines: ToolDiffLine[] = []
  let inPatch = false
  for (const line of command.split('\n')) {
    if (line.startsWith('*** Begin Patch')) inPatch = true
    else if (line.startsWith('*** End Patch')) inPatch = false
    else if (!inPatch) continue
    else if (/^\*\*\* (Update|Add|Delete) File: /.test(line)) lines.push({ kind: 'file', text: line.replace(/^\*\*\* \w+ File: /, '').trim() })
    else if (line.startsWith('@@')) lines.push({ kind: 'gap', text: line.slice(2).trim() })
    else if (line.startsWith('*** ')) continue
    else if (line.startsWith('+')) lines.push({ kind: 'added', text: line.slice(1) })
    else if (line.startsWith('-')) lines.push({ kind: 'removed', text: line.slice(1) })
    else lines.push({ kind: 'context', text: line.slice(1) })
  }
  return lines
}

export function toolDiff(tool: ToolBlock): ToolDiffLine[] | null {
  const input = tool.input !== null && typeof tool.input === 'object' ? tool.input as Record<string, unknown> : {}
  let lines: ToolDiffLine[] = []
  switch (tool.toolName.toLocaleLowerCase('en-US')) {
    case 'edit':
      lines = replacement(input.old_string, input.new_string)
      break
    case 'multiedit':
      lines = (Array.isArray(input.edits) ? input.edits : []).flatMap((raw, index) => {
        const edit = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
        return [...(index > 0 ? [{ kind: 'gap' as const, text: '' }] : []), ...replacement(edit.old_string, edit.new_string)]
      })
      break
    case 'write':
      lines = replacement(undefined, input.content)
      break
    case 'shell':
    case 'bash':
      if (typeof input.command === 'string') lines = patchLines(input.command)
      break
  }
  return lines.some((line) => line.kind === 'added' || line.kind === 'removed') ? lines : null
}

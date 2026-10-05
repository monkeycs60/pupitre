import type { EventBlock } from './eventBlocks'

type ToolBlock = Extract<EventBlock, { kind: 'tool' }>

export type ToolCategory = 'read' | 'search' | 'edit' | 'command' | 'web' | 'agent' | 'other'

export interface ToolPresentation {
  label: string
  detail?: string
  category: ToolCategory
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function textField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key]) return record[key]
  }
  return undefined
}

function basename(path: string): string {
  return path.split(/[/\\]/).at(-1) || path
}

function shortPath(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean)
  return segments.length > 2 ? segments.slice(-2).join('/') : path
}

/** Codex enveloppe ses commandes dans `bash -lc '…'` : seule la commande utile est montrée. */
function readableCommand(command: string): string {
  const wrapped = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim())
  return (wrapped?.[2] ?? command).replace(/\s+/g, ' ').trim()
}

function shellPresentation(input: Record<string, unknown>): ToolPresentation {
  const command = readableCommand(textField(input, 'command') ?? '')
  const description = textField(input, 'description')
  const actions = Array.isArray(input.actions) ? input.actions.map(recordOf) : []
  const actionPath = textField(actions[0] ?? {}, 'path')
  const normalized = command.toLocaleLowerCase('en-US')
  const detail = command || undefined

  if (command.includes('*** Begin Patch') || actions.some((action) => !['read', 'list', 'listFiles', 'search'].includes(textField(action, 'type') ?? ''))) {
    return { label: 'Modification', detail: actionPath ? shortPath(actionPath) : description, category: 'edit' }
  }
  if (description) {
    const category = /^\s*(rg|grep|find|fd)\b/.test(normalized) ? 'search'
      : /^\s*(cat|sed -n|head|tail)\b/.test(normalized) ? 'read'
      : 'command'
    return { label: description, detail, category }
  }
  if (/\b(bun|npm|pnpm|yarn)\s+(run\s+)?test\b|\b(pytest|vitest|jest|cargo test)\b/.test(normalized)) {
    return { label: 'Tests', detail, category: 'command' }
  }
  if (/\b(bun|npm|pnpm|yarn)\s+(run\s+)?(build|lint|typecheck)\b|\b(cargo check|tsc)\b/.test(normalized)) {
    return { label: 'Vérification', detail, category: 'command' }
  }
  if (actions.length > 0 && actions.every((action) => action.type === 'read')) {
    return { label: 'Lecture', detail: actionPath ? shortPath(actionPath) : detail, category: 'read' }
  }
  if (/^\s*(rg|grep|find|fd)\b/.test(normalized) || actions.some((action) => action.type === 'search')) {
    return { label: 'Recherche', detail, category: 'search' }
  }
  if (/^\s*(sed|cat|head|tail|less|ls)\b/.test(normalized)) return { label: 'Lecture', detail, category: 'read' }
  if (/\bgit\s+(status|log|diff|show|branch)\b/.test(normalized)) return { label: 'Git', detail, category: 'command' }
  if (/\b(bun|npm|pnpm|yarn)\s+(add|install)\b/.test(normalized)) return { label: 'Installation', detail, category: 'command' }
  return { label: 'Commande', detail, category: 'command' }
}

function lineRange(input: Record<string, unknown>): string {
  const offset = typeof input.offset === 'number' ? input.offset : undefined
  const limit = typeof input.limit === 'number' ? input.limit : undefined
  if (offset === undefined && limit === undefined) return ''
  const start = offset ?? 1
  return limit === undefined ? ` L${start}+` : ` L${start}-${start + limit - 1}`
}

export function toolPresentation(tool: ToolBlock): ToolPresentation {
  const input = recordOf(tool.input)
  const path = textField(input, 'file_path', 'notebook_path', 'path')
  const pattern = textField(input, 'pattern', 'query')

  switch (tool.toolName.toLocaleLowerCase('en-US')) {
    case 'shell':
    case 'bash':
      return shellPresentation(input)
    case 'read':
      return { label: 'Lecture', detail: path ? `${shortPath(path)}${lineRange(input)}` : undefined, category: 'read' }
    case 'write':
      return { label: 'Écriture', detail: path ? shortPath(path) : undefined, category: 'edit' }
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
      return { label: 'Modification', detail: path ? shortPath(path) : undefined, category: 'edit' }
    case 'file_change': {
      const changes = (Array.isArray(input.changes) ? input.changes : []).map(recordOf)
      const kinds = new Set(changes.map((change) => change.kind))
      const label = kinds.size === 1 && kinds.has('add') ? 'Création' : kinds.size === 1 && kinds.has('delete') ? 'Suppression' : 'Modification'
      const paths = changes.flatMap((change) => typeof change.path === 'string' ? [shortPath(change.path)] : [])
      return { label, detail: paths.join(', ') || undefined, category: 'edit' }
    }
    case 'grep': {
      const scope = textField(input, 'path') ?? textField(input, 'glob')
      return {
        label: 'Recherche',
        detail: pattern ? `${pattern}${scope ? ` dans ${basename(scope)}` : ''}` : undefined,
        category: 'search',
      }
    }
    case 'glob':
      return { label: 'Recherche de fichiers', detail: pattern, category: 'search' }
    case 'websearch':
      return { label: 'Recherche web', detail: pattern, category: 'web' }
    case 'webfetch':
      return { label: 'Page web', detail: textField(input, 'url'), category: 'web' }
    case 'task':
    case 'agent':
      return { label: 'Agent délégué', detail: textField(input, 'description', 'prompt'), category: 'agent' }
    case 'skill':
      return { label: 'Skill', detail: textField(input, 'skill'), category: 'other' }
    case 'toolsearch':
      return { label: 'Chargement d’outils', detail: pattern, category: 'other' }
    case 'askuserquestion':
      return { label: 'Question à l’utilisateur', category: 'other' }
    default: {
      const readableName = tool.toolName
        .replace(/^mcp__.+?__/, '')
        .replaceAll('_', ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
      return {
        label: readableName.charAt(0).toLocaleUpperCase('fr-FR') + readableName.slice(1),
        detail: textField(input, 'query', 'url', 'title', 'name', 'description', 'path'),
        category: 'other',
      }
    }
  }
}

const CATEGORY_NOUNS: Record<ToolCategory, [string, string]> = {
  read: ['lecture', 'lectures'],
  search: ['recherche', 'recherches'],
  edit: ['modification', 'modifications'],
  command: ['commande', 'commandes'],
  web: ['recherche web', 'recherches web'],
  agent: ['agent', 'agents'],
  other: ['action', 'actions'],
}

export function toolGroupSummary(tools: ToolBlock[]): string {
  const counts = new Map<ToolCategory, number>()
  for (const tool of tools) {
    const category = toolPresentation(tool).category
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return Array.from(counts, ([category, count]) => `${count} ${CATEGORY_NOUNS[category][count > 1 ? 1 : 0]}`).join(' · ')
}

import type { EventBlock } from './eventBlocks'

type ToolBlock = Extract<EventBlock, { kind: 'tool' }>

export interface ToolPresentation {
  label: string
  detail?: string
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

function shellPresentation(input: Record<string, unknown>): ToolPresentation {
  const command = textField(input, 'command') ?? ''
  const actions = Array.isArray(input.actions) ? input.actions : []
  const firstAction = recordOf(actions[0])
  const actionPath = textField(firstAction, 'path')
  const normalized = command.toLocaleLowerCase('en-US')
  const detail = actionPath ? basename(actionPath) : undefined

  if (command.includes('*** Begin Patch') || actions.some((action) => {
    const type = textField(recordOf(action), 'type') ?? ''
    return !['read', 'list', 'search'].includes(type)
  })) {
    return { label: actionPath ? `Modification de ${basename(actionPath)}` : 'Modification de fichiers', detail }
  }
  if (/\b(bun|npm|pnpm|yarn)\s+(run\s+)?test\b|\b(pytest|vitest|jest|cargo test)\b/.test(normalized)) {
    return { label: 'Exécution des tests', detail }
  }
  if (/\b(bun|npm|pnpm|yarn)\s+(run\s+)?(build|lint|typecheck)\b|\b(cargo check|tsc)\b/.test(normalized)) {
    return { label: 'Vérification du projet', detail }
  }
  if (/\b(rg|grep|find|fd)\b/.test(normalized)) return { label: 'Recherche dans les fichiers', detail }
  if (/\b(sed|cat|head|tail|less)\b/.test(normalized) || firstAction.type === 'read') {
    return { label: actionPath ? `Lecture de ${basename(actionPath)}` : 'Lecture de fichiers', detail }
  }
  if (/\bgit\s+(status|log|diff|show|branch)\b/.test(normalized)) return { label: 'Inspection du dépôt Git', detail }
  if (/\b(bun|npm|pnpm|yarn)\s+(add|install)\b/.test(normalized)) return { label: 'Installation des dépendances', detail }
  return { label: 'Exécution d’une commande' }
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
      return { label: path ? 'Lecture' : 'Lecture d’un fichier', detail: path ? basename(path) : undefined }
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
      return { label: path ? 'Modification' : 'Modification d’un fichier', detail: path ? basename(path) : undefined }
    case 'grep':
      return { label: pattern ? `Recherche de « ${pattern} »` : 'Recherche dans les fichiers', detail: textField(input, 'path') ? basename(textField(input, 'path')!) : undefined }
    case 'glob':
      return { label: 'Recherche de fichiers', detail: pattern }
    case 'websearch':
      return { label: 'Recherche sur le web', detail: pattern }
    case 'webfetch':
      return { label: 'Consultation d’une page web', detail: textField(input, 'url') }
    case 'task':
      return { label: 'Délégation à un agent', detail: textField(input, 'description', 'prompt') }
    case 'skill':
      return { label: 'Chargement d’un skill', detail: textField(input, 'skill') }
    case 'askuserquestion':
      return { label: 'Question à l’utilisateur' }
    default: {
      const readableName = tool.toolName
        .replace(/^mcp__[^_]+__/, '')
        .replaceAll('_', ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
      return { label: readableName.charAt(0).toLocaleUpperCase('fr-FR') + readableName.slice(1) }
    }
  }
}

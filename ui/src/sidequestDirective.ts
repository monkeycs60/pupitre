export interface SidequestDirective {
  instruction: string
  model?: string
}

export function parseSidequestDirective(message: string): SidequestDirective | null {
  const trimmed = message.trim()
  if (!trimmed.startsWith('@sidequest')) return null
  const match = trimmed.match(/^@sidequest(?:\(\s*model\s*=\s*(["'])(.*?)\1\s*\))?\s+([\s\S]+)$/i)
  if (!match) throw new Error('Syntaxe : @sidequest ou @sidequest(model="…"), suivi de la consigne')
  const instruction = match[3]!.trim()
  if (!instruction) throw new Error('La sidequest requiert une consigne')
  return { instruction, ...(match[2]?.trim() ? { model: match[2].trim() } : {}) }
}

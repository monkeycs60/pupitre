export function parseContinueDirective(message: string): { instruction: string } | null {
  const match = message.trim().match(/^@continue(?:\s+([\s\S]*))?$/i)
  return match ? { instruction: match[1]?.trim() ?? '' } : null
}

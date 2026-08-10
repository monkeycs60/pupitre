const ANSI_SEQUENCE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
)

export function summarizeTurnError(value: string): { message: string; details: string | null } {
  const cleaned = value
    .replace(ANSI_SEQUENCE, '')
    .replace(/\\u001b\[[0-9;]*m/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  const separator = cleaned.indexOf(' : ')
  if (separator > 0 && separator <= 180) {
    return {
      message: cleaned.slice(0, separator),
      details: cleaned.slice(separator + 3).trim() || null,
    }
  }
  if (cleaned.length <= 220) return { message: cleaned, details: null }
  return { message: `${cleaned.slice(0, 217).trimEnd()}…`, details: cleaned }
}

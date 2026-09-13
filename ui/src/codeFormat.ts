import type { CodeSource } from './types'

const MONTHS =['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

export function relativeCodeDate(iso: string | null, now = Date.now()): string {
  if (!iso) return ''
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const minutes = Math.round((now - time) / 60_000)
  if (minutes < 1) return 'à l’instant'
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  const days = Math.round(hours / 24)
  if (days < 7) return `il y a ${days} j`
  const date = new Date(time)
  const label = `${date.getDate()} ${MONTHS[date.getMonth()]}`
  return date.getFullYear() === new Date(now).getFullYear() ? label : `${label} ${date.getFullYear()}`
}

export function absoluteCodeDate(iso: string | null): string {
  if (!iso) return ''
  const time = Date.parse(iso)
  return Number.isNaN(time) ? '' : new Date(time).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })
}

export function splitCodePath(path: string): { directory: string, name: string } {
  const index = path.lastIndexOf('/')
  return index === -1 ? { directory: '', name: path } : { directory: path.slice(0, index), name: path.slice(index + 1) }
}

export function codeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function defaultCodeSource(
  sources: CodeSource[],
  conversationId: string | null,
  worktreePath: string | null,
): string | null {
  if (conversationId) {
    const holder = sources.find((source) => !source.main && source.conversations.some((item) => item.id === conversationId))
      ?? sources.find((source) => source.path === worktreePath)
      ?? sources.find((source) => source.conversations.some((item) => item.id === conversationId))
    if (holder) return holder.path
  }
  return sources[0]?.path ?? null
}

export const DIRTY_LABELS: Record<string, string> = {
  M: 'modifié',
  A: 'ajouté',
  D: 'supprimé',
  R: 'renommé',
  '?': 'non suivi',
}

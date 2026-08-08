import { parseUnifiedDiff } from './reviewDiff'
import type { ReviewFlag, ReviewSeverity } from './types'

export interface FileEntry {
  path: string
  additions: number
  deletions: number
  counts: Record<ReviewSeverity, number>
  openCount: number
}

const CLOSED_STATUSES = new Set(['treated', 'ignored', 'resolved'])

/** Résumé stable, dans l'ordre du diff, pour la colonne des fichiers Git. */
export function buildFileTree(diff: string, flags: ReviewFlag[]): FileEntry[] {
  const entries = new Map<string, FileEntry>()
  for (const line of parseUnifiedDiff(diff, [])) {
    if (line.file === null) continue
    let entry = entries.get(line.file)
    if (!entry) {
      entry = {
        path: line.file,
        additions: 0,
        deletions: 0,
        counts: { red: 0, orange: 0, grey: 0 },
        openCount: 0,
      }
      entries.set(line.file, entry)
    }
    if (line.kind === 'addition') entry.additions += 1
    if (line.kind === 'deletion') entry.deletions += 1
  }
  for (const flag of flags) {
    const entry = entries.get(flag.file)
    if (!entry) continue
    entry.counts[flag.severity] += 1
    if (!CLOSED_STATUSES.has(flag.status)) entry.openCount += 1
  }
  return [...entries.values()]
}

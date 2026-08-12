import type { ReviewFlag, ReviewSeverity } from './types'

export type DiffLineKind = 'meta' | 'hunk' | 'context' | 'addition' | 'deletion'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  file: string | null
  oldLine: number | null
  newLine: number | null
  flags: ReviewFlag[]
  /** Flags dont cette ligne est l'ancre de carte (dernière ligne du range). */
  cardFlags: ReviewFlag[]
  severity: ReviewSeverity | null
}

/** Texte initial proposé au sous-agent pour un signalement. */
export function flagActionDraft(flag: ReviewFlag): string {
  return flag.message
}

/** Mise à jour locale sûre pendant la requête PATCH. */
export function optimisticFlagStatus(
  flag: ReviewFlag,
  status: Extract<ReviewFlag['status'], 'treated' | 'ignored'>,
): ReviewFlag {
  return { ...flag, status }
}

const SEVERITY_WEIGHT: Record<ReviewSeverity, number> = {
  grey: 1,
  orange: 2,
  red: 3,
}

export function parseUnifiedDiff(diff: string, flags: ReviewFlag[]): DiffLine[] {
  let oldFile: string | null = null
  let file: string | null = null
  let oldCursor = 0
  let newCursor = 0

  const lines = diff.split('\n').map((text): DiffLine => {
    let kind: DiffLineKind = 'meta'
    let oldLine: number | null = null
    let newLine: number | null = null

    if (text.startsWith('--- ')) {
      oldFile = diffPath(text.slice(4))
    } else if (text.startsWith('+++ ')) {
      file = diffPath(text.slice(4)) ?? oldFile
    } else {
      const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (hunk) {
        kind = 'hunk'
        oldCursor = Number(hunk[1])
        newCursor = Number(hunk[2])
      } else if (text.startsWith('+')) {
        kind = 'addition'
        newLine = newCursor++
      } else if (text.startsWith('-')) {
        kind = 'deletion'
        oldLine = oldCursor++
      } else if (text.startsWith(' ')) {
        kind = 'context'
        oldLine = oldCursor++
        newLine = newCursor++
      }
    }

    const matchingFlags = file === null
      ? []
      : flags.filter((flag) =>
          flag.file === file
          && (inRange(oldLine, flag.line_start, flag.line_end)
            || inRange(newLine, flag.line_start, flag.line_end)),
        )
    const severity = matchingFlags.reduce<ReviewSeverity | null>((highest, flag) => {
      if (highest === null || SEVERITY_WEIGHT[flag.severity] > SEVERITY_WEIGHT[highest]) {
        return flag.severity
      }
      return highest
    }, null)

    return { kind, text, file, oldLine, newLine, flags: matchingFlags, cardFlags: [], severity }
  })

  // Un signalement peut matcher plusieurs lignes (côtés ancien et nouveau) :
  // seule la dernière porte la carte, sinon elle est dupliquée à l'écran.
  for (const flag of flags) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]!.flags.includes(flag)) {
        lines[index]!.cardFlags.push(flag)
        break
      }
    }
  }
  return lines
}

function diffPath(raw: string): string | null {
  const path = raw.trim()
  if (path === '/dev/null') return null
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path
}

function inRange(line: number | null, start: number, end: number): boolean {
  return line !== null && line >= start && line <= end
}

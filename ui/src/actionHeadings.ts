import { createContext } from 'react'
import type { SectionKind } from './taskToggle'

/** Miroir de sidecar/src/response-format.ts. */
export interface ActionFormat {
  enabled: boolean
  todoHeadings: string[]
  followUpHeadings: string[]
}

export const DEFAULT_ACTION_FORMAT: ActionFormat = {
  enabled: true,
  todoHeadings: ['TODO', 'DO THIS', 'NEXT STEPS', 'PROCHAINES ÉTAPES', 'À FAIRE'],
  followUpHeadings: ['FOLLOW-UP', 'FOLLOW UP', 'PISTES', 'POUR ALLER PLUS LOIN'],
}

export const ActionFormatContext = createContext<ActionFormat>(DEFAULT_ACTION_FORMAT)

/** Retire la décoration Markdown d'un titre pour le comparer aux intitulés. */
function bareHeading(line: string): string {
  return line.trim().replace(/[*_#`:]/gu, '').trim().toUpperCase()
}

/** Section correspondant à une ligne de titre, ou null si ce n'en est pas une. */
export function headingKind(line: string, format: ActionFormat): SectionKind | null {
  const bare = bareHeading(line)
  if (!bare) return null
  if (format.todoHeadings.includes(bare)) return 'do-this'
  if (format.followUpHeadings.includes(bare)) return 'follow-up'
  return null
}

import { createContext } from 'react'

/** Les deux blocs actionnables d'une réponse. */
export type SectionKind = 'do-this' | 'follow-up'

/** Une ligne cochable, identifiée par sa section et son numéro affiché. */
export interface TaskAction {
  scope: string
  index: number
  label: string
  kind: SectionKind
}

/**
 * Fourni par Chat, consommé par Markdown : évite de faire descendre un callback
 * à travers EventView et tous les composants qui rendent du Markdown.
 * `null` = cases à cocher inertes (aperçus, aide, bibliothèque de skills).
 */
export const TaskToggleContext =
  createContext<((action: TaskAction, checked: boolean) => void) | null>(null)

/** Sélections du composeur, partagées avec chaque message du fil. */
export const TaskSelectionContext = createContext<TaskAction[]>([])

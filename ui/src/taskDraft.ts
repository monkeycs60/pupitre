import type { SectionKind, TaskAction } from './taskToggle'

/**
 * Cases à cocher des blocs *DO THIS* et *FOLLOW-UP* : cocher compose une
 * consigne explicite dans le composeur, plutôt que de coller le texte brut —
 * ces blocs sont formulés comme des propositions, et le modèle doit savoir
 * qu'on lui demande de les traiter.
 */

const HEADERS: Record<SectionKind, { one: string; many: string; block: string }> = {
  'do-this': {
    one: "Exécute l'action",
    many: 'Exécute les actions',
    block: 'DO THIS',
  },
  'follow-up': {
    one: 'Explore la piste',
    many: 'Explore les pistes',
    block: 'FOLLOW-UP',
  },
}

/** Ordre d'apparition des blocs composés, indépendant de l'ordre des clics. */
const SECTION_ORDER: SectionKind[] = ['do-this', 'follow-up']

const BLOCK_START =
  /(^|\n)(?:Exécute l(?:'action|es actions)|Explore l(?:a piste|es pistes)) [\d,\s]*\d(?: et \d+)? du bloc (?:DO THIS|FOLLOW-UP) :/u

/** Retire les blocs générés précédemment ; le texte saisi à la main survit. */
function stripActionBlocks(message: string): string {
  const match = message.match(BLOCK_START)
  if (match?.index === undefined) return message
  return message.slice(0, match.index + (match[1] === '\n' ? 1 : 0))
}

function enumerate(numbers: number[]): string {
  if (numbers.length === 1) return String(numbers[0])
  return `${numbers.slice(0, -1).join(', ')} et ${numbers.at(-1)}`
}

function composeSection(kind: SectionKind, actions: TaskAction[]): string | null {
  const sorted = [...actions].sort((left, right) => left.index - right.index)
  if (sorted.length === 0) return null
  const header = HEADERS[kind]
  const verb = sorted.length === 1 ? header.one : header.many
  return [
    `${verb} ${enumerate(sorted.map((action) => action.index))} du bloc ${header.block} :`,
    ...sorted.map((action) => `${action.index}) ${action.label.trim()}`),
  ].join('\n')
}

/**
 * Reconstruit le brouillon depuis la sélection courante. Recomposer plutôt
 * qu'ajouter ligne à ligne garde les en-têtes cohérents quel que soit l'ordre
 * dans lequel les cases ont été cochées.
 */
export function withTaskActions(message: string, actions: TaskAction[]): string {
  const base = stripActionBlocks(message).replace(/\s+$/u, '')
  const usable = actions.filter((action) => action.label.trim())
  const blocks = SECTION_ORDER
    .map((kind) => composeSection(kind, usable.filter((action) => action.kind === kind)))
    .filter((block): block is string => block !== null)
  if (blocks.length === 0) return base
  const composed = blocks.join('\n\n')
  return base ? `${base}\n\n${composed}` : composed
}

/** Ajoute ou retire une ligne de la sélection, sans doublon. */
export function toggleAction(
  actions: TaskAction[],
  action: TaskAction,
  checked: boolean,
): TaskAction[] {
  const others = actions.filter(
    (current) => !(current.index === action.index && current.kind === action.kind),
  )
  return checked ? [...others, action] : others
}

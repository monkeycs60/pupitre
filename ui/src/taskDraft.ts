import type { SectionKind, TaskAction } from './taskToggle'
import { headingKind } from './actionHeadings'
import type { ActionFormat } from './actionHeadings'

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
    one: 'Réalise la piste',
    many: 'Réalise les pistes',
    block: 'FOLLOW-UP',
  },
}

/** Ordre d'apparition des blocs composés, indépendant de l'ordre des clics. */
const SECTION_ORDER: SectionKind[] = ['do-this', 'follow-up']

const HEADER_PATTERN =
  '(?:Exécute l(?:\'action|es actions)|(?:Explore|Réalise) l(?:a piste|es pistes)) [\\d,\\s]*\\d(?: et \\d+)? du bloc (DO THIS|FOLLOW-UP) :'

const BLOCK_START = new RegExp(`(^|\\n)${HEADER_PATTERN}`, 'u')
const HEADER_LINE = new RegExp(`^${HEADER_PATTERN}`, 'u')
const ITEM_LINE = /^(\d+)\) (.*)$/u

const KIND_BY_BLOCK: Record<string, SectionKind> = {
  'DO THIS': 'do-this',
  'FOLLOW-UP': 'follow-up',
}

interface SplitDraft {
  base: string
  bodies: Map<TaskAction, string>
}

/**
 * Sépare le texte libre des blocs générés. Chaque ligne numérotée garde ce que
 * l'utilisateur y a écrit — note en fin de ligne ou lignes suivantes — tant
 * que l'action reste cochée.
 */
function splitDraft(message: string, actions: TaskAction[]): SplitDraft {
  const bodies = new Map<TaskAction, string>()
  const match = message.match(BLOCK_START)
  if (match?.index === undefined) return { base: message, bodies }
  const cut = match.index + (match[1] === '\n' ? 1 : 0)
  let kind: SectionKind | null = null
  let current: TaskAction | null = null
  const lines = new Map<TaskAction, string[]>()
  for (const line of message.slice(cut).split('\n')) {
    const header = line.match(HEADER_LINE)
    if (header) {
      kind = KIND_BY_BLOCK[header[1]]
      current = null
      continue
    }
    const item = line.match(ITEM_LINE)
    if (item && kind) {
      current = claimAction(actions, lines, kind, Number(item[1]), item[2])
      if (current) lines.set(current, [item[2]])
      continue
    }
    if (current) lines.get(current)?.push(line)
  }
  for (const [action, body] of lines) bodies.set(action, body.join('\n').replace(/\s+$/u, ''))
  return { base: message.slice(0, cut), bodies }
}

function claimAction(
  actions: TaskAction[],
  claimed: Map<TaskAction, string[]>,
  kind: SectionKind,
  index: number,
  text: string,
): TaskAction | null {
  const free = actions.filter(
    (action) => action.kind === kind && action.index === index && !claimed.has(action),
  )
  return free.find((action) => text.startsWith(action.label.trim())) ?? free[0] ?? null
}

function enumerate(numbers: number[]): string {
  if (numbers.length === 1) return String(numbers[0])
  return `${numbers.slice(0, -1).join(', ')} et ${numbers.at(-1)}`
}

function composeSection(
  kind: SectionKind,
  actions: TaskAction[],
  bodies: Map<TaskAction, string>,
): string | null {
  const sorted = [...actions].sort((left, right) => left.index - right.index)
  if (sorted.length === 0) return null
  const header = HEADERS[kind]
  const verb = sorted.length === 1 ? header.one : header.many
  return [
    `${verb} ${enumerate(sorted.map((action) => action.index))} du bloc ${header.block} :`,
    ...sorted.map((action) => `${action.index}) ${bodies.get(action) || action.label.trim()}`),
  ].join('\n')
}

/**
 * Reconstruit le brouillon depuis la sélection courante. Recomposer plutôt
 * qu'ajouter ligne à ligne garde les en-têtes cohérents quel que soit l'ordre
 * dans lequel les cases ont été cochées.
 */
export function withTaskActions(message: string, actions: TaskAction[]): string {
  const usable = actions.filter((action) => action.label.trim())
  const split = splitDraft(message, usable)
  const base = split.base.replace(/\s+$/u, '')
  const blocks = SECTION_ORDER
    .map((kind) => composeSection(
      kind,
      usable.filter((action) => action.kind === kind),
      split.bodies,
    ))
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
    (current) => !(
      current.scope === action.scope
      && current.index === action.index
      && current.kind === action.kind
    ),
  )
  return checked ? [...others, action] : others
}

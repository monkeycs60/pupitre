import type { AppEvent, Provider } from './types'

const MODEL_CONTEXT_WINDOWS: Partial<Record<Provider, Record<string, number>>> = {
  // Valeurs de référence affichées comme estimations : aucune décision
  // automatique n'est prise à partir de cette jauge.
  claude: {
    'fable-5': 200_000,
    opus: 200_000,
    sonnet: 200_000,
    haiku: 200_000,
  },
  codex: {
    'gpt-5.6-sol': 400_000,
    'gpt-5.6-luna': 400_000,
    'gpt-5.6-terra': 400_000,
  },
}

const FALLBACK_CONTEXT_WINDOWS: Record<Provider, number> = {
  claude: 200_000,
  codex: 400_000,
}

export interface ContextEstimate {
  usedTokens: number
  windowTokens: number
  percent: number
  nearSaturation: boolean
}

export function contextWindowTokens(provider: Provider, model: string): number {
  return MODEL_CONTEXT_WINDOWS[provider]?.[model] ?? FALLBACK_CONTEXT_WINDOWS[provider]
}

/**
 * Calibré, pas supposé : sur du français mêlé de code, deux échantillons de
 * 3 234 et 9 702 caractères envoyés au CLI coûtent respectivement 926 et 2 768
 * tokens, soit 3,49 et 3,51 caractères par token. La valeur usuelle de 4
 * sous-estimait donc toutes les parts mesurées d'environ 13 %.
 */
const CHARS_PER_TOKEN = 3.5

/**
 * Le code et le JSON se tokenisent plus finement que la prose : ponctuation,
 * identifiants découpés, indentation. Les sorties d'outils en sont presque
 * exclusivement composées.
 */
const CHARS_PER_TOKEN_CODE = 3

/**
 * Ordre de grandeur d'une capture d'écran de la taille de celles échangées
 * ici. Une image n'est pas gratuite, et ne rien compter la rendait invisible.
 */
const TOKENS_PER_IMAGE = 1_500

/** Taille de la consigne de format injectée par Pupitre à chaque tour. */
const PUPITRE_PREAMBLE_TOKENS = 95

/** Regroupement affiché dans la légende : c'est la lecture, pas le calcul. */
export type ContextGroup = 'fixe' | 'conversation' | 'outils' | 'libre'

export interface ContextPart {
  label: string
  tokens: number
  group: ContextGroup
  /** Détail d'une part agrégée, affiché sous son libellé. */
  detail?: string
  /** Déduit par soustraction plutôt que mesuré. */
  inferred?: boolean
  /**
   * Rechargé à chaque session indépendamment de la conversation : prompt
   * système, définitions d'outils MCP, mémoire projet, consigne Pupitre. On ne
   * peut pas le réduire en résumant ou en repartant d'un fil neuf.
   */
  persistent?: boolean
  /** La place encore libre dans la fenêtre, pas une consommation. */
  free?: boolean
}

function approximateTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN)
}

function approximateCodeTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN_CODE)
}

interface AssistantTextEstimate {
  /** Texte visible présent dans l'historique, deltas dédupliqués. */
  totalTokens: number
  /** Texte visible produit par le dernier tour, pour isoler son raisonnement. */
  latestTurnTokens: number
}

/**
 * Les providers envoient les deltas puis le message final complet. Le final
 * remplace donc les deltas pour le calcul, comme le fait déjà `groupEvents`.
 */
function assistantTextEstimate(events: AppEvent[]): AssistantTextEstimate {
  const turns = new Map<number, number>()
  let turn = -1
  let pending = ''

  const add = (tokens: number) => {
    if (tokens <= 0) return
    turns.set(turn, (turns.get(turn) ?? 0) + tokens)
  }

  const flushPending = () => {
    if (!pending) return
    add(approximateTokens(pending))
    pending = ''
  }

  for (const event of events) {
    if (event.type === 'user-message') {
      flushPending()
      turn += 1
    } else if (event.type === 'text-delta') {
      if (turn < 0) turn = 0
      pending += event.text
    } else if (event.type === 'text-final') {
      if (turn < 0) turn = 0
      // Le final est le texte complet : il remplace les deltas accumulés.
      pending = ''
      add(approximateTokens(event.text))
    } else if (event.type === 'tool-start' || event.type === 'status') {
      // Un flux sans final reste comptable lorsqu'il est interrompu par un
      // outil ou par la fin du tour.
      flushPending()
    }
  }
  flushPending()

  const totalTokens = [...turns.values()].reduce((sum, tokens) => sum + tokens, 0)
  return {
    totalTokens,
    latestTurnTokens: turn >= 0 ? turns.get(turn) ?? 0 : 0,
  }
}

/**
 * Décompose le contexte occupé. Le total vient du dernier snapshot provider ;
 * le détail est reconstitué depuis les événements stockés, et le reliquat
 * regroupe ce que le CLI ne publie pas (prompt système, définitions d'outils
 * MCP, mémoire projet).
 */
/** Au-delà, l'incompressible pèse assez pour valoir un arbitrage MCP. */
export const PERSISTENT_ALERT_RATIO = 0.3

/** Part du contexte rechargée à chaque session, rapportée à la fenêtre. */
export function persistentRatio(parts: ContextPart[], windowTokens: number): number {
  if (windowTokens <= 0) return 0
  const persistent = parts
    .filter((part) => part.persistent)
    .reduce((sum, part) => sum + part.tokens, 0)
  return persistent / windowTokens
}

/** Parts de la charge fixe que le sidecar sait mesurer sur disque. */
export interface ContextProfile {
  /** CLAUDE.md global et de projet, AGENTS.md, fichiers mémoire. */
  instructionsTokens?: number
  /** Somme des serveurs MCP retenus, d'après la dernière mesure. */
  mcpTokens?: number
}

export function contextParts(
  events: AppEvent[],
  usedTokens: number,
  windowTokens = 0,
  /** Coût du bridge conductor, mesuré par le sidecar ; 0 si non orchestrée. */
  conductorTokens = 0,
  /**
   * Contexte d'un tour à vide, mesuré par le sidecar : prompt système du CLI,
   * instructions globales et mémoire. 0 tant qu'aucune mesure n'a été lancée —
   * le reliquat reste alors entièrement non attribué.
   */
  baselineTokens = 0,
  /** Poids mesurés de la charge fixe, quand le sidecar a pu les établir. */
  profile: ContextProfile = {},
): ContextPart[] {
  let user = 0
  let assistantText = 0
  let tools = 0
  let turns = 0
  let images = 0

  for (const event of events) {
    if (event.type === 'user-message') {
      user += approximateTokens(event.text)
      images += event.images.length * TOKENS_PER_IMAGE
      turns += 1
    } else if (event.type === 'tool-end') {
      tools += approximateCodeTokens(event.output)
    } else if (event.type === 'tool-start') {
      tools += approximateCodeTokens(JSON.stringify(event.input ?? ''))
    }
  }

  const assistant = assistantTextEstimate(events)
  assistantText = assistant.totalTokens
  // `last` du provider décrit le dernier appel et non le cumul de la session.
  // Les snapshots précédents servent au coût, pas à la fenêtre de contexte.
  const latestUsage = events.filter((event) => event.type === 'usage').at(-1)
  const reasoning = Math.max(
    0,
    (latestUsage?.outputTokens ?? 0) - assistant.latestTurnTokens,
  )

  const pupitre = turns * PUPITRE_PREAMBLE_TOKENS
  // Une estimation locale peut rester supérieure au snapshot provider (texte
  // compacté, ratios caractères/token, historique tronqué). Dans ce cas, on
  // garde la part Pupitre et recale les catégories observées pour que leur
  // somme reste lisible et ne dépasse jamais le total de référence.
  const fixedPupitre = usedTokens > 0
    ? Math.min(usedTokens, pupitre + conductorTokens)
    : pupitre + conductorTokens
  const variableMeasured = user + images + assistantText + reasoning + tools
  const rawMeasured = variableMeasured + fixedPupitre
  if (usedTokens > 0 && rawMeasured > usedTokens && variableMeasured > 0) {
    const scale = Math.max(0, usedTokens - fixedPupitre) / variableMeasured
    user = Math.floor(user * scale)
    images = Math.floor(images * scale)
    assistantText = Math.floor(assistantText * scale)
    tools = Math.floor(tools * scale)
    // Le reliquat d'arrondi sera absorbé par « Autres » ci-dessous.
    const scaledReasoning = Math.floor(reasoning * scale)
    const measured = user + images + assistantText + scaledReasoning + tools
      + fixedPupitre
    const remainder = usedTokens > measured ? usedTokens - measured : 0
    return buildContextParts(
      { user, images, assistantText, reasoning: scaledReasoning, tools },
      usedTokens,
      windowTokens,
      fixedPupitre,
      baselineTokens,
      profile,
      remainder,
    )
  }

  const measured = variableMeasured + fixedPupitre
  // Ce que Pupitre injecte lui-même est isolé : c'est la seule part de la
  // charge fixe sur laquelle l'application a la main.
  const remainder = usedTokens > measured ? usedTokens - measured : 0
  return buildContextParts(
    { user, images, assistantText, reasoning, tools },
    usedTokens,
    windowTokens,
    fixedPupitre,
    baselineTokens,
    profile,
    remainder,
  )
}

function buildContextParts(
  values: {
    user: number
    images: number
    assistantText: number
    reasoning: number
    tools: number
  },
  usedTokens: number,
  windowTokens: number,
  fixedPupitre: number,
  baselineTokens: number,
  profile: ContextProfile,
  remainder: number,
): ContextPart[] {
  const { user, images, assistantText, reasoning, tools } = values
  // La charge fixe est bornée par une MESURE, jamais déduite : sans ce garde-fou
  // elle absorbait tout l'écart d'estimation et affichait des centaines de
  // milliers de tokens pour un prompt système qui en pèse trente mille.
  const baseline = Math.min(baselineTokens, remainder)
  // Instructions et serveurs MCP sont mesurés indépendamment : les borner par
  // la mesure de référence les faisait disparaître tant qu'elle valait zéro,
  // alors qu'on sait les chiffrer sans elle. Seul le prompt système du CLI en
  // dépend, puisqu'il s'obtient par soustraction.
  const instructions = Math.min(profile.instructionsTokens ?? 0, remainder)
  const mcp = Math.min(profile.mcpTokens ?? 0, remainder - instructions)
  const systemPrompt = Math.max(0, baseline - instructions - mcp)
  const parts: ContextPart[] = [
    {
      label: 'Prompt système du CLI',
      tokens: systemPrompt,
      group: 'fixe',
      detail: 'outils intégrés, règles du CLI — non publié, obtenu par soustraction',
      persistent: true,
      inferred: true,
    },
    {
      label: 'Instructions globales',
      tokens: instructions,
      group: 'fixe',
      detail: 'CLAUDE.md, AGENTS.md et fichiers mémoire, global et projet',
      persistent: true,
    },
    {
      label: 'Outils MCP',
      tokens: mcp,
      group: 'fixe',
      detail: 'instructions et noms d’outils des serveurs chargés',
      persistent: true,
    },
    {
      label: 'Consignes Pupitre',
      tokens: fixedPupitre,
      group: 'fixe',
      detail: 'format de réponse, et bridge de délégation si la conversation orchestre',
      persistent: true,
    },
    { label: 'Vos messages', tokens: user, group: 'conversation' },
    {
      label: 'Images et captures',
      tokens: images,
      group: 'conversation',
      detail: 'estimation : une capture pèse environ 1 500 tokens',
    },
    { label: 'Réponses de l’agent', tokens: assistantText, group: 'conversation' },
    {
      label: 'Raisonnement du modèle',
      tokens: reasoning,
      group: 'conversation',
      detail: 'tokens générés que la réponse visible ne montre pas',
    },
    {
      label: 'Autres',
      tokens: Math.max(0, remainder - systemPrompt - instructions - mcp),
      group: 'conversation',
      detail: 'contenu que les événements ne tracent pas, et écart d’estimation',
      inferred: true,
    },
    {
      label: 'Fichiers lus et commandes',
      tokens: tools,
      group: 'outils',
      detail: 'ce que les outils ont lu et renvoyé pendant les tours',
    },
  ]
  const used = parts.filter((part) => part.tokens > 0)
  // La place libre ferme l'anneau : la répartition se lit sur la fenêtre
  // entière, pas sur le seul contexte déjà consommé.
  if (windowTokens > usedTokens) {
    used.push({
      label: 'Disponible',
      tokens: windowTokens - usedTokens,
      group: 'libre',
      free: true,
    })
  }
  return used
}

export function contextEstimate(
  events: AppEvent[],
  provider: Provider,
  model: string,
): ContextEstimate {
  const usage = events.filter((event) => event.type === 'usage').at(-1)
  const usedTokens = usage?.contextTokens
    ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0))
  const windowTokens = usage?.contextWindowTokens ?? contextWindowTokens(provider, model)
  const percent = Math.min(100, Math.round((usedTokens / windowTokens) * 100))
  return {
    usedTokens,
    windowTokens,
    percent,
    nearSaturation: percent >= 80,
  }
}

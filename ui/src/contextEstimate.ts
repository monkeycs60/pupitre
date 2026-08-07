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

/** Approximation usuelle : 4 caractères par token, toutes langues confondues. */
const CHARS_PER_TOKEN = 4

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

/**
 * Décompose le contexte occupé. Seul le total vient du provider : le détail est
 * reconstitué depuis les événements stockés, et le reliquat regroupe ce que le
 * CLI ne publie pas (prompt système, définitions d'outils MCP, mémoire projet).
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

export function contextParts(
  events: AppEvent[],
  usedTokens: number,
  windowTokens = 0,
  /** Coût du bridge conductor, mesuré par le sidecar ; 0 si non orchestrée. */
  conductorTokens = 0,
): ContextPart[] {
  let user = 0
  let assistant = 0
  let tools = 0
  let turns = 0

  for (const event of events) {
    if (event.type === 'user-message') {
      user += approximateTokens(event.text)
      turns += 1
    } else if (event.type === 'text-final' || event.type === 'text-delta') {
      assistant += approximateTokens(event.text)
    } else if (event.type === 'tool-end') {
      tools += approximateTokens(event.output)
    } else if (event.type === 'tool-start') {
      tools += approximateTokens(JSON.stringify(event.input ?? ''))
    }
  }

  const pupitre = turns * PUPITRE_PREAMBLE_TOKENS
  const measured = user + assistant + tools + pupitre + conductorTokens
  // Ce que Pupitre injecte lui-même est isolé : c'est la seule part de la
  // charge fixe sur laquelle l'application a la main.
  const fixedPupitre = pupitre + conductorTokens
  const fixedInferred = usedTokens > measured ? usedTokens - measured : 0
  const parts: ContextPart[] = [
    {
      label: 'Système, MCP, mémoire',
      tokens: fixedInferred,
      group: 'fixe',
      detail: 'prompt système du CLI, serveurs MCP, CLAUDE.md, mémoire projet',
      persistent: true,
      inferred: true,
    },
    {
      label: 'Consignes Pupitre',
      tokens: fixedPupitre,
      group: 'fixe',
      detail: 'format de réponse, et bridge de délégation si la conversation orchestre',
      persistent: true,
    },
    { label: 'Vos messages', tokens: user, group: 'conversation' },
    { label: 'Réponses de l’agent', tokens: assistant, group: 'conversation' },
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

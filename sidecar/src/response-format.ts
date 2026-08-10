/**
 * Les cases à cocher du chat ne peuvent exister que si la réponse contient un
 * bloc d'actions. Plutôt que de dépendre des instructions personnelles de
 * l'utilisateur (ce qui rendait la fonctionnalité invisible pour tout le
 * monde), Pupitre demande lui-même le format et reconnaît plusieurs intitulés.
 */

export interface ActionFormat {
  /** Injecte la consigne de format dans chaque tour. */
  enabled: boolean;
  /** Intitulés reconnus pour le bloc d'actions à faire. */
  todoHeadings: string[];
  /** Intitulés reconnus pour le bloc de propositions. */
  followUpHeadings: string[];
}

export const DEFAULT_ACTION_FORMAT: ActionFormat = {
  enabled: true,
  todoHeadings: ["TODO", "DO THIS", "NEXT STEPS", "PROCHAINES ÉTAPES", "À FAIRE"],
  followUpHeadings: ["FOLLOW-UP", "FOLLOW UP", "PISTES", "POUR ALLER PLUS LOIN"],
};

const MAX_HEADINGS = 12;
const MAX_HEADING_LENGTH = 40;

function headings(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toUpperCase())
    .filter((item) => item.length > 0 && item.length <= MAX_HEADING_LENGTH);
  // Une liste vide désactiverait silencieusement la détection : on retombe
  // sur les intitulés par défaut plutôt que de casser la fonctionnalité.
  return cleaned.length > 0 ? [...new Set(cleaned)].slice(0, MAX_HEADINGS) : fallback;
}

/** Normalise ce qui vient de la base ou du client, jamais de valeur partielle. */
export function actionFormat(raw: unknown): ActionFormat {
  const value = (raw ?? {}) as Partial<ActionFormat>;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_ACTION_FORMAT.enabled,
    todoHeadings: headings(value.todoHeadings, DEFAULT_ACTION_FORMAT.todoHeadings),
    followUpHeadings: headings(
      value.followUpHeadings,
      DEFAULT_ACTION_FORMAT.followUpHeadings,
    ),
  };
}

/**
 * Consigne ajoutée en tête du tour. Volontairement courte : elle est répétée à
 * chaque message, et le CLI garde l'historique complet de la conversation.
 */
export function actionFormatPreamble(format: ActionFormat): string {
  const todo = format.todoHeadings[0] ?? "TODO";
  const followUp = format.followUpHeadings[0] ?? "FOLLOW-UP";
  return [
    "[Format de réponse — Pupitre]",
    `Termine par un bloc *${todo}* : les actions concrètes attendues de l'utilisateur,`,
    "numérotées, par ordre de priorité, avec les options explicites quand il y a une",
    "décision à prendre. Omets ce bloc s'il n'y a rien à faire de son côté.",
    `Ajoute quand c'est pertinent un bloc *${followUp}* : tes propres propositions pour`,
    "aller plus loin, en liste à puces.",
    "Ces deux blocs deviennent des cases à cocher dans l'interface : une action par",
    "ligne, à l'impératif, compréhensible seule et sans renvoi à une autre ligne.",
    "Pour présenter un audit, un brainstorming, un plan ou une approche structurée qui",
    "deviendrait longue en Markdown, préfère créer un document HTML autonome et éphémère",
    "dans /tmp, puis fournis son lien. Garde le Markdown pour une réponse courte.",
  ].join("\n");
}

/** Préfixe la demande utilisateur ; renvoie le prompt tel quel si désactivé. */
export function withActionFormat(prompt: string, format: ActionFormat): string {
  if (!format.enabled) return prompt;
  return `${actionFormatPreamble(format)}\n\n${prompt}`;
}

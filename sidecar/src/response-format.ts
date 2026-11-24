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
  /** Bloc ```commit d'une tâche : carte stylisée dans le fil, ou masqué. */
  commitBlock: CommitBlockDisplay;
  /** Rappelle à chaque tour une longueur cible pour le corps de la réponse. */
  lengthReminder: boolean;
  /** Mots visés pour le corps de la réponse, hors blocs d'actions, tableaux et code. */
  lengthTargetWords: number;
}

export type CommitBlockDisplay = "styled" | "hidden";
export const COMMIT_BLOCK_DISPLAYS: CommitBlockDisplay[] = ["styled", "hidden"];

export const DEFAULT_ACTION_FORMAT: ActionFormat = {
  enabled: true,
  todoHeadings: ["TODO", "DO THIS", "NEXT STEPS", "PROCHAINES ÉTAPES", "À FAIRE"],
  followUpHeadings: ["FOLLOW-UP", "FOLLOW UP", "PISTES", "POUR ALLER PLUS LOIN"],
  commitBlock: "styled",
  lengthReminder: false,
  lengthTargetWords: 120,
};

export const LENGTH_TARGET_MIN = 40;
export const LENGTH_TARGET_MAX = 600;

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

function lengthTarget(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ACTION_FORMAT.lengthTargetWords;
  }
  return Math.min(LENGTH_TARGET_MAX, Math.max(LENGTH_TARGET_MIN, Math.round(value)));
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
    commitBlock: COMMIT_BLOCK_DISPLAYS.includes(value.commitBlock as CommitBlockDisplay)
      ? value.commitBlock as CommitBlockDisplay
      : DEFAULT_ACTION_FORMAT.commitBlock,
    lengthReminder: typeof value.lengthReminder === "boolean"
      ? value.lengthReminder
      : DEFAULT_ACTION_FORMAT.lengthReminder,
    lengthTargetWords: lengthTarget(value.lengthTargetWords),
  };
}

const PREAMBLE_TITLE = "[Format de réponse — Pupitre]";

function actionLines(format: ActionFormat): string[] {
  const todo = format.todoHeadings[0] ?? "TODO";
  const followUp = format.followUpHeadings[0] ?? "FOLLOW-UP";
  return [
    `Termine par un bloc *${todo}* : seulement les actions qui reviennent à l'utilisateur,`,
    "numérotées par priorité. Omets ce bloc s'il n'y a rien à faire de son côté.",
    "Tranche toi-même ce qui est réversible et dans le périmètre ; ne remonte que les",
    "décisions qui lui appartiennent (irréversible, externe, goût produit, périmètre),",
    "trois au plus. Chacune s'écrit : la question, « : », puis les options séparées par",
    "« OU », la recommandée en premier avec ★, chacune notée sur 10 selon ta confiance",
    "(« Quel correctif : ★ patch minimal 8/10 OU refonte du module 4/10 »).",
    `Ajoute quand c'est pertinent un bloc *${followUp}* : trois propositions au plus pour`,
    "aller plus loin, en liste à puces, la plus rentable en premier et marquée ★.",
    "Une piste cochée par l'utilisateur est à réaliser, pas à analyser.",
    "Ces deux blocs deviennent des cases à cocher dans l'interface : une action par",
    "ligne, à l'impératif, compréhensible seule et sans renvoi à une autre ligne.",
    "Dans ces blocs, n'emploie ni je, ni tu, ni moi, ni toi, ni mon, ni ton : nomme",
    "l'acteur (« l'agent » ou le prénom de l'utilisateur) pour que chaque ligne reste",
    "claire hors contexte, y compris dans les options (« ★ l'agent publie 7/10 OU Clément relit d'abord 6/10 »).",
    "Pour présenter un audit, un brainstorming, un plan ou une approche structurée qui",
    "deviendrait longue en Markdown, préfère créer un document HTML autonome et éphémère",
    "dans /tmp, puis publie-le avec l’outil Pupitre `publish_document` afin qu’il soit",
    "affiché inline et recensé parmi les pièces jointes. Publie de la même façon tout",
    "fichier livré (PDF, CSV, XLSX, DOCX, Markdown, texte ou JSON). Un simple lien local ne constitue pas une livraison.",
    "Garde le Markdown pour une réponse courte.",
    "Cite un fichier par son chemin depuis la racine de son dépôt (`lib/auth.js:132`),",
    "jamais par son nom seul : Pupitre en fait un lien qui l'ouvre dans VS Code.",
  ];
}

function lengthLines(format: ActionFormat): string[] {
  const target = format.lengthTargetWords;
  const outside = format.enabled
    ? `hors blocs *${format.todoHeadings[0] ?? "TODO"}* et *${format.followUpHeadings[0] ?? "FOLLOW-UP"}*, tableaux et code`
    : "hors tableaux et code";
  return [
    `Longueur : le corps de la réponse, ${outside}, vise ${target} mots.`,
    `Il dépasse ${target * 2} mots seulement si l'utilisateur demande une explication ou un texte long.`,
    "La longueur suit le nombre de décisions, pas la quantité de travail : pour raccourcir,",
    "coupe le compte rendu, jamais une décision ni un risque.",
  ];
}

/**
 * Consigne ajoutée en tête de chaque tour, alors que le CLI garde déjà tout
 * l'historique : elle doit rester courte. Elle ne contient aucune ligne vide,
 * car la première ligne vide la sépare de la demande de l'utilisateur.
 */
export function actionFormatPreamble(format: ActionFormat): string {
  return [
    PREAMBLE_TITLE,
    ...(format.enabled ? actionLines(format) : []),
    ...(format.lengthReminder ? lengthLines(format) : []),
  ].join("\n");
}

/** Préfixe la demande utilisateur ; renvoie le prompt tel quel si désactivé. */
export function withActionFormat(prompt: string, format: ActionFormat): string {
  if (!format.enabled && !format.lengthReminder) return prompt;
  return `${actionFormatPreamble(format)}\n\n${prompt}`;
}

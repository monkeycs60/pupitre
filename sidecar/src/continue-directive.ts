import type { Conversation } from "./stores/conversations";

export const CONTINUE_DIRECTIVE = "@continue";

export function continueBriefPreamble(instruction: string): string {
  return [
    "[Passation — @continue]",
    "L'utilisateur poursuit ce travail dans une nouvelle conversation, au contexte frais.",
    "Ta réponse finale de ce tour lui sera transmise telle quelle comme brief de départ ;",
    "rédige-la pour un agent qui n'a rien vu de cette conversation :",
    "- l'objectif et l'état réel : ce qui est fait, vérifié, commité ou poussé ;",
    "- les décisions prises et leur raison, les pièges rencontrés ;",
    "- les repères concrets : dépôts, branches, fichiers, commits, commandes utiles ;",
    "- ce qui reste à faire, précis et ordonné.",
    `Sa demande pour la suite : « ${instruction} »`,
    "Prépare dans le brief ce que cette demande réclame (bilan, liste, priorités), mais n'exécute",
    "rien d'autre : la nouvelle conversation s'en chargera. Ce tour n'a pas de bloc TODO ni",
    "FOLLOW-UP, pas de document publié : le brief tient dans ta réponse.",
  ].join("\n");
}

export function continuationMessage(
  source: Pick<Conversation, "id" | "title">,
  brief: string,
  instruction: string,
): string {
  return [
    `Suite de la conversation Pupitre « ${source.title} » (id : ${source.id}).`,
    "Son agent a rédigé le brief ci-dessous pour toi. Il suffit pour démarrer : ne relis la",
    `conversation avec l’outil Pupitre \`read_conversation\` (conversation : "${source.id}") que si un détail manque.`,
    "",
    "[Brief de passation]",
    brief.trim(),
    "",
    "[Demande de l'utilisateur]",
    instruction,
  ].join("\n");
}

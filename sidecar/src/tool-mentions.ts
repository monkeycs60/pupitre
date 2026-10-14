import type { Provider } from "./events";

const BROWSER_MENTION = /(^|\s)@browser(?=$|[\s.,;:!?])/iu;
const CODE_MENTION = /(^|\s)@code(?=$|[\s.,;:!?])/iu;

export function withToolMentions(prompt: string, _provider: Provider): string {
  const instructions: string[] = [prompt];
  if (BROWSER_MENTION.test(prompt)) {
    instructions.push("[Outil demandé — @browser]\nUtilise le skill agent-browser (commande `ab`) pour les interactions avec le navigateur.");
  }
  if (CODE_MENTION.test(prompt)) {
    instructions.push("[Explication de code — @code]\nExplique le code ou les changements demandés en citant les vrais fichiers du workspace. "
      + "Utilise l’outil Pupitre `publish_code` pour chaque passage pertinent : path, start_line, end_line, title et explanation sont requis. "
      + "L’explication doit préciser le rôle du passage et son lien avec la demande ou les changements, pas simplement paraphraser les lignes. "
      + "Tu peux fournir highlights (plages start_line/end_line inclusives) pour souligner les lignes clés dans le passage. "
      + "Pupitre lit et conserve le fichier complet, ouvre le lecteur sur le passage cité et permet de défiler avant et après. "
      + "Publie plusieurs artefacts successifs si plusieurs passages sont nécessaires. Ne remplace pas ces artefacts par de simples liens ou des blocs Markdown. "
      + "Relis les fichiers et vérifie les numéros de ligne après tes modifications avant de publier. N’expose pas de fichiers contenant des secrets ; cite le code qui les charge.");
  }
  return instructions.join("\n\n");
}

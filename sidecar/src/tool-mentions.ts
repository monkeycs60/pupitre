import type { Provider } from "./events";

const BROWSER_MENTION = /(^|\s)@browser(?=$|[\s.,;:!?])/iu;

export function withToolMentions(prompt: string, _provider: Provider): string {
  if (!BROWSER_MENTION.test(prompt)) return prompt;

  const instruction = "Utilise le skill agent-browser (commande `ab`) pour les interactions avec le navigateur.";
  return `${prompt}\n\n[Outil demandé — @browser]\n${instruction}`;
}

import type { Provider } from "./events";

const CHROME_MENTION = /(^|\s)@chrome(?=$|[\s.,;:!?])/iu;

export function withToolMentions(prompt: string, provider: Provider): string {
  if (!CHROME_MENTION.test(prompt)) return prompt;

  const instruction = provider === "codex"
    ? "Utilise le plugin Chrome de Codex pour les interactions avec le navigateur."
    : provider === "claude"
      ? "Utilise Claude in Chrome pour les interactions avec le navigateur."
      : "L'intégration Chrome n'est pas disponible avec ce fournisseur.";

  return `${prompt}\n\n[Outil demandé — @chrome]\n${instruction}`;
}

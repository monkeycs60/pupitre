/** Dollars par million de jetons, relevés le 26/11/2026 sur les pages tarifs de Cerebras, TypeSafe et OpenAI. */
const PRICES = {
  "qwen-3.8-27b": { label: "Qwen 3.8 · réponse", input: 0.99, output: 1.49 },
  "gpt-oss-120b": { label: "Recherche · classement par gpt-oss-120b", input: 0.35, output: 0.75 },
  "jev-latest": { label: "Jev · tri de la demande", input: 0.042, output: 0 },
  "text-embedding-3-small": { label: "Recherche · vecteur de la question", input: 0.02, output: 0 },
} as const;

export type PricedModel = keyof typeof PRICES;

export interface ApiUsage {
  model: PricedModel;
  inputTokens: number;
  outputTokens: number;
}

export interface JarvisCost {
  label: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** `subscription` : équivalent API annoncé par le CLI Claude, que l'abonnement couvre. */
  billing: "api" | "subscription";
}

export function apiCost(usage: ApiUsage): JarvisCost {
  const price = PRICES[usage.model];
  return {
    label: price.label,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    usd: (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000,
    billing: "api",
  };
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function openAiUsage(model: PricedModel, body: unknown): ApiUsage | null {
  const usage = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  if (!usage) return null;
  return { model, inputTokens: tokens(usage.prompt_tokens), outputTokens: tokens(usage.completion_tokens) };
}

export function typesafeUsage(model: PricedModel, body: unknown): ApiUsage | null {
  const usage = (body as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage;
  if (!usage) return null;
  return { model, inputTokens: tokens(usage.input_tokens), outputTokens: tokens(usage.output_tokens) };
}

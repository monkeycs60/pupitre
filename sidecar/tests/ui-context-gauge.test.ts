import { expect, test } from "bun:test";
import {
  contextEstimate,
  contextWindowTokens,
} from "../../ui/src/contextEstimate";

test("utilise le dernier snapshot de contexte sans sommer les coûts", () => {
  expect(contextWindowTokens("claude", "sonnet")).toBe(200_000);
  expect(contextWindowTokens("codex", "gpt-5.6-sol")).toBe(400_000);
  expect(contextEstimate([
    { type: "usage", inputTokens: 100_000, outputTokens: 20_000, contextTokens: 120_000, contextWindowTokens: 258_400 },
    { type: "usage", inputTokens: 180_000, outputTokens: 20_000, contextTokens: 190_000, contextWindowTokens: 258_400 },
  ], "codex", "gpt-5.6-sol")).toEqual({
    usedTokens: 190_000,
    windowTokens: 258_400,
    percent: 74,
    nearSaturation: false,
  });
});

test("borne visuellement une estimation qui dépasse la fenêtre", () => {
  expect(contextEstimate([
    { type: "usage", inputTokens: 250_000, outputTokens: 10_000, contextTokens: 260_000, contextWindowTokens: 200_000 },
  ], "claude", "modele-inconnu").percent).toBe(100);
});

test("le fallback conserve seulement le dernier usage si le provider n'offre pas de snapshot", () => {
  expect(contextEstimate([
    { type: "usage", inputTokens: 100, outputTokens: 20 },
    { type: "usage", inputTokens: 80, outputTokens: 10 },
  ], "claude", "sonnet").usedTokens).toBe(90);
});

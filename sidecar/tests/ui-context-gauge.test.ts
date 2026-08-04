import { expect, test } from "bun:test";
import {
  contextEstimate,
  contextWindowTokens,
} from "../../ui/src/contextEstimate";

test("estime le contexte par la somme des usages connus et la fenêtre du modèle", () => {
  expect(contextWindowTokens("claude", "sonnet")).toBe(200_000);
  expect(contextWindowTokens("codex", "gpt-5.6-sol")).toBe(400_000);
  expect(contextEstimate([
    { type: "usage", inputTokens: 100_000, outputTokens: 20_000 },
    { type: "usage", inputTokens: 180_000, outputTokens: 20_000 },
  ], "codex", "gpt-5.6-sol")).toEqual({
    usedTokens: 320_000,
    windowTokens: 400_000,
    percent: 80,
    nearSaturation: true,
  });
});

test("borne visuellement une estimation qui dépasse la fenêtre", () => {
  expect(contextEstimate([
    { type: "usage", inputTokens: 250_000, outputTokens: 10_000 },
  ], "claude", "modele-inconnu").percent).toBe(100);
});

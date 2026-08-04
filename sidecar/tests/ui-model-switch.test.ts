import { expect, test } from "bun:test";
import { estimatedReingestionTokens } from "../../ui/src/modelSwitch";

test("estime la ré-ingestion en sommant les événements usage", () => {
  expect(estimatedReingestionTokens([
    { type: "user-message", text: "x", images: [] },
    { type: "usage", inputTokens: 120, outputTokens: 30 },
    { type: "usage", inputTokens: 80, outputTokens: 20 },
  ])).toBe(250);
});

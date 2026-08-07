import { expect, test } from "bun:test";
import {
  PERSISTENT_ALERT_RATIO,
  contextParts,
  persistentRatio,
} from "../../ui/src/contextEstimate";
import { formatCompact } from "../../ui/src/formatCompact";

const events = [
  { type: "user-message" as const, text: "a".repeat(400), images: [] },
  { type: "text-final" as const, text: "b".repeat(800) },
  { type: "tool-end" as const, toolId: "t1", output: "c".repeat(1_200), images: [] },
];

test("regroupe le contexte en charge fixe, conversation et outils", () => {
  const parts = contextParts(events, 10_000);
  expect(parts.map((part) => [part.label, part.group])).toEqual([
    ["Système, MCP, mémoire", "fixe"],
    ["Consignes Pupitre", "fixe"],
    ["Vos messages", "conversation"],
    ["Réponses de l’agent", "conversation"],
    ["Fichiers lus et commandes", "outils"],
  ]);
});

test("la charge fixe absorbe le reliquat du total provider", () => {
  const parts = contextParts(events, 10_000);
  expect(parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(10_000);
  // Ce que le CLI ne publie pas, une fois retirées les parts mesurées.
  expect(parts[0]).toMatchObject({
    label: "Système, MCP, mémoire",
    tokens: 10_000 - (100 + 200 + 300 + 95),
  });
});

test("sans total provider crédible, seule la part Pupitre subsiste", () => {
  const parts = contextParts(events, 0);
  expect(parts.find((part) => part.inferred)).toBeUndefined();
  expect(parts.find((part) => part.label === "Consignes Pupitre")?.tokens).toBe(95);
});

test("une conversation vide ne produit aucune ligne", () => {
  expect(contextParts([], 0)).toEqual([]);
});

test("la place libre ferme l'anneau sur la fenêtre entière", () => {
  const parts = contextParts(events, 10_000, 1_000_000);
  const free = parts.at(-1);
  expect(free).toMatchObject({ label: "Disponible", free: true, tokens: 990_000 });
  expect(parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(1_000_000);
});

test("une fenêtre déjà pleine n'ajoute pas de part disponible", () => {
  expect(contextParts(events, 10_000, 10_000).some((part) => part.free)).toBe(false);
});

test("la charge fixe distingue ce que Pupitre injecte du reste", () => {
  const persistent = contextParts(events, 10_000, 1_000_000)
    .filter((part) => part.persistent)
    .map((part) => part.label);
  expect(persistent).toEqual(["Système, MCP, mémoire", "Consignes Pupitre"]);
});

test("les grands nombres s'abrègent en millions", () => {
  expect(formatCompact(1_000_000)).toBe("1 M");
  expect(formatCompact(1_234_567)).toBe("1,23 M");
  expect(formatCompact(12_340)).toBe("12,3 k");
  expect(formatCompact(842)).toBe("842");
});

test("le bridge conductor bascule du déduit vers les consignes Pupitre", () => {
  const withBridge = contextParts(events, 10_000, 1_000_000, 1_200);
  const without = contextParts(events, 10_000, 1_000_000, 0);
  const part = (parts: typeof withBridge, label: string) =>
    parts.find((item) => item.label === label)!.tokens;
  expect(part(withBridge, "Consignes Pupitre") - part(without, "Consignes Pupitre")).toBe(1_200);
  expect(part(without, "Système, MCP, mémoire") - part(withBridge, "Système, MCP, mémoire"))
    .toBe(1_200);
  expect(withBridge.reduce((sum, item) => sum + item.tokens, 0)).toBe(1_000_000);
});

test("le ratio incompressible se rapporte à la fenêtre entière", () => {
  const parts = contextParts(events, 10_000, 20_000);
  // Déduit (9 305) + consignes Pupitre (95) = 9 400, sur une fenêtre de 20 000.
  expect(persistentRatio(parts, 20_000)).toBeCloseTo(0.47, 2);
  expect(persistentRatio(parts, 0)).toBe(0);
});

test("le seuil d'alerte reste sous la moitié de la fenêtre", () => {
  expect(PERSISTENT_ALERT_RATIO).toBeGreaterThan(0);
  expect(PERSISTENT_ALERT_RATIO).toBeLessThan(0.5);
});
